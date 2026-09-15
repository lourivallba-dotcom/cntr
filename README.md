# cntr — extração de nº do contêiner + flex tank para o grupo de WhatsApp

Serviço de visão computacional (FastAPI/Python) usado por um workflow do
**n8n** que roda dentro de um grupo de WhatsApp: recebe as 5 fotos de uma
operação (etiqueta do flex tank, porta do contêiner, parte interna), extrai o
número do contêiner e o número do flex tank/processo administrativo, pergunta
a reserva (booking) e o cliente da operação, consulta e baixa o flex tank na
base de estoque (Supabase), gera um PDF com os dados e as fotos e o envia por
e-mail e por WhatsApp (DM) para os contatos parametrizados.

Este repositório contém **só a parte de visão computacional** (o "cérebro" que
lê as fotos). A orquestração — receber mensagens do WhatsApp, mandar e-mail,
responder no grupo com @menção — fica no n8n, usando o workflow de exemplo em
[`n8n/whatsapp-container-flex-workflow.json`](n8n/whatsapp-container-flex-workflow.json).

## ⚠️ Importante: WhatsApp Cloud API não suporta grupos

A **WhatsApp Cloud API oficial da Meta não tem suporte a grupos** — ela só
permite conversas 1:1 (business ↔ cliente) ou listas de transmissão. Não é
possível ler mensagens de um grupo nem enviar mensagens marcando pessoas
(`@menção`) dentro de um grupo usando a API oficial.

Para o agente funcionar **dentro de um grupo**, como pedido, é necessário usar
um provedor não-oficial que suporte grupos, por exemplo:

