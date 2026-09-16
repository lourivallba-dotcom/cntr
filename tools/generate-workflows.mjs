#!/usr/bin/env node
/**
 * Gera workflows/agente-cta.json a partir de tools/config.json.
 *
 * Node types usados (de proposito restritos a um conjunto pequeno e estavel
 * do n8n, para minimizar risco de incompatibilidade entre versoes):
 *   - n8n-nodes-base.webhook
 *   - n8n-nodes-base.scheduleTrigger
 *   - n8n-nodes-base.code           (sempre "runOnceForAllItems", mapeando
 *                                    manualmente sobre $input.all())
 *   - n8n-nodes-base.httpRequest    (Evolution API e Anthropic API)
 *   - n8n-nodes-base.postgres       (sempre "executeQuery" com a query
 *                                    inteira vinda de um campo `sql`/`sqlX`
 *                                    montado por um Code node anterior, ja
 *                                    com qualquer texto escapado via
 *                                    pgQuote/pgEscape - nunca concatenacao
 *                                    direta de texto nao confiavel)
 *   - n8n-nodes-base.emailSend
 *
 * Depois de importar no n8n, configure as credenciais (ver README):
 *   - "Evolution API Key"  (Header Auth, header "apikey")
 *   - "Anthropic API Key"  (Header Auth, header "x-api-key")
 *   - "Postgres CTA"       (Postgres)
 *   - "SMTP CTA"           (SMTP)
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const cfg = JSON.parse(readFileSync(path.join(ROOT, "tools/config.json"), "utf-8"));

// ---------------------------------------------------------------------------
// Helper JS embutido no topo de todo Code node que monta SQL.
// ---------------------------------------------------------------------------
const HELPER_PRELUDE = [
  "function pgEscape(v) { return String(v).replace(/'/g, \"''\"); }",
  "function pgQuote(v) { if (v === null || v === undefined || v === '') return 'NULL'; return \"'\" + pgEscape(v) + \"'\"; }",
  "function pgQuoteArray(arr) { if (!arr || !arr.length) return 'NULL'; return 'ARRAY[' + arr.map(function(v){ return \"'\" + pgEscape(v) + \"'\"; }).join(',') + ']::text[]'; }",
  "function parseBrDate(str) { if (!str) return null; var m = String(str).trim().match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{2,4})$/); if (!m) return null; var d=m[1],mo=m[2],y=m[3]; if (y.length===2) y='20'+y; return y.padStart(4,'0')+'-'+mo.padStart(2,'0')+'-'+d.padStart(2,'0'); }",
  "function pickContainer(text) {",
  "  if (!text) return '';",
  "  var matches = text.match(/[A-Za-z]{4}\\s*-?\\s*\\d{6}\\s*-?\\s*\\d/g) || [];",
  "  for (var i=0;i<matches.length;i++) {",
  "    var norm = matches[i].replace(/[^A-Za-z0-9]/g,'').toUpperCase();",
  "    if (isValidContainerChecksum(norm)) return norm;",
  "  }",
  "  if (matches.length) return matches[0].replace(/[^A-Za-z0-9]/g,'').toUpperCase();",
  "  return text.trim().split(/\\s+/)[0] || '';",
  "}",
  "function isValidContainerChecksum(code) {",
  "  if (!/^[A-Z]{4}\\d{7}$/.test(code)) return false;",
  "  var values = {}; var v = 10;",
  "  for (var i=0;i<26;i++) { if (v%11===0) v++; values[String.fromCharCode(65+i)] = v; v++; }",
  "  var sum = 0;",
  "  for (var i=0;i<10;i++) { var c = code[i]; var val = /[0-9]/.test(c) ? Number(c) : values[c]; sum += val * Math.pow(2,i); }",
  "  var check = sum % 11; if (check === 10) check = 0;",
  "  return check === Number(code[10]);",
  "}",
].join("\n");

// ---------------------------------------------------------------------------
// Prompt e schema de tool-use enviados ao Claude Vision.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `Voce e um assistente que analisa imagens enviadas em um grupo de WhatsApp de uma operacao logistica de flex tanque (flexitank) dentro de containers maritimos. Duas coisas diferentes podem ser enviadas:

1) Uma foto/print de uma PLANILHA DE PROGRAMACAO (tabela com colunas como: Recebimento da programacao, BOOKING, QTD CNTR, Data de carregamento, Data da MONTAGEM DO FLEX, Data da coleta do cntr vazio, Planta de carregamento, ARMADOR, OBS). Quando for esse o caso, use document_type="programacao" e preencha programacao_rows com uma entrada para CADA booking/linha visivel na tabela (leia todas as linhas, nao so a primeira). Copie as datas exatamente como aparecem, no formato DD/MM/AAAA.

2) Uma FOTO DE UMA OPERACAO DE MONTAGEM DE FLEX TANQUE. Quando for esse o caso, use document_type="foto_operacao" e classifique em uma destas categorias (photo_type):
   - etiqueta: etiqueta branca colada no flex tanque (campos como PRO NAME, PRO SPEC, Lot No, Material). IMPORTANTE: a etiqueta NEM SEMPRE tem QR code ou codigo de barras - as vezes so tem texto impresso. O identificador principal do flex tanque tem formato variavel (ex: pode comecar com "DWH" seguido de numeros/letras, mas outros prefixos tambem existem) - leia com atencao e coloque em flex_tank_code_text. O campo "Lot No" e diferente e vai em flex_lot_no_text.
   - porta: foto da porta/parte externa do container fechado, mostrando o numero do container pintado (padrao ISO 6346: 4 letras + 7 digitos) e o nome/logo do armador (ex: MAERSK, MSC, CMA CGM). Preencha container_number_text e carrier_text.
   - interna_vazia: interior do container vazio, sem o flex tanque ainda instalado.
   - interna_flex: interior do container com o flex tanque ja instalado.
   - trava: anteparo/trava (madeira, papelao ou similar) instalado contra a porta para segurar a carga.
   - geral: outra foto geral relacionada a operacao.
   - desconhecida: nao relacionado a nenhuma categoria acima.

   Leia com atencao qualquer texto visivel (mesmo pequeno) e preencha os campos que se aplicarem. Se nao conseguir ler algo com confianca, deixe o campo vazio em vez de adivinhar.`;

const TOOL_SCHEMA = {
  name: "report_incoming_image",
  description: "Reporta o que foi identificado na imagem enviada no grupo (programacao ou foto de operacao).",
  input_schema: {
    type: "object",
    properties: {
      document_type: { type: "string", enum: ["programacao", "foto_operacao", "desconhecido"] },
      programacao_rows: {
        type: "array",
        description: "Preencher somente se document_type=programacao. Uma entrada por linha/booking visivel na tabela.",
        items: {
          type: "object",
          properties: {
            recebimento_programacao: { type: "string", description: "DD/MM/AAAA" },
            booking: { type: "string" },
            qtd_cntr: { type: "integer" },
            data_carregamento: { type: "string", description: "DD/MM/AAAA" },
            data_montagem_flex: { type: "string", description: "DD/MM/AAAA" },
            data_coleta_cntr_vazio: { type: "string", description: "DD/MM/AAAA" },
            planta_carregamento: { type: "string" },
            armador: { type: "string" },
            obs: { type: "string" },
          },
          required: ["booking"],
        },
      },
      photo_type: {
        type: "string",
        enum: ["etiqueta", "porta", "interna_vazia", "interna_flex", "trava", "geral", "desconhecida"],
        description: "Preencher somente se document_type=foto_operacao.",
      },
      container_number_text: { type: "string" },
      carrier_text: { type: "string" },
      flex_tank_code_text: { type: "string" },
      flex_lot_no_text: { type: "string" },
      reasoning: { type: "string" },
    },
    required: ["document_type"],
  },
};

// ---------------------------------------------------------------------------
// Builders de node
// ---------------------------------------------------------------------------
let xCounters = {};
function pos(lane, laneY) {
  xCounters[lane] = (xCounters[lane] || 0) + 1;
  return [xCounters[lane] * 280, laneY];
}

function code(name, lines, position) {
  return {
    id: randomUUID(),
    name,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
    parameters: { mode: "runOnceForAllItems", language: "javaScript", jsCode: lines.join("\n") },
  };
}

function pg(name, queryExpr, position) {
  return {
    id: randomUUID(),
    name,
    type: "n8n-nodes-base.postgres",
    typeVersion: 2.5,
    position,
    parameters: { operation: "executeQuery", query: queryExpr, options: {} },
    credentials: { postgres: { id: "10", name: "Postgres CTA" } },
  };
}

function httpNode(name, { method, url, jsonBodyExpr, credName, credId, notes }, position) {
  return {
    id: randomUUID(),
    name,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position,
    notes: notes || "",
    parameters: {
      method,
      url,
      authentication: "genericCredentialType",
      genericAuthType: "httpHeaderAuth",
      sendHeaders: true,
      headerParameters: { parameters: [{ name: "Content-Type", value: "application/json" }] },
      sendBody: true,
      specifyBody: "json",
      jsonBody: jsonBodyExpr,
      options: {},
    },
    credentials: { httpHeaderAuth: { id: credId, name: credName } },
  };
}

function webhookNode(name, webPath, position) {
  return {
    id: randomUUID(),
    name,
    type: "n8n-nodes-base.webhook",
    typeVersion: 2,
    position,
    webhookId: randomUUID(),
    parameters: { httpMethod: "POST", path: webPath, responseMode: "onReceived", responseCode: 200, options: {} },
  };
}

function scheduleNode(name, minutes, position) {
  return {
    id: randomUUID(),
    name,
    type: "n8n-nodes-base.scheduleTrigger",
    typeVersion: 1.2,
    position,
    parameters: { rule: { interval: [{ field: "minutes", minutesInterval: minutes }] } },
  };
}

function emailNode(name, position) {
  const htmlExpr =
    "={{ '<p>Container: <b>' + ($json.containerNumber || 'NAO IDENTIFICADO') + '</b><br/>' + " +
    "'Flex tanque: <b>' + ($json.flexTankNumber || 'NAO IDENTIFICADO') + '</b>' + ($json.flexLotNo ? ' (Lot No: ' + $json.flexLotNo + ')' : '') + '<br/>' + " +
    "(($json.booking) ? ('Booking: <b>' + $json.booking + '</b> - Planta: ' + ($json.loadingPlant || '-') + ' - Armador: ' + ($json.carrier || '-') + '<br/>Progresso: ' + ((Number($json.qtyAssembled)||0)+1) + ' de ' + ($json.qtyContainers || '?') + '<br/>') : 'Booking: NAO LOCALIZADO<br/>') + " +
    "'Grupo: ' + ($json.groupName || $json.groupId) + '<br/>Enviado por: ' + ($json.senderName || '-') + '</p>' }}";
  return {
    id: randomUUID(),
    name,
    type: "n8n-nodes-base.emailSend",
    typeVersion: 2.1,
    position,
    parameters: {
      fromEmail: cfg.email.from,
      toEmail: cfg.email.to.join(","),
      ccEmail: (cfg.email.cc || []).join(","),
      subject:
        "={{ 'Operacao Flex Tanque - Container ' + ($json.containerNumber || 'N/D') + ' / Flex ' + ($json.flexTankNumber || 'N/D') }}",
      emailFormat: "html",
      html: htmlExpr,
      attachments: "={{ Object.keys($binary || {}).join(',') }}",
      options: {},
    },
    credentials: { smtp: { id: "20", name: "SMTP CTA" } },
  };
}

// ---------------------------------------------------------------------------
// Grafo: nodes + connections
// ---------------------------------------------------------------------------
const nodes = [];
const connections = {};
function add(node) {
  nodes.push(node);
  return node.name;
}
function link(from, to, outIndex = 0) {
  connections[from] = connections[from] || { main: [] };
  while (connections[from].main.length <= outIndex) connections[from].main.push([]);
  connections[from].main[outIndex].push({ node: to, type: "main", index: 0 });
}
function chain(names) {
  for (let i = 0; i < names.length - 1; i++) link(names[i], names[i + 1]);
}

const EVOLUTION_URL = cfg.evolution.baseUrl.replace(/\/$/, "");
const EVOLUTION_INSTANCE = cfg.evolution.instance;
const SEND_TEXT_URL = `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`;
const GET_BASE64_URL = `${EVOLUTION_URL}/chat/getBase64FromMediaMessage/${EVOLUTION_INSTANCE}`;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const anthropicBodyExpr =
  "={{ JSON.stringify({ model: " +
  JSON.stringify(cfg.anthropic.model) +
  ", max_tokens: 1200, system: " +
  JSON.stringify(SYSTEM_PROMPT) +
  ", tools: " +
  JSON.stringify([TOOL_SCHEMA]) +
  ', tool_choice: {type:"tool", name:"report_incoming_image"}, messages: [{role:"user", content: [{type:"image", source:{type:"base64", media_type: $json.mimetype || "image/jpeg", data: $json.base64}}, {type:"text", text:"Analise esta imagem conforme as instrucoes."}]}] }) }}';

// === Lane T1: webhook + normalizacao ========================================
const LANE_T1 = 0;
const nWebhook = add(webhookNode("Webhook Evolution", "evolution-webhook", pos("t1", LANE_T1)));

const nNormalizar = add(
  code(
    "Normalizar mensagem",
    [
      "const first = $input.first().json;",
      "const body = first.body || first;",
      "const data = body.data || body;",
      "const key = data.key || {};",
      "const remoteJid = key.remoteJid || '';",
      "const fromMe = !!key.fromMe;",
      "const messageId = key.id || '';",
      "const participant = key.participant || remoteJid || '';",
      "const pushName = data.pushName || '';",
      "const message = data.message || {};",
      "const viewOnce = message.viewOnceMessageV2 && message.viewOnceMessageV2.message;",
      "const imageMessage = message.imageMessage || (viewOnce && viewOnce.imageMessage) || null;",
      "const textBody = message.conversation || (message.extendedTextMessage && message.extendedTextMessage.text) || '';",
      "const isGroup = remoteJid.endsWith('@g.us');",
      `const ALLOWED_GROUPS = ${JSON.stringify(cfg.whatsapp.allowedGroupIds)};`,
      "let kind = 'ignore';",
      "if (isGroup && !fromMe) { if (imageMessage) kind = 'image'; else if (textBody) kind = 'text'; }",
      "if (kind !== 'ignore' && ALLOWED_GROUPS.length && !ALLOWED_GROUPS.includes(remoteJid)) kind = 'ignore';",
      "return [{ json: { kind, groupId: remoteJid, senderId: participant, senderName: pushName, messageId, mimeType: imageMessage ? (imageMessage.mimetype || 'image/jpeg') : '', textBody } }];",
    ],
    pos("t1", LANE_T1),
  ),
);
link(nWebhook, nNormalizar);

// --- branch: imagem ---------------------------------------------------------
const nGateImagem = add(
  code(
    "Gate - Eh imagem",
    ["const items = $input.all();", "const out = [];", "for (const item of items) { if (item.json.kind === 'image') out.push(item); }", "return out;"],
    pos("t1", LANE_T1),
  ),
);
link(nNormalizar, nGateImagem);

const nBuscarBase64 = add(
  httpNode(
    "Buscar midia base64",
    {
      method: "POST",
      url: GET_BASE64_URL,
      jsonBodyExpr:
        "={{ JSON.stringify({ message: { key: { id: $json.messageId, remoteJid: $json.groupId, fromMe: false, participant: $json.senderId } } }) }}",
      credName: "Evolution API Key",
      credId: "1",
      notes: "Ajuste o path conforme a versao da sua Evolution API - veja README.",
    },
    pos("t1", LANE_T1),
  ),
);
link(nGateImagem, nBuscarBase64);

const nVision = add(
  httpNode(
    "Vision - Classificar imagem",
    { method: "POST", url: ANTHROPIC_URL, jsonBodyExpr: anthropicBodyExpr, credName: "Anthropic API Key", credId: "2" },
    pos("t1", LANE_T1),
  ),
);
link(nBuscarBase64, nVision);

const nExtrairAnalise = add(
  code(
    "Extrair analise da imagem",
    [
      "const resp = $input.first().json;",
      "const toolUse = (resp.content || []).find(function(b){ return b.type === 'tool_use' && b.name === 'report_incoming_image'; });",
      "const input = toolUse ? toolUse.input : {};",
      "const norm = $('Normalizar mensagem').first().json;",
      "const media = $('Buscar midia base64').first().json;",
      "return [{ json: {",
      "  groupId: norm.groupId, senderId: norm.senderId, senderName: norm.senderName, messageId: norm.messageId,",
      "  mimeType: media.mimetype || norm.mimeType || 'image/jpeg', base64: media.base64 || '',",
      "  documentType: input.document_type || 'desconhecido', programacaoRows: Array.isArray(input.programacao_rows) ? input.programacao_rows : [],",
      "  photoType: input.photo_type || 'desconhecida', containerNumberText: input.container_number_text || '', carrierText: input.carrier_text || '',",
      "  flexTankCodeText: input.flex_tank_code_text || '', flexLotNoText: input.flex_lot_no_text || '',",
      "} }];",
    ],
    pos("t1", LANE_T1),
  ),
);
link(nVision, nExtrairAnalise);

// --- sub-branch: programacao -------------------------------------------------
const LANE_PROG = -300;
const nPrepararLinhas = add(
  code(
    "Preparar linhas da programacao",
    [
      HELPER_PRELUDE,
      "const items = $input.all();",
      "const out = [];",
      "for (const item of items) {",
      "  const j = item.json;",
      "  if (j.documentType !== 'programacao') continue;",
      "  for (const row of (j.programacaoRows || [])) {",
      "    if (!row.booking) continue;",
      "    const booking = String(row.booking).trim();",
      "    const qty = parseInt(row.qtd_cntr, 10) || 1;",
      "    const sql = 'INSERT INTO bookings (group_id, booking, received_at, qty_containers, loading_date, flex_assembly_date, empty_pickup_date, loading_plant, carrier, notes) VALUES (' +",
      "      pgQuote(j.groupId) + ',' + pgQuote(booking) + ',' + pgQuote(parseBrDate(row.recebimento_programacao)) + ',' + qty + ',' + pgQuote(parseBrDate(row.data_carregamento)) + ',' + pgQuote(parseBrDate(row.data_montagem_flex)) + ',' + pgQuote(parseBrDate(row.data_coleta_cntr_vazio)) + ',' + pgQuote(row.planta_carregamento) + ',' + pgQuote(row.armador) + ',' + pgQuote(row.obs) +",
      "      \") ON CONFLICT (booking) DO UPDATE SET group_id=EXCLUDED.group_id, received_at=EXCLUDED.received_at, qty_containers=EXCLUDED.qty_containers, loading_date=EXCLUDED.loading_date, flex_assembly_date=EXCLUDED.flex_assembly_date, empty_pickup_date=EXCLUDED.empty_pickup_date, loading_plant=EXCLUDED.loading_plant, carrier=EXCLUDED.carrier, notes=EXCLUDED.notes, updated_at=now() RETURNING booking, (xmax = 0) AS inserted, \" + pgQuote(j.groupId) + \" AS group_id\";",
      "    out.push({ json: { sql } });",
      "  }",
      "}",
      "return out;",
    ],
    pos("prog", LANE_PROG),
  ),
);
link(nExtrairAnalise, nPrepararLinhas);

const nUpsertBooking = add(pg("Upsert booking", "={{ $json.sql }}", pos("prog", LANE_PROG)));
link(nPrepararLinhas, nUpsertBooking);

const nResumoProgramacao = add(
  code(
    "Montar resumo da programacao",
    [
      "const items = $input.all();",
      "if (!items.length) return [];",
      "const total = items.length;",
      "const inserted = items.filter(function(i){ return i.json.inserted === true || i.json.inserted === 't'; }).length;",
      "const groupId = items[0].json.group_id;",
      "const text = 'Programacao atualizada: ' + total + ' booking(s) (' + inserted + ' novo(s), ' + (total-inserted) + ' atualizado(s)).';",
      "return [{ json: { groupId, text } }];",
    ],
    pos("prog", LANE_PROG),
  ),
);
link(nUpsertBooking, nResumoProgramacao);

const nResponderProgramacao = add(
  httpNode(
    "Responder confirmacao da programacao",
    {
      method: "POST",
      url: SEND_TEXT_URL,
      jsonBodyExpr: "={{ JSON.stringify({ number: $json.groupId, text: $json.text }) }}",
      credName: "Evolution API Key",
      credId: "1",
    },
    pos("prog", LANE_PROG),
  ),
);
link(nResumoProgramacao, nResponderProgramacao);

// --- sub-branch: foto de operacao -------------------------------------------
const LANE_FOTO = 300;
const nPrepararFoto = add(
  code(
    "Preparar foto de operacao",
    [
      HELPER_PRELUDE,
      "const items = $input.all();",
      "const out = [];",
      "for (const item of items) {",
      "  const j = item.json;",
      "  if (j.documentType !== 'foto_operacao') continue;",
      "  const photoType = j.photoType || 'desconhecida';",
      "  const sqlEnsure = 'INSERT INTO photo_batches (group_id, sender_id, sender_name, status) SELECT ' + pgQuote(j.groupId) + ',' + pgQuote(j.senderId) + ',' + pgQuote(j.senderName) + \",'pending' WHERE NOT EXISTS (SELECT 1 FROM photo_batches WHERE group_id=\" + pgQuote(j.groupId) + ' AND sender_id=' + pgQuote(j.senderId) + \" AND status='pending')\";",
      "  const sqlSelect = 'SELECT id AS batch_id, group_id, group_name, sender_id, sender_name FROM photo_batches WHERE group_id=' + pgQuote(j.groupId) + ' AND sender_id=' + pgQuote(j.senderId) + \" AND status='pending' ORDER BY created_at DESC LIMIT 1\";",
      "  out.push({ json: { ...j, photoType, sqlEnsure, sqlSelect } });",
      "}",
      "return out;",
    ],
    pos("foto", LANE_FOTO),
  ),
);
link(nExtrairAnalise, nPrepararFoto);

const nGarantirLote = add(pg("Garantir lote aberto", "={{ $json.sqlEnsure }}", pos("foto", LANE_FOTO)));
link(nPrepararFoto, nGarantirLote);

const nObterLote = add(pg("Obter lote aberto", "={{ $('Preparar foto de operacao').first().json.sqlSelect }}", pos("foto", LANE_FOTO)));
link(nGarantirLote, nObterLote);

const nPrepararInsercao = add(
  code(
    "Preparar insercao da foto",
    [
      HELPER_PRELUDE,
      "const batch = $input.first().json;",
      "const analysis = $('Preparar foto de operacao').first().json;",
      "const sql = 'INSERT INTO batch_photos (batch_id, message_id, mime_type, base64_data, photo_type, container_number_text, flex_tank_number_text, flex_lot_no_text, carrier_text) VALUES (' +",
      "  batch.batch_id + ',' + pgQuote(analysis.messageId) + ',' + pgQuote(analysis.mimeType) + ',' + pgQuote(analysis.base64) + ',' + pgQuote(analysis.photoType) + ',' + pgQuote(analysis.containerNumberText) + ',' + pgQuote(analysis.flexTankCodeText) + ',' + pgQuote(analysis.flexLotNoText) + ',' + pgQuote(analysis.carrierText) +",
      "  ') RETURNING batch_id';",
      "const sqlTouch = 'UPDATE photo_batches SET updated_at = now() WHERE id = ' + batch.batch_id;",
      "const sqlCount = 'SELECT ' + batch.batch_id + ' AS batch_id, ' + pgQuote(batch.group_id) + ' AS group_id, ' + pgQuote(batch.group_name) + ' AS group_name, ' + pgQuote(batch.sender_id) + ' AS sender_id, ' + pgQuote(batch.sender_name) + ' AS sender_name, (SELECT count(*)::int FROM batch_photos WHERE batch_id = ' + batch.batch_id + ') AS photo_count';",
      "return [{ json: { sql, sqlTouch, sqlCount } }];",
    ],
    pos("foto", LANE_FOTO),
  ),
);
link(nObterLote, nPrepararInsercao);

const nSalvarFoto = add(pg("Salvar foto no lote", "={{ $json.sql }}", pos("foto", LANE_FOTO)));
link(nPrepararInsercao, nSalvarFoto);

const nAtualizarTimestamp = add(
  pg("Atualizar timestamp do lote", "={{ $('Preparar insercao da foto').first().json.sqlTouch }}", pos("foto", LANE_FOTO)),
);
link(nSalvarFoto, nAtualizarTimestamp);

const nContarFotos = add(
  pg("Contar fotos do lote", "={{ $('Preparar insercao da foto').first().json.sqlCount }}", pos("foto", LANE_FOTO)),
);
link(nAtualizarTimestamp, nContarFotos);

const nGateLoteCompleto = add(
  code(
    "Gate - Lote completo",
    [
      `const EXPECTED = ${JSON.stringify(cfg.batch.expectedPhotos)};`,
      "const items = $input.all();",
      "const out = [];",
      "for (const item of items) { if ((item.json.photo_count || 0) >= EXPECTED) out.push(item); }",
      "return out;",
    ],
    pos("foto", LANE_FOTO),
  ),
);
link(nContarFotos, nGateLoteCompleto);

// --- branch: texto (resolucao de booking ambiguo) ---------------------------
const LANE_TXT = 600;
const nGateTexto = add(
  code(
    "Gate - Eh texto",
    ["const items = $input.all();", "const out = [];", "for (const item of items) { if (item.json.kind === 'text') out.push(item); }", "return out;"],
    pos("txt", LANE_TXT),
  ),
);
link(nNormalizar, nGateTexto);

const nPrepararBuscaAguardando = add(
  code(
    "Preparar busca de lote aguardando",
    [
      HELPER_PRELUDE,
      "const j = $input.first().json;",
      "const sql = 'SELECT id AS batch_id, group_id, group_name, sender_id, sender_name, candidate_bookings FROM photo_batches WHERE group_id=' + pgQuote(j.groupId) + \" AND status='awaiting_booking_choice' ORDER BY updated_at DESC LIMIT 1\";",
      "return [{ json: { sql, textBody: j.textBody } }];",
    ],
    pos("txt", LANE_TXT),
  ),
);
link(nGateTexto, nPrepararBuscaAguardando);

const nBuscarLoteAguardando = add(pg("Buscar lote aguardando escolha", "={{ $json.sql }}", pos("txt", LANE_TXT)));
link(nPrepararBuscaAguardando, nBuscarLoteAguardando);

const nCasarTexto = add(
  code(
    "Tentar casar texto com candidato",
    [
      "const items = $input.all();",
      "const textBody = ($('Preparar busca de lote aguardando').first().json.textBody || '').toUpperCase();",
      "const out = [];",
      "for (const item of items) {",
      "  const candidates = item.json.candidate_bookings || [];",
      "  const match = candidates.find(function(b){ return textBody.includes(String(b).toUpperCase()); });",
      "  if (match) out.push({ json: { batch_id: item.json.batch_id, matchedBooking: match } });",
      "}",
      "return out;",
    ],
    pos("txt", LANE_TXT),
  ),
);
link(nBuscarLoteAguardando, nCasarTexto);

const nPrepararBuscaBookingId = add(
  code(
    "Preparar busca do booking escolhido",
    [
      HELPER_PRELUDE,
      "const j = $input.first().json;",
      "const sql = 'SELECT id AS booking_id FROM bookings WHERE booking = ' + pgQuote(j.matchedBooking) + ' LIMIT 1';",
      "return [{ json: { sql } }];",
    ],
    pos("txt", LANE_TXT),
  ),
);
link(nCasarTexto, nPrepararBuscaBookingId);

const nBuscarBookingId = add(pg("Buscar id do booking escolhido", "={{ $json.sql }}", pos("txt", LANE_TXT)));
link(nPrepararBuscaBookingId, nBuscarBookingId);

const nPrepararGravarResolvido = add(
  code(
    "Preparar gravacao do booking resolvido",
    [
      HELPER_PRELUDE,
      "const bookingRow = $input.first().json;",
      "const ctx = $('Tentar casar texto com candidato').first().json;",
      "const sql = 'UPDATE photo_batches SET matched_booking_id=' + bookingRow.booking_id + \", match_status='resolved', status='processing', updated_at=now() WHERE id=\" + ctx.batch_id + ' RETURNING id AS batch_id';",
      "return [{ json: { sql } }];",
    ],
    pos("txt", LANE_TXT),
  ),
);
link(nBuscarBookingId, nPrepararGravarResolvido);

const nGravarResolvido = add(pg("Gravar booking resolvido", "={{ $json.sql }}", pos("txt", LANE_TXT)));
link(nPrepararGravarResolvido, nGravarResolvido);

// === Lane T2: sweep de lotes parados ========================================
const LANE_T2 = 900;
const nSchedule = add(scheduleNode("Agendamento - Verificar Lotes Parados", cfg.batch.sweepIntervalMinutes, pos("t2", LANE_T2)));
const sweepSql =
  "SELECT pb.id AS batch_id FROM photo_batches pb WHERE pb.status='pending' AND pb.updated_at < now() - interval '" +
  Number(cfg.batch.windowSeconds) +
  " seconds' AND EXISTS (SELECT 1 FROM batch_photos WHERE batch_id = pb.id)";
const nBuscarLotesParados = add(pg("Buscar lotes parados", sweepSql, pos("t2", LANE_T2)));
link(nSchedule, nBuscarLotesParados);

// === PARTE 1: tentar finalizar automaticamente (entrada: {batch_id}) =======
const LANE_P1 = 1300;
const nTravarLote = add(
  pg(
    "Travar lote (processing)",
    "={{ \"UPDATE photo_batches SET status='processing', updated_at=now() WHERE id=\" + $json.batch_id + \" AND status='pending' RETURNING id AS batch_id, group_id, group_name, sender_id, sender_name\" }}",
    pos("p1", LANE_P1),
  ),
);
link(nGateLoteCompleto, nTravarLote);
link(nBuscarLotesParados, nTravarLote);

const nMontarSqlAgregados = add(
  code(
    "Montar SQL - agregados das fotos",
    [
      HELPER_PRELUDE,
      "const items = $input.all();",
      "const out = [];",
      "for (const item of items) {",
      "  const j = item.json;",
      "  const sql = 'SELECT ' + j.batch_id + ' AS batch_id, ' + pgQuote(j.group_id) + ' AS group_id, ' + pgQuote(j.group_name) + ' AS group_name, ' + pgQuote(j.sender_id) + ' AS sender_id, ' + pgQuote(j.sender_name) + ' AS sender_name, ' +",
      "    \"string_agg(DISTINCT NULLIF(carrier_text,''), ' ') AS carrier_texts, string_agg(DISTINCT NULLIF(container_number_text,''), ' ') AS container_texts, string_agg(DISTINCT NULLIF(flex_tank_number_text,''), ' ') AS flex_texts, string_agg(DISTINCT NULLIF(flex_lot_no_text,''), ' ') AS lot_texts FROM batch_photos WHERE batch_id=\" + j.batch_id + ' GROUP BY 1,2,3,4,5';",
      "  out.push({ json: { sql } });",
      "}",
      "return out;",
    ],
    pos("p1", LANE_P1),
  ),
);
link(nTravarLote, nMontarSqlAgregados);

const nBuscarAgregados = add(pg("Buscar agregados das fotos", "={{ $json.sql }}", pos("p1", LANE_P1)));
link(nMontarSqlAgregados, nBuscarAgregados);

const nEscolherNumeros = add(
  code(
    "Escolher numeros e montar SQL de salvar",
    [
      HELPER_PRELUDE,
      "const items = $input.all();",
      "const out = [];",
      "for (const item of items) {",
      "  const j = item.json;",
      "  const containerNumber = pickContainer(j.container_texts || '');",
      "  const flexTankNumber = (j.flex_texts || '').trim().split(/\\s+/)[0] || '';",
      "  const flexLotNo = (j.lot_texts || '').trim();",
      "  const carrierText = (j.carrier_texts || '').trim();",
      "  const sqlSave = 'UPDATE photo_batches SET container_number=' + pgQuote(containerNumber) + ', flex_tank_number=' + pgQuote(flexTankNumber) + ', flex_lot_no=' + pgQuote(flexLotNo) + ', carrier_text=' + pgQuote(carrierText) + ', updated_at=now() WHERE id=' + j.batch_id +",
      "    ' RETURNING id AS batch_id, group_id, group_name, sender_id, sender_name, container_number, flex_tank_number, flex_lot_no, carrier_text';",
      "  out.push({ json: { sqlSave } });",
      "}",
      "return out;",
    ],
    pos("p1", LANE_P1),
  ),
);
link(nBuscarAgregados, nEscolherNumeros);

const nSalvarNumeros = add(pg("Salvar numeros no lote", "={{ $json.sqlSave }}", pos("p1", LANE_P1)));
link(nEscolherNumeros, nSalvarNumeros);

const nMontarSqlCandidatos = add(
  code(
    "Montar SQL - candidatos de booking",
    [
      HELPER_PRELUDE,
      "const items = $input.all();",
      "const out = [];",
      "for (const item of items) {",
      "  const j = item.json;",
      "  const carrierFilter = (j.carrier_text || '').trim().split(/\\s+/)[0] || '';",
      "  const filterClause = carrierFilter ? (\"AND carrier ILIKE '%\" + pgEscape(carrierFilter) + \"%'\") : '';",
      "  const sql = 'WITH candidates AS (SELECT id AS booking_id, booking, loading_plant, notes, qty_containers, qty_assembled FROM bookings WHERE group_id=' + pgQuote(j.group_id) + \" AND status='open' \" + filterClause + ' ORDER BY flex_assembly_date NULLS LAST, id ASC) ' +",
      "    'SELECT ' + j.batch_id + ' AS batch_id, ' + pgQuote(j.group_id) + ' AS group_id, ' + pgQuote(j.group_name) + ' AS group_name, ' + pgQuote(j.sender_id) + ' AS sender_id, ' + pgQuote(j.sender_name) + ' AS sender_name, ' + pgQuote(j.container_number) + ' AS container_number, ' + pgQuote(j.flex_tank_number) + ' AS flex_tank_number, ' + pgQuote(j.flex_lot_no) + ' AS flex_lot_no, ' + pgQuote(j.carrier_text) + ' AS carrier_text, ' +",
      "    '(SELECT count(*) FROM candidates)::int AS candidate_count, booking_id, booking, loading_plant, notes, qty_containers, qty_assembled FROM candidates ' +",
      "    'UNION ALL SELECT ' + j.batch_id + ',' + pgQuote(j.group_id) + ',' + pgQuote(j.group_name) + ',' + pgQuote(j.sender_id) + ',' + pgQuote(j.sender_name) + ',' + pgQuote(j.container_number) + ',' + pgQuote(j.flex_tank_number) + ',' + pgQuote(j.flex_lot_no) + ',' + pgQuote(j.carrier_text) + ',0,NULL,NULL,NULL,NULL,NULL,NULL WHERE NOT EXISTS (SELECT 1 FROM candidates)';",
      "  out.push({ json: { sql } });",
      "}",
      "return out;",
    ],
    pos("p1", LANE_P1),
  ),
);
link(nSalvarNumeros, nMontarSqlCandidatos);

const nBuscarCandidatos = add(pg("Buscar candidatos de booking", "={{ $json.sql }}", pos("p1", LANE_P1)));
link(nMontarSqlCandidatos, nBuscarCandidatos);

const nDecidirBooking = add(
  code(
    "Decidir booking automatico",
    [
      "const items = $input.all();",
      "const byBatch = new Map();",
      "for (const item of items) {",
      "  const j = item.json;",
      "  if (!byBatch.has(j.batch_id)) byBatch.set(j.batch_id, { ctx: j, rows: [] });",
      "  byBatch.get(j.batch_id).rows.push(j);",
      "}",
      "const out = [];",
      "for (const [batchId, { ctx, rows }] of byBatch) {",
      "  const count = Number(ctx.candidate_count) || 0;",
      "  let matchStatus = 'unmatched', matchedBookingId = null, candidateBookings = [];",
      "  if (count === 1) { matchStatus = 'auto'; matchedBookingId = rows[0].booking_id; }",
      "  else if (count > 1) { matchStatus = 'ambiguous'; candidateBookings = rows.map(function(r){ return { id: r.booking_id, booking: r.booking, plant: r.loading_plant, notes: r.notes, qty: r.qty_containers, assembled: r.qty_assembled }; }); }",
      "  out.push({ json: { batch_id: batchId, group_id: ctx.group_id, group_name: ctx.group_name, sender_id: ctx.sender_id, sender_name: ctx.sender_name, container_number: ctx.container_number, flex_tank_number: ctx.flex_tank_number, flex_lot_no: ctx.flex_lot_no, carrier_text: ctx.carrier_text, matchStatus, matchedBookingId, candidateBookings } });",
      "}",
      "return out;",
    ],
    pos("p1", LANE_P1),
  ),
);
link(nBuscarCandidatos, nDecidirBooking);

const nGateResolvido = add(
  code(
    "Gate - Resolvido automaticamente",
    ["const items = $input.all();", "return items.filter(function(i){ return i.json.matchStatus !== 'ambiguous'; });"],
    pos("p1", LANE_P1),
  ),
);
const nGateAmbiguo = add(
  code(
    "Gate - Ambiguo",
    ["const items = $input.all();", "return items.filter(function(i){ return i.json.matchStatus === 'ambiguous'; });"],
    pos("p1", LANE_P1 + 200),
  ),
);
link(nDecidirBooking, nGateResolvido);
link(nDecidirBooking, nGateAmbiguo);

const nMontarSqlGravarBooking = add(
  code(
    "Montar SQL - gravar booking no lote",
    [
      HELPER_PRELUDE,
      "const items = $input.all();",
      "const out = [];",
      "for (const item of items) {",
      "  const j = item.json;",
      "  const sql = 'UPDATE photo_batches SET matched_booking_id=' + (j.matchedBookingId || 'NULL') + ', match_status=' + pgQuote(j.matchStatus) + ', updated_at=now() WHERE id=' + j.batch_id + ' RETURNING id AS batch_id';",
      "  out.push({ json: { sql } });",
      "}",
      "return out;",
    ],
    pos("p1", LANE_P1),
  ),
);
link(nGateResolvido, nMontarSqlGravarBooking);
const nGravarBooking = add(pg("Gravar booking no lote", "={{ $json.sql }}", pos("p1", LANE_P1)));
link(nMontarSqlGravarBooking, nGravarBooking);

const nMontarSqlAguardando = add(
  code(
    "Montar SQL - aguardar escolha no grupo",
    [
      HELPER_PRELUDE,
      "const items = $input.all();",
      "const out = [];",
      "for (const item of items) {",
      "  const j = item.json;",
      "  const codes = j.candidateBookings.map(function(c){ return c.booking; });",
      "  const lines = ['Encontrei mais de um booking em aberto compativel. Responda com o numero do booking correspondente a esta montagem:', ''];",
      "  for (const c of j.candidateBookings) lines.push('- ' + c.booking + ' | Planta: ' + (c.plant || '-') + ' | Pendentes: ' + ((Number(c.qty)||0) - (Number(c.assembled)||0)) + '/' + c.qty + (c.notes ? (' | Obs: ' + c.notes) : ''));",
      "  const messageText = lines.join('\\n');",
      "  const sql = \"UPDATE photo_batches SET match_status='ambiguous', status='awaiting_booking_choice', candidate_bookings=\" + pgQuoteArray(codes) + ', updated_at=now() WHERE id=' + j.batch_id + ' RETURNING id AS batch_id, ' + pgQuote(j.group_id) + ' AS group_id, ' + pgQuote(messageText) + ' AS message_text';",
      "  out.push({ json: { sql } });",
      "}",
      "return out;",
    ],
    pos("p1", LANE_P1 + 200),
  ),
);
link(nGateAmbiguo, nMontarSqlAguardando);
const nGravarAguardando = add(pg("Gravar status aguardando", "={{ $json.sql }}", pos("p1", LANE_P1 + 200)));
link(nMontarSqlAguardando, nGravarAguardando);
const nResponderPedidoEscolha = add(
  httpNode(
    "Responder pedido de escolha no grupo",
    {
      method: "POST",
      url: SEND_TEXT_URL,
      jsonBodyExpr: "={{ JSON.stringify({ number: $json.group_id, text: $json.message_text }) }}",
      credName: "Evolution API Key",
      credId: "1",
    },
    pos("p1", LANE_P1 + 200),
  ),
);
link(nGravarAguardando, nResponderPedidoEscolha);

// === PARTE 2: finalizar lote (entrada: {batch_id}) ==========================
const LANE_P2 = 1900;
const nBuscarDadosLote = add(
  pg(
    "Buscar dados do lote e booking",
    "={{ \"SELECT pb.id AS batch_id, pb.group_id, pb.group_name, pb.sender_id, pb.sender_name, pb.container_number, pb.flex_tank_number, pb.flex_lot_no, pb.matched_booking_id, b.booking, b.loading_plant, b.carrier, b.notes, b.qty_containers, b.qty_assembled FROM photo_batches pb LEFT JOIN bookings b ON b.id = pb.matched_booking_id WHERE pb.id = \" + $json.batch_id }}",
    pos("p2", LANE_P2),
  ),
);
link(nGravarBooking, nBuscarDadosLote);
link(nGravarResolvido, nBuscarDadosLote);

const nBuscarFotosLote = add(
  pg(
    "Buscar fotos do lote",
    "={{ \"SELECT \" + $json.batch_id + \" AS batch_id, mime_type, base64_data, photo_type FROM batch_photos WHERE batch_id=\" + $json.batch_id + \" ORDER BY created_at ASC\" }}",
    pos("p2", LANE_P2),
  ),
);
link(nBuscarDadosLote, nBuscarFotosLote);

const nConsolidar = add(
  code(
    "Consolidar e preparar anexos",
    [
      "const photoRows = $input.all();",
      "const batchRows = $('Buscar dados do lote e booking').all();",
      "const batchById = new Map();",
      "for (const r of batchRows) batchById.set(r.json.batch_id, r.json);",
      "const photosByBatch = new Map();",
      "for (const r of photoRows) { const bid = r.json.batch_id; if (!photosByBatch.has(bid)) photosByBatch.set(bid, []); photosByBatch.get(bid).push(r.json); }",
      "function extFor(mime) { if (!mime) return 'jpg'; if (mime.includes('png')) return 'png'; if (mime.includes('webp')) return 'webp'; if (mime.includes('gif')) return 'gif'; return 'jpg'; }",
      "const out = [];",
      "for (const [batchId, photos] of photosByBatch) {",
      "  const batch = batchById.get(batchId) || {};",
      "  const binary = {}; let idx = 1;",
      "  for (const p of photos) { binary['attachment' + idx] = { data: p.base64_data, mimeType: p.mime_type, fileName: idx + '-' + (p.photo_type || 'foto') + '.' + extFor(p.mime_type) }; idx++; }",
      "  out.push({ json: {",
      "    batchId, groupId: batch.group_id, groupName: batch.group_name, senderName: batch.sender_name,",
      "    containerNumber: batch.container_number, flexTankNumber: batch.flex_tank_number, flexLotNo: batch.flex_lot_no,",
      "    matchedBookingId: batch.matched_booking_id, booking: batch.booking, loadingPlant: batch.loading_plant, carrier: batch.carrier, notes: batch.notes,",
      "    qtyContainers: batch.qty_containers, qtyAssembled: batch.qty_assembled,",
      "  }, binary });",
      "}",
      "return out;",
    ],
    pos("p2", LANE_P2),
  ),
);
link(nBuscarFotosLote, nConsolidar);

const nEmail = add(emailNode("Enviar e-mail com fotos", pos("p2", LANE_P2)));
link(nConsolidar, nEmail);

const nMontarMensagemGrupo = add(
  code(
    "Montar mensagem do grupo",
    [
      `const RESPONSIBLES = ${JSON.stringify(cfg.responsibles)};`,
      "const items = $input.all();",
      "const out = [];",
      "for (const item of items) {",
      "  const j = item.json;",
      "  const lines = [];",
      "  lines.push('\\uD83D\\uDCE6 *Operacao registrada*');",
      "  lines.push('Container: *' + (j.containerNumber || 'NAO IDENTIFICADO') + '*');",
      "  lines.push('Flex tanque: *' + (j.flexTankNumber || 'NAO IDENTIFICADO') + '*' + (j.flexLotNo ? (' (Lot No: ' + j.flexLotNo + ')') : ''));",
      "  if (j.booking) {",
      "    lines.push('Booking: *' + j.booking + '* - Planta: ' + (j.loadingPlant || '-') + ' - Armador: ' + (j.carrier || '-'));",
      "    const assembledNow = (Number(j.qtyAssembled)||0) + 1;",
      "    lines.push('Progresso: ' + assembledNow + ' de ' + (j.qtyContainers || '?') + ' montados.');",
      "    if (j.notes) lines.push('Obs: ' + j.notes);",
      "  } else {",
      "    lines.push('Booking: NAO LOCALIZADO - favor confirmar manualmente.');",
      "  }",
      "  lines.push('');",
      "  lines.push('Fotos enviadas por e-mail para conferencia.');",
      "  if (RESPONSIBLES.length) { lines.push(''); lines.push(RESPONSIBLES.map(function(r){ return '@' + r.phone; }).join(' ')); }",
      "  out.push({ json: { groupId: j.groupId, text: lines.join('\\n'), mentioned: RESPONSIBLES.map(function(r){ return r.phone; }), matchedBookingId: j.matchedBookingId, batchId: j.batchId, containerNumber: j.containerNumber, flexTankNumber: j.flexTankNumber } });",
      "}",
      "return out;",
    ],
    pos("p2", LANE_P2),
  ),
);
link(nConsolidar, nMontarMensagemGrupo);

const nResponderGrupo = add(
  httpNode(
    "Responder no grupo",
    {
      method: "POST",
      url: SEND_TEXT_URL,
      jsonBodyExpr: "={{ JSON.stringify({ number: $json.groupId, text: $json.text, mentioned: $json.mentioned }) }}",
      credName: "Evolution API Key",
      credId: "1",
    },
    pos("p2", LANE_P2),
  ),
);
link(nMontarMensagemGrupo, nResponderGrupo);

const nMontarSqlFinalizar = add(
  code(
    "Montar SQL - progresso e conclusao",
    [
      HELPER_PRELUDE,
      "const items = $input.all();",
      "const out = [];",
      "for (const item of items) {",
      "  const j = item.json;",
      "  const sqlBooking = j.matchedBookingId ?",
      "    ('UPDATE bookings SET qty_assembled = qty_assembled + 1, status = CASE WHEN qty_assembled + 1 >= qty_containers THEN \\'completed\\' ELSE \\'open\\' END, updated_at = now() WHERE id = ' + j.matchedBookingId) :",
      "    'SELECT 1';",
      "  const sqlBatch = 'UPDATE photo_batches SET status=' + pgQuote('done') + ', container_number=' + pgQuote(j.containerNumber) + ', flex_tank_number=' + pgQuote(j.flexTankNumber) + ', updated_at=now() WHERE id=' + j.batchId;",
      "  out.push({ json: { sqlBooking, sqlBatch } });",
      "}",
      "return out;",
    ],
    pos("p2", LANE_P2),
  ),
);
link(nMontarMensagemGrupo, nMontarSqlFinalizar);

const nAtualizarProgresso = add(pg("Atualizar progresso do booking", "={{ $json.sqlBooking }}", pos("p2", LANE_P2 + 150)));
const nMarcarConcluido = add(pg("Marcar lote como concluido", "={{ $json.sqlBatch }}", pos("p2", LANE_P2 + 300)));
link(nMontarSqlFinalizar, nAtualizarProgresso);
link(nMontarSqlFinalizar, nMarcarConcluido);

// ---------------------------------------------------------------------------
// Monta o workflow final e grava em disco
// ---------------------------------------------------------------------------
const workflow = {
  name: "Agente CTA - WhatsApp (Programacao + Flex Tanque)",
  nodes,
  connections,
  active: false,
  settings: { executionOrder: "v1" },
  pinData: {},
};

mkdirSync(path.join(ROOT, "workflows"), { recursive: true });
writeFileSync(path.join(ROOT, "workflows/agente-cta.json"), JSON.stringify(workflow, null, 2) + "\n", "utf-8");

console.log(`OK: ${nodes.length} nodes gerados em workflows/agente-cta.json`);
