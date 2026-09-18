# cntr - Agente n8n: Programação + Container/Flex Tanque no WhatsApp

Workflow para [n8n](https://n8n.io) que fica "dentro" de um grupo de WhatsApp e:

1. Quando alguém manda uma **foto da planilha de programação** (print/foto da tabela com
   Booking, QTD CNTR, Planta, Armador, datas, OBS), lê a tabela inteira e cria/atualiza os
   bookings em um banco Postgres.
2. Quando alguém manda as **fotos de uma montagem** (etiqueta, porta, interna vazia, interna
   com flex, trava — 5 fotos), extrai o número do container e o identificador do flex tanque,
   descobre automaticamente a qual booking da programação aquela montagem pertence (cruzando o
   armador lido na foto da porta com os bookings em aberto), publica o resultado no grupo
   marcando os responsáveis, atualiza a quantidade montada daquele booking, e envia as fotos por
   e-mail.
3. Se não conseguir decidir sozinho a qual booking a montagem pertence (mais de um candidato em
   aberto do mesmo armador), **pergunta no grupo** e espera alguém responder com o número do
   booking antes de fechar a operação.
4. Ao fechar cada operação, além do e-mail e da mensagem no grupo, também manda um **PDF** —
   página de resumo (container, flex tanque, booking, planta, armador, progresso, obs, data/hora)
   seguida de **uma página por foto** (a foto em si, com legenda) — como documento por WhatsApp
   para uma lista de números configurável (`pdfRecipients`), separada da lista de responsáveis
   marcados no grupo.

## ⚠️ Decisões assumidas — leia antes de usar

Este projeto foi construído sem confirmação final em algumas perguntas de negócio (as respostas
não chegaram durante o desenvolvimento). Ficaram estas suposições — **revise e me avise o que
precisa mudar**:

| Ponto | O que foi assumido |
|---|---|
| Número "oficial" do flex tanque | O código impresso perto do QR/código de barras (ex: `DWH2604055A-626DT0998`), que pode ter outros prefixos além de "DWH". O **Lot No** (ex: `A4/20260425/A`) é reportado junto, como informação extra, não como o número principal. |
| Quantidade de fotos por operação | 5: **etiqueta**, **porta**, **interna vazia**, **interna com flex montado**, **trava/anteparo**. |
| Como casar a montagem com o booking | Lê o armador (texto/logo) na foto da porta e cruza com os bookings **em aberto** daquele armador no mesmo grupo. 1 candidato → segue automático. 0 candidatos → segue sem booking, avisando "NÃO LOCALIZADO". 2+ candidatos → pergunta no grupo e espera resposta com o número do booking. |
| Confirmação antes de publicar | **Não** espera um "confirma"/"sim" explícito — assim que o booking é decidido (automático ou por resposta no grupo), já publica o resultado e manda o e-mail. |
| Contagem de progresso | +1 na quantidade montada a cada operação concluída para aquele booking, com aviso do tipo "Booking 274202662: 3 de 10 montados" na mesma mensagem do grupo. |
| PDF por WhatsApp | Além do e-mail, um PDF é enviado como documento para os números em `pdfRecipients.numbers` — uma lista separada da lista de responsáveis marcados no grupo. O PDF tem uma página de resumo (números, booking, progresso) seguida de uma página por foto (a foto em si, com legenda da categoria). Se você quiser que sejam os mesmos números da lista de responsáveis, é só repetir os telefones nas duas listas. |

Se qualquer uma dessas suposições estiver errada, é só pedir o ajuste — a lógica de cada uma
está isolada em nodes/queries específicas, fácil de alterar.

## Arquitetura

```
WhatsApp (grupo) ⇄ Evolution API (gateway Baileys) ⇄ n8n (workflow) ⇄ Postgres
                                                            ⇄ Claude Vision (Anthropic API)
                                                            ⇄ SMTP (e-mail)
```

- **Evolution API**: gateway open-source (usa Baileys por baixo) que fica de fato conectado ao
  WhatsApp. O n8n não fala WhatsApp diretamente — não existe API oficial da Meta que funcione
  dentro de grupos comuns.
- **n8n**: um único workflow (`workflows/agente-cta.json`) com dois gatilhos:
  - Webhook (recebe eventos da Evolution API: fotos e mensagens de texto no grupo)
  - Agendamento (varre a cada X minutos os lotes de fotos "parados" — quando a pessoa envia
    menos que o esperado ou demora entre uma foto e outra)
- **Postgres**: guarda a programação (`bookings`) e os lotes de fotos em andamento
  (`photo_batches`, `batch_photos`) — necessário porque cada execução do n8n é independente e
  não guarda estado em memória entre uma foto e outra.
- **Claude Vision (Anthropic API)**: classifica cada imagem recebida (é a planilha de
  programação, ou é uma foto de operação — e qual das 5 categorias) e lê os textos/números
  visíveis (container, armador, código do flex, Lot No).
- **SMTP**: envio do e-mail com as 5 fotos anexadas.

## Como o workflow foi construído

O arquivo `workflows/agente-cta.json` é **gerado**, não editado à mão:

```bash
cp tools/config.example.json tools/config.json   # edite com seus dados
node tools/generate-workflows.mjs                # gera workflows/agente-cta.json
node tools/validate-workflow.mjs                 # confere a integridade do JSON gerado
```

Editar a config e regenerar é o jeito de mudar: IDs de grupo permitidos, URL/instância da
Evolution API, quantidade esperada de fotos, janela de espera do lote, modelo da Anthropic,
remetente/destinatários de e-mail e a lista de responsáveis a marcar no grupo. Depois de
regenerar, reimporte o workflow no n8n (ou copie/cole o JSON por cima do workflow existente).

O gerador foi deliberadamente escrito para usar só 6 tipos de node do n8n (Webhook, Schedule
Trigger, Code, HTTP Request, Postgres, Send Email) — todos com o formato de parâmetros mais
estável e menos sujeito a mudança entre versões do n8n. Toda a lógica de negócio (validação do
número do container, casamento de booking, montagem de mensagens) fica em nodes **Code**
(JavaScript puro), não em nodes de UI complexos — mais fácil de auditar e ajustar.

Duas validações automáticas rodam sobre o JSON gerado (`tools/validate-workflow.mjs`):
checagem de que toda conexão aponta para um node existente, que todo Code node tem JavaScript
sintaticamente válido, e que toda expressão `{{ }}` (inclusive dentro dos nodes HTTP Request e
Postgres) também é JS válido. Isso pega uma classe grande de erros, mas **não substitui testar
de verdade dentro do n8n** — depois de importar, rode o fluxo com um grupo de teste antes de
usar em produção (veja "Pontos para conferir depois de importar" abaixo).

## Pré-requisitos

- Uma instância do **n8n** (self-hosted; Docker é o mais comum)
- Uma instância da **Evolution API** já rodando e pareada com um número de WhatsApp dedicado ao
  agente (adicione esse número ao grupo)
- Um banco **Postgres** acessível pelo n8n
- Uma chave de API da **Anthropic** (Claude Vision)
- Um servidor **SMTP** para o e-mail

## Passo a passo

### 1. Banco de dados

```bash
psql "$DATABASE_URL" -f sql/schema.sql
```

Cria as tabelas `bookings`, `photo_batches` e `batch_photos` (comentadas no próprio arquivo).

### 2. Evolution API

- Crie/pareie uma instância dedicada ao agente (escaneando o QR code da Evolution API com o
  WhatsApp que vai ficar no grupo).
- Configure o **webhook** dessa instância apontando para a URL pública do webhook do n8n (você
  pega essa URL depois de importar o workflow — é a URL do node "Webhook Evolution").
- Habilite o evento `MESSAGES_UPSERT` (nome pode variar conforme a versão da sua Evolution API).
- Adicione o número da instância ao grupo do WhatsApp.

### 3. Configurar e gerar o workflow

```bash
cp tools/config.example.json tools/config.json
```

Edite `tools/config.json`:
- `evolution.baseUrl` / `evolution.instance`: URL e nome da sua instância da Evolution API.
- `whatsapp.allowedGroupIds`: deixe vazio (`[]`) na primeira rodada para descobrir o ID do
  grupo (veja abaixo), depois preencha e regenere.
- `batch.expectedPhotos`: 5 por padrão.
- `email.*`: remetente/destinatários do relatório.
- `responsibles`: nome + telefone (DDI+DDD+número, só dígitos) de quem deve ser marcado no
  grupo.
- `pdfRecipients.numbers`: telefones (DDI+DDD+número, só dígitos) que recebem o PDF-resumo de
  cada operação como documento no WhatsApp. Pode ser `[]` para não enviar PDF nenhum, ou repetir
  os mesmos números de `responsibles` se for o caso.

```bash
node tools/generate-workflows.mjs
node tools/validate-workflow.mjs
```

### 4. Importar no n8n

- No n8n: **Import from File** → selecione `workflows/agente-cta.json`.
- Configure:
  - **Postgres CTA** (credencial tipo *Postgres*): dados de conexão do banco do passo 1. Nos
    nodes de banco de dados, selecione essa credencial.
  - **SMTP CTA** (credencial tipo *SMTP*): dados do seu servidor de e-mail. No node de e-mail,
    selecione essa credencial.
  - **Evolution API e Anthropic**: de propósito, esses NÃO usam credencial compartilhada do
    n8n (algumas instalações self-hosted "perdem" a referência da credencial quando um node é
    duplicado ou o workflow é reimportado, o que já causou bastante dor de cabeça). A chave vai
    direto como header manual em cada node HTTP. Em cada um dos nodes abaixo, abra a aba
    **Headers** e edite o valor do header indicado:
    - `Buscar midia base64`, `Vision - Classificar imagem` (esse também tem `x-api-key`),
      `Responder confirmacao da programacao`, `Responder pedido de escolha no grupo`,
      `Enviar PDF por WhatsApp`, `Responder no grupo` → header **`apikey`**: cole a API key da
      sua Evolution API (valor de exemplo no JSON gerado: `COLE-AQUI-A-APIKEY-DA-EVOLUTION-API`).
    - `Vision - Classificar imagem` → header **`x-api-key`**: cole sua chave da Anthropic
      (`sk-ant-...`; valor de exemplo: `COLE-AQUI-A-CHAVE-DA-ANTHROPIC-sk-ant-...`).
- Ative o workflow.
- Copie a URL do node **Webhook Evolution** (Produção) e configure-a no webhook da Evolution
  API (passo 2).

### 5. Descobrir o ID do grupo

Com `allowedGroupIds: []` (vazio), qualquer mensagem de qualquer grupo passa pelo filtro. Envie
uma mensagem de teste no grupo desejado e olhe a execução no n8n (aba *Executions* →
clique na execução → veja o node "Normalizar mensagem"): o campo `groupId` é o ID do grupo
(formato `1203630...@g.us`). Copie para `tools/config.json` → `whatsapp.allowedGroupIds`, rode
`node tools/generate-workflows.mjs` de novo e reimporte.

### 6. Primeira programação

Mande a foto da planilha de programação no grupo. O agente deve responder confirmando quantos
bookings foram criados/atualizados. Confira na tabela `bookings` do Postgres se os dados batem.

### 7. Primeira montagem

Mande as 5 fotos da operação (em qualquer ordem, uma atrás da outra). Depois de alguns segundos
(ou no máximo `batch.windowSeconds`), o agente deve:
- Publicar no grupo o container, o flex tanque e o booking identificado (ou pedir para você
  escolher, se houver mais de um candidato).
- Mandar o e-mail com as 5 fotos anexadas.

## Pontos para conferir depois de importar

Como este workflow foi escrito à mão (não exportado de uma instância real do n8n), alguns
detalhes de parâmetros podem variar entre versões do n8n. Confira especialmente:

- **HTTP Request → Body**: os nodes que chamam a Evolution API e a Anthropic API usam
  `specifyBody: json` + `jsonBody`. Se ao abrir o node o corpo aparecer vazio, mude "Body
  Content Type" para JSON e confirme que o campo está preenchido (o texto esperado está no
  `notes` de alguns desses nodes).
