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
// Helper JS embutido no Code node que monta o PDF-resumo COM as fotos
// embutidas (sem depender de nenhuma lib externa - o Code node do n8n nao
// tem acesso garantido a npm packages arbitrarios). Gera um PDF multi-pagina
// (1a pagina com o resumo em texto, depois 1 pagina por foto, imagem JPEG
// embutida via DCTDecode + legenda), fonte Helvetica com WinAnsiEncoding
// (cobre acentos comuns do portugues). A logica foi prototipada e validada
// localmente com pdf-parse (extracao de texto, contagem de paginas e
// re-decodificacao da imagem embutida byte a byte) antes de ser embutida
// aqui.
// ---------------------------------------------------------------------------
const HELPER_PDF = [
  "function toLatin1(str) { let o=''; for (const ch of String(str)) { const c = ch.codePointAt(0); o += c<=255?ch:'?'; } return o; }",
  "function escapePdfString(str) { return str.replace(/\\\\/g,'\\\\\\\\').replace(/\\(/g,'\\\\(').replace(/\\)/g,'\\\\)'); }",
  "function getJpegSize(buf) {",
  "  let offset = 2;",
  "  while (offset < buf.length - 1) {",
  "    if (buf[offset] !== 0xff) { offset++; continue; }",
  "    const marker = buf[offset+1];",
  "    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }",
  "    if (marker === 0xd9 || offset+3 >= buf.length) break;",
  "    const segLen = buf.readUInt16BE(offset+2);",
  "    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;",
  "    if (isSof) { const height = buf.readUInt16BE(offset+5); const width = buf.readUInt16BE(offset+7); return { width, height }; }",
  "    offset += 2 + segLen;",
  "  }",
  "  return { width: 800, height: 600 };",
  "}",
  "function buildOperationPdf(title, summaryLines, photos) {",
  "  const PAGE_W = 595, PAGE_H = 842, MARGIN = 50;",
  "  const objs = [];",
  "  function push(dict, streamBinaryString) { objs.push({ dict, stream: streamBinaryString === undefined ? null : streamBinaryString }); return objs.length; }",
  "  const kids = [4];",
  "  for (let i = 0; i < photos.length; i++) kids.push(7 + 3*i);",
  "  push('<< /Type /Catalog /Pages 2 0 R >>');",
  "  push('<< /Type /Pages /Kids [' + kids.map(function(k){ return k + ' 0 R'; }).join(' ') + '] /Count ' + kids.length + ' >>');",
  "  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');",
  "  const titleSafe = escapePdfString(toLatin1(title));",
  "  const lineOps = summaryLines.map(function(l){ return '(' + escapePdfString(toLatin1(l)) + ') Tj T*'; }).join('\\n');",
  "  const summaryContent = 'BT /F1 14 Tf ' + MARGIN + ' 780 Td (' + titleSafe + ') Tj ET\\n' + 'BT /F1 11 Tf ' + MARGIN + ' 750 Td 16 TL\\n' + lineOps + '\\nET';",
  "  push('<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] /Contents 5 0 R >>');",
  "  push('<< /Length ' + summaryContent.length + ' >>', summaryContent);",
  "  const maxW = PAGE_W - MARGIN*2;",
  "  const maxH = PAGE_H - 120;",
  "  for (const photo of photos) {",
  "    const size = getJpegSize(photo.buffer);",
  "    const aspect = size.width / size.height;",
  "    let drawW = maxW, drawH = maxW / aspect;",
  "    if (drawH > maxH) { drawH = maxH; drawW = maxH * aspect; }",
  "    const x = MARGIN + (maxW - drawW) / 2;",
  "    const y = 40 + (maxH - drawH) / 2;",
  "    const imgId = push('<< /Type /XObject /Subtype /Image /Width ' + size.width + ' /Height ' + size.height + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + photo.buffer.length + ' >>', photo.buffer.toString('latin1'));",
  "    const captionSafe = escapePdfString(toLatin1(photo.label || ''));",
  "    const pageContent = 'BT /F1 13 Tf ' + MARGIN + ' 810 Td (' + captionSafe + ') Tj ET\\n' + 'q ' + drawW.toFixed(2) + ' 0 0 ' + drawH.toFixed(2) + ' ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' cm /Im1 Do Q';",
  "    push('<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 ' + imgId + ' 0 R >> >> /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] /Contents ' + (imgId+2) + ' 0 R >>');",
  "    push('<< /Length ' + pageContent.length + ' >>', pageContent);",
  "  }",
  "  let pdf = '%PDF-1.4\\n';",
  "  const offsets = [0];",
  "  objs.forEach(function(obj, i) {",
  "    offsets.push(pdf.length);",
  "    pdf += (i+1) + ' 0 obj\\n' + obj.dict + '\\n';",
  "    if (obj.stream !== null) pdf += 'stream\\n' + obj.stream + '\\nendstream\\n';",
  "    pdf += 'endobj\\n';",
  "  });",
  "  const xrefOffset = pdf.length;",
  "  const total = objs.length + 1;",
  "  pdf += 'xref\\n0 ' + total + '\\n0000000000 65535 f \\n';",
  "  for (let i=1;i<total;i++) pdf += String(offsets[i]).padStart(10,'0') + ' 00000 n \\n';",
  "  pdf += 'trailer\\n<< /Size ' + total + ' /Root 1 0 R >>\\nstartxref\\n' + xrefOffset + '\\n%%EOF';",
  "  return Buffer.from(pdf, 'latin1');",
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

const PHOTO_TYPE_LABELS = {
  etiqueta: "Etiqueta",
  porta: "Porta do container",
  interna_vazia: "Interna (vazia)",
  interna_flex: "Interna (flex montado)",
  trava: "Trava/anteparo",
  geral: "Foto geral",
  desconhecida: "Nao identificada",
};

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

function httpNode(name, { method, url, jsonBodyExpr, credName, credId, notes, extraHeaders }, position) {
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
      headerParameters: {
        parameters: [{ name: "Content-Type", value: "application/json" }, ...(extraHeaders || [])],
      },
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

// A montagem do corpo da requisicao para a Anthropic fica num Code node (JS
// de verdade), nao numa expressao "={{ }}" do HTTP Request node - o motor de
// expressoes do n8n e um mini-parser restrito e nao lida bem com um
// JSON.stringify(...) tao grande/aninhado (produz "invalid syntax" em tempo
// de execucao mesmo quando a sintaxe JS pura e valida). Code node nao tem
// essa limitacao.
const anthropicBodyCodeLines = [
  `const MODEL = ${JSON.stringify(cfg.anthropic.model)};`,
  `const SYSTEM_PROMPT_TEXT = ${JSON.stringify(SYSTEM_PROMPT)};`,
  `const TOOLS = ${JSON.stringify([TOOL_SCHEMA])};`,
  "const items = $input.all();",
  "const out = [];",
  "for (const item of items) {",
  "  const j = item.json;",
  "  const body = {",
  "    model: MODEL,",
  "    max_tokens: 4096,",
  "    system: SYSTEM_PROMPT_TEXT,",
  "    tools: TOOLS,",
  '    tool_choice: { type: "tool", name: "report_incoming_image" },',
  "    messages: [{",
  '      role: "user",',
  "      content: [",
  '        { type: "image", source: { type: "base64", media_type: j.mimetype || "image/jpeg", data: j.base64 } },',
  '        { type: "text", text: "Analise esta imagem conforme as instrucoes." },',
  "      ],",
  "    }],",
  "  };",
  "  out.push({ json: { ...j, anthropicBody: JSON.stringify(body) } });",
  "}",
  "return out;",
];

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

const nMontarCorpoVision = add(code("Montar corpo da requisicao Vision", anthropicBodyCodeLines, pos("t1", LANE_T1)));
link(nBuscarBase64, nMontarCorpoVision);

const nVision = add(
  httpNode(
    "Vision - Classificar imagem",
    {
      method: "POST",
      url: ANTHROPIC_URL,
      jsonBodyExpr: "={{ $json.anthropicBody }}",
      credName: "Anthropic API Key",
      credId: "2",
      extraHeaders: [{ name: "anthropic-version", value: "2023-06-01" }],
    },
    pos("t1", LANE_T1),
  ),
);
link(nMontarCorpoVision, nVision);

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
      "      \") ON CONFLICT (booking) DO UPDATE SET group_id=EXCLUDED.group_id, received_at=EXCLUDED.received_at, qty_containers=EXCLUDED.qty_containers, loading_date=EXCLUDED.loading_date, flex_assembly_date=EXCLUDED.flex_assembly_date, empty_pickup_date=EXCLUDED.empty_pickup_date, loading_plant=EXCLUDED.loading_plant, carrier=EXCLUDED.carrier, notes=EXCLUDED.notes, updated_at=now() RETURNING booking, loading_plant, qty_containers, (xmax = 0) AS inserted, \" + pgQuote(j.groupId) + \" AS group_id\";",
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
      "const isNew = function(i){ return i.json.inserted === true || i.json.inserted === 't'; };",
      "const newItems = items.filter(isNew);",
      "const repeatedItems = items.filter(function(i){ return !isNew(i); });",
      "const groupId = items[0].json.group_id;",
      "const lines = [];",
      "lines.push('Programacao atualizada: ' + items.length + ' booking(s) (' + newItems.length + ' novo(s), ' + repeatedItems.length + ' repetido(s)/atualizado(s)).');",
      "lines.push('');",
      "if (newItems.length) {",
      "  lines.push('Novos:');",
      "  for (const item of newItems) {",
      "    const j = item.json;",
      "    lines.push('- ' + j.booking + ' | Planta: ' + (j.loading_plant || '-') + ' | Qtd a montar: ' + (j.qty_containers != null ? j.qty_containers : '?'));",
      "  }",
      "  lines.push('');",
      "}",
      "if (repeatedItems.length) {",
      "  lines.push('AVISO - ja existiam na base (dados foram atualizados):');",
      "  for (const item of repeatedItems) {",
      "    const j = item.json;",
      "    lines.push('- ' + j.booking + ' | Planta: ' + (j.loading_plant || '-') + ' | Qtd a montar: ' + (j.qty_containers != null ? j.qty_containers : '?'));",
      "  }",
      "}",
      "const text = lines.join('\\n');",
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
      "  const lines = ['\\uD83D\\uDD00 *Varios bookings em aberto compativeis*', 'Responda com o *numero do booking* desta montagem:', ''];",
      "  for (const c of j.candidateBookings) {",
      "    const pendentes = (Number(c.qty)||0) - (Number(c.assembled)||0);",
      "    lines.push('\\uD83D\\uDCE6 *' + c.booking + '*');",
      "    lines.push('     \\uD83C\\uDFED ' + (c.plant || '-'));",
      "    lines.push('     \\uD83D\\uDD22 Pendentes: ' + pendentes + '/' + c.qty);",
      "    if (c.notes) lines.push('     \\uD83D\\uDCDD ' + c.notes);",
      "    lines.push('');",
      "  }",
      "  if (lines[lines.length - 1] === '') lines.pop();",
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
      `const PHOTO_LABELS = ${JSON.stringify(PHOTO_TYPE_LABELS)};`,
      "const out = [];",
      "for (const [batchId, photos] of photosByBatch) {",
      "  const batch = batchById.get(batchId) || {};",
      "  const binary = {}; const photoLabels = {}; let idx = 1;",
      "  for (const p of photos) {",
      "    const key = 'attachment' + idx;",
      "    binary[key] = { data: p.base64_data, mimeType: p.mime_type, fileName: idx + '-' + (p.photo_type || 'foto') + '.' + extFor(p.mime_type) };",
      "    photoLabels[key] = PHOTO_LABELS[p.photo_type] || (p.photo_type || 'Foto');",
      "    idx++;",
      "  }",
      "  out.push({ json: {",
      "    batchId, groupId: batch.group_id, groupName: batch.group_name, senderName: batch.sender_name,",
      "    containerNumber: batch.container_number, flexTankNumber: batch.flex_tank_number, flexLotNo: batch.flex_lot_no,",
      "    matchedBookingId: batch.matched_booking_id, booking: batch.booking, loadingPlant: batch.loading_plant, carrier: batch.carrier, notes: batch.notes,",
      "    qtyContainers: batch.qty_containers, qtyAssembled: batch.qty_assembled, photoLabels,",
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

// --- PDF-resumo enviado por WhatsApp para numeros parametrizados -----------
const nMontarPdf = add(
  code(
    "Montar PDF do relatorio",
    [
      HELPER_PDF,
      "const items = $input.all();",
      "const out = [];",
      "for (const item of items) {",
      "  const j = item.json;",
      "  const lines = [];",
      "  lines.push('Container: ' + (j.containerNumber || 'NAO IDENTIFICADO'));",
      "  lines.push('Flex tanque: ' + (j.flexTankNumber || 'NAO IDENTIFICADO') + (j.flexLotNo ? (' (Lot No: ' + j.flexLotNo + ')') : ''));",
      "  if (j.booking) {",
      "    lines.push('Booking: ' + j.booking + ' - Planta: ' + (j.loadingPlant || '-') + ' - Armador: ' + (j.carrier || '-'));",
      "    lines.push('Progresso: ' + ((Number(j.qtyAssembled)||0)+1) + ' de ' + (j.qtyContainers || '?') + ' montados.');",
      "    if (j.notes) lines.push('Obs: ' + j.notes);",
      "  } else {",
      "    lines.push('Booking: NAO LOCALIZADO - favor confirmar manualmente.');",
      "  }",
      "  lines.push('Grupo: ' + (j.groupName || j.groupId));",
      "  lines.push('Enviado por: ' + (j.senderName || '-'));",
      "  lines.push('Data/hora: ' + new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }));",
      "  const binary = item.binary || {};",
      "  const photoLabels = j.photoLabels || {};",
      "  const photos = [];",
      "  const skipped = [];",
      "  for (const key of Object.keys(binary)) {",
      "    const b = binary[key];",
      "    const label = photoLabels[key] || 'Foto';",
      "    if (b.mimeType && b.mimeType.indexOf('jpeg') === -1 && b.mimeType.indexOf('jpg') === -1) { skipped.push(label); continue; }",
      "    photos.push({ label, buffer: Buffer.from(b.data, 'base64') });",
      "  }",
      "  if (skipped.length) lines.push('(Nao incluidas no PDF - formato nao suportado: ' + skipped.join(', ') + ')');",
      "  const pdfBuffer = buildOperationPdf('Relatorio de Operacao - Flex Tanque', lines, photos);",
      "  out.push({ json: { ...j, pdfBase64: pdfBuffer.toString('base64') } });",
      "}",
      "return out;",
    ],
    pos("p2", LANE_P2),
  ),
);
link(nConsolidar, nMontarPdf);

const nExpandirDestinatariosPdf = add(
  code(
    "Montar lista de envio do PDF",
    [
      `const PDF_RECIPIENTS = ${JSON.stringify((cfg.pdfRecipients && cfg.pdfRecipients.numbers) || [])};`,
      "const items = $input.all();",
      "const out = [];",
      "for (const item of items) {",
      "  const j = item.json;",
      "  for (const phone of PDF_RECIPIENTS) {",
      "    out.push({ json: { phone, pdfBase64: j.pdfBase64, containerNumber: j.containerNumber, flexTankNumber: j.flexTankNumber } });",
      "  }",
      "}",
      "return out;",
    ],
    pos("p2", LANE_P2),
  ),
);
link(nMontarPdf, nExpandirDestinatariosPdf);

const nEnviarPdf = add(
  httpNode(
    "Enviar PDF por WhatsApp",
    {
      method: "POST",
      url: `${EVOLUTION_URL}/message/sendMedia/${EVOLUTION_INSTANCE}`,
      jsonBodyExpr:
        "={{ JSON.stringify({ number: $json.phone, mediatype: 'document', mimetype: 'application/pdf', fileName: 'relatorio-' + ($json.containerNumber || 'operacao') + '.pdf', media: $json.pdfBase64, caption: 'Relatorio da operacao - Container ' + ($json.containerNumber || 'N/D') + ' / Flex ' + ($json.flexTankNumber || 'N/D') }) }}",
      credName: "Evolution API Key",
      credId: "1",
      notes: "Endpoint/campos de envio de midia variam entre versoes da Evolution API - confira no /docs da sua instancia.",
    },
    pos("p2", LANE_P2),
  ),
);
link(nExpandirDestinatariosPdf, nEnviarPdf);

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