- **[Evolution API](https://github.com/EvolutionAPI/evolution-api)** (open source, usa Baileys por trás, tem nó/community node e webhook fácil de integrar com n8n) — recomendado.
- **[WAHA – WhatsApp HTTP API](https://github.com/devlikeapro/waha)** (também open source, Docker-ready).
- Um bridge próprio em cima do [Baileys](https://github.com/WhiskeySockets/Baileys).

O workflow de exemplo já assume esse tipo de provedor (webhook + endpoint de
envio de mensagem com suporte a `mentioned`/menção). Se mais tarde vocês
decidirem usar a Cloud API oficial, o "grupo" precisaria virar uma lista de
números individuais (sem menção nativa), o que muda bastante a lógica.

## Como o pipeline funciona

```
grupo WhatsApp (5 fotos de 1 contêiner)
   -> n8n recebe cada foto via webhook
   -> n8n chama POST /batches/{chat_id}/images (uma chamada por foto)
   -> ao chegar a 5ª foto, o cntr-vision identifica:
        - número do contêiner (validado pelo dígito verificador ISO 6346)
        - número do flex tank / processo administrativo (QR > código de
          barras > OCR, nessa ordem de prioridade)
        - qual foto é a etiqueta, qual é a porta do contêiner, e as demais

   -> bot pergunta no grupo a reserva (booking) e o cliente (OBRIGATÓRIO)
      — ou, se esse chat já tem um booking/cliente confirmado antes, pergunta
      se quer reaproveitar ("Deseja usar a mesma reserva e cliente?")
   -> pessoa responde em texto -> n8n chama POST /chats/{chat_id}/answer
      - resposta não reconhecida -> bot repete a pergunta (`retry_question`)
      - resposta OK -> segue para baixo:

   -> cntr-vision consulta o flex tank na base de estoque (Supabase); se
      encontrar, marca como baixado; se não encontrar, sinaliza que o número
      não consta na base
   -> gera o PDF do relatório (dados da operação + as 5 fotos, contêiner
      primeiro, depois a etiqueta, depois as internas — todas no mesmo
      padrão visual)
   -> grava a operação no Supabase (dashboard do cliente) com as fotos
   -> n8n envia o e-mail com o PDF anexado
   -> n8n responde no grupo com o resumo e manda uma DM pra cada contato
      telefônico parametrizado no node Config
```

Um lote incompleto (o grupo mandou só 3 fotos e parou) expira sozinho depois
de um tempo de inatividade configurável (`BATCH_TTL_SECONDS`, padrão 15 min),
para não misturar fotos de duas operações diferentes. Uma pergunta pendente
(booking/cliente, ou a confirmação de reaproveitar) expira do mesmo jeito
depois de `CONVERSATION_TTL_SECONDS` (padrão 30 min).

## A etiqueta nem sempre tem QR code

Conforme observado em campo: a etiqueta branca do flex tank às vezes vem com
QR code, às vezes só com código de barras, e às vezes sem nenhum dos dois —
só o número do processo administrativo impresso (hoje o formato mais comum
começa com `DWH`, mas já apareceram outros prefixos/formatos). Por isso a
extração segue esta ordem de prioridade:

1. **QR code** na foto da etiqueta (mais confiável).
2. **Código de barras** na foto da etiqueta.
3. **OCR** do texto da etiqueta, testando uma lista de padrões (regex)
   configurável em [`config/patterns.yaml`](config/patterns.yaml) — dá para
   adicionar um novo formato de processo administrativo só editando esse
   arquivo, sem mexer no código nem reimplantar o serviço (o container Docker
   já monta esse arquivo como volume).

Quando nada é encontrado com confiança, o serviço não inventa um número: ele
retorna `null` e um aviso em `warnings` (ex: `numero_do_flex_tank_nao_encontrado`)
para que alguém confira manualmente — o texto de aviso também entra na
mensagem do grupo e no corpo do e-mail.

## Como adicionar o robô no grupo

O "robô" não é adicionado ao grupo como um bot especial — ele entra **como um
número de WhatsApp normal**, do mesmo jeito que qualquer pessoa. Quem faz a
ponte entre esse número e o n8n é o **Evolution API**, já incluído no
`docker-compose.yml`.

1. **Use um número dedicado ao robô**, de preferência não o seu WhatsApp
   pessoal (pode ser um chip extra, um WhatsApp Business, ou um número virtual
   que aceite SMS/ligação para ativar o WhatsApp). Esse número vai ficar
   permanentemente logado como o robô.

2. Suba os serviços:
   ```bash
   cp .env.example .env   # edite a EVOLUTION_API_KEY e as senhas do Postgres
   docker compose up --build
   ```

3. Abra o **Manager** do Evolution API em `http://localhost:3000` e faça
   login com a `EVOLUTION_API_KEY` definida no `.env`.

4. Crie uma nova instância (ex: `grupo-operacoes`) e clique para **gerar o QR
   code**.

5. No celular do número dedicado ao robô: **WhatsApp → Configurações →
   Aparelhos conectados → Conectar um aparelho**, e escaneie o QR code exibido
   no Manager — é o mesmo mecanismo do WhatsApp Web/Desktop.

6. Depois de conectado, esse número aparece como "online" na instância. Agora
   é só **pedir para um administrador do grupo adicionar esse número como
   participante**, normalmente: no grupo → tocar no nome do grupo →
   Participantes → Adicionar participante → digitar o número do robô.

7. Descubra o **ID do grupo** (`group_id`, formato `xxxxxxxxxx-xxxxxxxxxx@g.us`
   ou `xxxxxxxxxxxxxxxxxxx@g.us`): assim que o robô estiver no grupo, mande
   qualquer mensagem de teste nele — o payload que chega no webhook do n8n
   (`Webhook - Mensagem WhatsApp` → aba "Executions") vai trazer esse ID no
   campo do remetente/chat. Copie esse valor.

8. No workflow do n8n, abra o node **Config** e cole esse ID em `group_id`.

9. No Manager do Evolution API, confirme que o **webhook da instância** está
   apontando para a URL pública do node "Webhook - Mensagem WhatsApp" do n8n
   (já vem pré-configurado via `N8N_WHATSAPP_WEBHOOK_URL` no `.env`, mas
   confira na aba de configurações da instância caso use um n8n hospedado
   fora do docker-compose, ex: n8n Cloud — nesse caso troque essa variável
   pela URL pública real do seu webhook).

A partir daí, qualquer foto enviada nesse grupo passa a ser processada pelo
workflow automaticamente.

> **Atenção:** conectar um número dessa forma (via Baileys/Evolution API) usa
> o mesmo protocolo do WhatsApp Web e não é o método "oficial" endossado pela
> Meta para uso comercial em massa — funciona bem para automação de um grupo
> operacional interno, mas números usados assim podem eventualmente ser
> banidos se enviarem muito volume de mensagens não solicitadas. Para esse
> caso de uso (grupo interno, poucas mensagens) o risco é baixo.

## Rodando localmente

```bash
cp .env.example .env
docker compose up --build
```

A API sobe em `http://localhost:8000` (documentação interativa em
`http://localhost:8000/docs`).

### Endpoints

- `POST /batches/{chat_id}/images` — envia 1 foto (form-data, campo `file`)
  para o lote do chat `chat_id`. Responde `{ count, ready, needs_answer?,
  extraction_preview?, previous_booking?, previous_cliente? }`. Esses últimos
  campos só vêm preenchidos quando o lote atinge `BATCH_SIZE` (padrão 5) —
  nesse momento o serviço já identificou o contêiner/flex tank mas ainda não
  gerou o PDF: falta a resposta de booking/cliente via `/chats/{chat_id}/answer`.
- `POST /chats/{chat_id}/answer` — body `{ "text": "..." }` com a resposta em
  texto livre do grupo. Responde `{ accepted, retry_question?, finalize? }`:
  - `accepted: false` → `retry_question` tem o que reenviar ao grupo (texto
    não reconhecido, ou o "não" da pergunta de reaproveitar booking/cliente).
  - `accepted: true` → `finalize` traz tudo pronto: número do contêiner, do
    flex tank, se foi encontrado/baixado no estoque, o PDF em base64
    (`pdf_base64`/`pdf_filename`) e as 5 fotos.
- `GET /batches/{chat_id}` — consulta quantas fotos já chegaram nesse lote.
- `POST /batches/{chat_id}/reset` — descarta o lote e a pergunta pendente em
  andamento (útil se o grupo mandou fotos erradas).
- `POST /process` — versão "sem estado": processa 1+ fotos enviadas de uma vez
  só (campo `files`), sem passar pelo fluxo de booking/cliente/Supabase — só
  a extração.
- `GET /health` — healthcheck.

## Rodando os testes

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
pytest
```

Os testes geram etiquetas/portas de contêiner sintéticas (QR code, código de
barras, texto) para validar o pipeline ponta a ponta sem depender de fotos
reais.

## Configuração

Variáveis de ambiente (ver `.env.example`):

| Variável | Padrão | Descrição |
|---|---|---|
| `BATCH_SIZE` | `5` | Quantas fotos formam um lote/operação completa |
| `BATCH_TTL_SECONDS` | `900` | Inatividade até um lote incompleto expirar |
| `CONVERSATION_TTL_SECONDS` | `1800` | Inatividade até uma pergunta pendente (booking/cliente) expirar |
| `STORE_BACKEND` | `memory` | `memory` (simples) ou `redis` (sobrevive a reinícios/múltiplos workers) |
| `REDIS_URL` | — | Necessário se `STORE_BACKEND=redis` |
| `OCR_LANG` | `por+eng` | Idiomas do Tesseract OCR |
| `SUPABASE_URL` / `SUPABASE_KEY` | — | Deixe em branco para rodar sem Supabase (extração e PDF continuam funcionando, só não consulta estoque nem grava o dashboard) |
| `SUPABASE_ESTOQUE_TABLES` / `SUPABASE_ESTOQUE_COL_*` | ver `.env.example` | Lista (separada por vírgula) das tabelas/abas de estoque a consultar, e nomes de coluna (ajuste para bater com a planilha real) |
| `SUPABASE_OPERACOES_TABLE` / `SUPABASE_STORAGE_BUCKET` | `operacoes` / `fotos-operacoes` | Tabela e bucket (de propriedade deste serviço) que alimentam o dashboard do cliente |

Listas de e-mail destinatário e de contatos telefônicos (para a DM) **ficam
no workflow do n8n** (node "Config"), não neste serviço — assim quem opera o
n8n consegue trocar essas listas sem depender de deploy do serviço Python.

## Booking, cliente e estoque (Supabase)

Booking e cliente são **obrigatórios**: o PDF só é gerado depois que alguém
responde essa pergunta no grupo. Da segunda operação em diante no mesmo chat,
o bot pergunta se quer reaproveitar o booking/cliente anterior — basta
responder "sim", ou informar um booking/cliente novo diretamente.

O número do flex tank identificado é consultado nas tabelas de estoque
importadas do Google Sheets (rode
[`config/supabase_schema.sql`](config/supabase_schema.sql) no seu projeto
Supabase e configure as variáveis `SUPABASE_*` — os nomes de tabela/coluna são
configuráveis porque esse serviço não é dono dessa planilha). A planilha tem
**várias abas**: liste todas em `SUPABASE_ESTOQUE_TABLES` (separadas por
vírgula, uma tabela do Supabase por aba) — o serviço procura o número em cada
uma, na ordem, até achar:

- **Encontrado** → marcado como baixado na aba/tabela onde apareceu, e o PDF
  mostra "encontrado na base de estoque — baixado (aba: nome_da_tabela)".
- **Não encontrado em nenhuma aba** → o PDF e a mensagem do grupo avisam "NÃO
  CONSTA na base de estoque", para conferência manual — a operação segue
  normalmente (o e-mail/PDF são gerados de qualquer forma).

Isso assume que todas as abas seguem o mesmo padrão de colunas (mesmo nome
para "número do flex" e "status" em todas). Se alguma aba tiver colunas
diferentes das outras, essa consulta genérica não serve — avise que aí
precisamos tratar aba por aba.

Sem `SUPABASE_URL`/`SUPABASE_KEY` configurados, essa consulta é simplesmente
pulada (`flex_em_estoque: null`, "estoque não consultado" no PDF) — não é
obrigatório ter Supabase pra usar o resto do sistema.

## Dashboard do cliente (Supabase)

Toda operação finalizada grava 1 linha na tabela `operacoes` do Supabase
(nome configurável), com o número do contêiner, do flex tank, booking,
cliente, se foi encontrado no estoque, e as 5 fotos (sobem para um bucket do
Supabase Storage e ficam com URL pública salva em `fotos`, formato jsonb:
`[{"role": "...", "filename": "...", "url": "..."}]`). Essa tabela é a base
para montar uma tela de dashboard do cliente (não incluída neste repositório
— é só a gravação dos dados; o front-end de consulta é um próximo passo).

Isso é "melhor esforço": se o Supabase falhar ao gravar o dashboard, a
operação não é interrompida — o e-mail com o PDF já foi gerado de qualquer
jeito (a falha fica só registrada no log do serviço).

## Integração com o n8n

1. Importe [`n8n/whatsapp-container-flex-workflow.json`](n8n/whatsapp-container-flex-workflow.json) no n8n.
2. Ajuste o node **Config**: URL do `cntr-vision`, ID do grupo, e-mails
   destinatários, telefones dos contatos (para a DM) e URL de envio do
   seu provedor de WhatsApp (Evolution API/WAHA/etc.).
3. Ajuste o node **Webhook - Mensagem WhatsApp** e o Code node **Extrai dados
   da mensagem** para o formato exato do payload que seu provedor envia — o
   código já vem comentado indicando onde mexer, incluindo a detecção de
   mensagem de texto (`is_text`) usada para reconhecer a resposta de
   booking/cliente.
4. Configure a credencial SMTP no node **Envia e-mail com o PDF**.
5. Ajuste os nodes de HTTP Request que enviam mensagem ao WhatsApp (**Pergunta
   no grupo**, **Reenvia pergunta no grupo**, **Responde no grupo**, **Envia
   DM ao contato**) para o endpoint exato do seu provedor.
6. Publique o webhook do n8n como o endpoint de callback do seu provedor de
   WhatsApp.

Veja os comentários (sticky note) dentro do próprio workflow para mais
detalhes de adaptação, incluindo como trocar a DM de texto por um envio do
PDF como documento (endpoint de mídia do seu provedor).

## Personalização do PDF (logo e rodapé)

O cabeçalho do PDF usa a logo em `app/assets/logo_jw.png` (fundo já removido/
transparente) e o rodapé mostra "Desenvolvido por Lourival®" em todas as
páginas — ambos configurados em `app/report.py` (constantes `_LOGO_PATH` e
`_FOOTER_TEXT`). Para trocar a logo, substitua esse arquivo PNG (mantenha o
fundo transparente); para trocar o texto do rodapé, edite `_FOOTER_TEXT`.