- **Payload da Evolution API**: o formato exato do webhook (`data.key`, `data.message`, etc.) e
  dos endpoints `chat/getBase64FromMediaMessage` e `message/sendText` pode variar conforme a
  versão da sua Evolution API. Compare com a documentação Swagger da sua própria instância
  (rota `/docs`) e ajuste o node "Normalizar mensagem" e os dois nodes HTTP Request da Evolution
  se necessário.
- **Postgres → Query**: todos os nodes Postgres usam `operation: Execute Query` com a query
  inteira vindo de `{{ $json.sql }}` (montada por um node Code anterior, já com qualquer texto
  escapado). Não deveria precisar de "Query Parameters" nenhum — se o node pedir, é só deixar
  em branco.
- **Send Email → Attachments**: o campo usa a expressão
  `{{ Object.keys($binary || {}).join(',') }}` para anexar dinamicamente todas as fotos do
  lote. Confirme que aparecem as 5 fotos no e-mail de teste.
- **Enviar PDF por WhatsApp**: o endpoint (`message/sendMedia/{instance}`) e os nomes dos campos
  (`mediatype`, `media`, `fileName`) para enviar um documento variam mais entre versões da
  Evolution API do que o envio de texto. Confira no Swagger da sua instância e ajuste este node
  se o PDF não chegar. O PDF em si (gerado à mão dentro do node "Montar PDF do relatorio", sem
  nenhuma biblioteca externa — inclusive as imagens embutidas via DCTDecode) foi testado e
  validado localmente (extração de texto e re-decodificação das imagens byte a byte, conferindo
  dimensão e cor) antes de entrar no workflow — só o transporte até o WhatsApp depende da sua
  versão da Evolution API. Fotos que não sejam JPEG (raro vindo do WhatsApp) são listadas como
  "não incluídas" na página de resumo em vez de quebrar a geração do PDF.

## Estrutura do projeto

```
sql/schema.sql              Schema Postgres (bookings, photo_batches, batch_photos)
tools/config.example.json   Modelo de configuracao (copie para tools/config.json)
tools/generate-workflows.mjs  Gerador do workflow n8n a partir da config
tools/validate-workflow.mjs   Validador estrutural do JSON gerado
workflows/agente-cta.json   Workflow gerado, pronto para importar no n8n
```

## Limitações conhecidas

- Depende de uma Evolution API (ou gateway equivalente baseado em Baileys) rodando e mantida à
  parte — é software não-oficial, sujeito a quebrar com mudanças do WhatsApp.
- A leitura de números depende da qualidade da foto e da capacidade do Claude Vision de ler o
  texto/QR/código de barras; quando não é possível ler com confiança, o agente publica "NÃO
  IDENTIFICADO" em vez de arriscar um número errado.
- O casamento automático de booking depende de o armador estar legível na foto da porta e de
  haver no máximo um booking em aberto daquele armador no grupo; caso contrário, pede para
  escolher manualmente.
- Fotos são guardadas em base64 no Postgres até a operação fechar — volume baixo (5 fotos por
  operação) então não é um problema de espaço, mas não é um design pensado para alto volume.
