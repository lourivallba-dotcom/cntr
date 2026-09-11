# cntr — extração de nº do contêiner + flex tank para o grupo de WhatsApp

Serviço de visão computacional (FastAPI/Python) usado por um workflow do
**n8n** que roda dentro de um grupo de WhatsApp: recebe as 5 fotos de uma
operação (etiqueta do flex tank, porta do contêiner, parte interna), extrai o
número do contêiner e o número do flex tank/processo administrativo, envia as
5 fotos por e-mail e responde no grupo com os números encontrados, marcando os
responsáveis pela operação.

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
grupo WhatsApp (5 fotos) 
   -> n8n recebe cada foto via webhook
   -> n8n chama POST /batches/{chat_id}/images (uma chamada por foto)
   -> ao chegar a 5ª foto, o cntr-vision já responde com:
        - número do contêiner (validado pelo dígito verificador ISO 6346)
        - número do flex tank / processo administrativo (QR > código de
          barras > OCR, nessa ordem de prioridade)
        - qual foto é a etiqueta, qual é a porta do contêiner, e as demais
        - as 5 fotos em base64, prontas para anexar no e-mail
   -> n8n envia o e-mail com as 5 fotos + os números encontrados
   -> n8n responde no grupo com os números e @menciona os responsáveis
```

Um lote incompleto (o grupo mandou só 3 fotos e parou) expira sozinho depois
de um tempo de inatividade configurável (`BATCH_TTL_SECONDS`, padrão 15 min),
para não misturar fotos de duas operações diferentes.

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

## Rodando localmente

```bash
cp .env.example .env
docker compose up --build
```

A API sobe em `http://localhost:8000` (documentação interativa em
`http://localhost:8000/docs`).

### Endpoints

- `POST /batches/{chat_id}/images` — envia 1 foto (form-data, campo `file`)
  para o lote do chat `chat_id`. Responde `{ count, ready, result? }`; `result`
  só vem preenchido quando o lote atinge `BATCH_SIZE` (padrão 5).
- `GET /batches/{chat_id}` — consulta quantas fotos já chegaram nesse lote.
- `POST /batches/{chat_id}/reset` — descarta o lote em andamento (útil se o
  grupo mandou fotos erradas).
- `POST /process` — versão "sem estado": processa 1+ fotos enviadas de uma vez
  só (campo `files`), sem precisar do fluxo de acumular por `chat_id`.
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
| `STORE_BACKEND` | `memory` | `memory` (simples) ou `redis` (sobrevive a reinícios/múltiplos workers) |
| `REDIS_URL` | — | Necessário se `STORE_BACKEND=redis` |
| `OCR_LANG` | `por+eng` | Idiomas do Tesseract OCR |

Listas de e-mail destinatário e de responsáveis para @menção **ficam no
workflow do n8n** (node "Config"), não neste serviço — assim quem opera o
n8n consegue trocar essas listas sem depender de deploy do serviço Python.

## Integração com o n8n

1. Importe [`n8n/whatsapp-container-flex-workflow.json`](n8n/whatsapp-container-flex-workflow.json) no n8n.
2. Ajuste o node **Config**: URL do `cntr-vision`, ID do grupo, e-mails
   destinatários, telefones dos responsáveis (para @menção) e URL de envio do
   seu provedor de WhatsApp (Evolution API/WAHA/etc.).
3. Ajuste o node **Webhook - Mensagem WhatsApp** e o Code node **Extrai dados
   da mensagem** para o formato exato do payload que seu provedor envia — o
   código já vem comentado indicando onde mexer.
4. Configure a credencial SMTP no node **Envia e-mail com as 5 fotos**.
5. Ajuste o node **Responde no grupo com menção** para o endpoint de envio de
   mensagem do seu provedor (o formato do body de "menção" varia entre
   Evolution API/WAHA/Baileys).
6. Publique o webhook do n8n como o endpoint de callback do seu provedor de
   WhatsApp.

Veja os comentários (sticky note) dentro do próprio workflow para mais
detalhes de adaptação.
