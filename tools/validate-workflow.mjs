#!/usr/bin/env node
/**
 * Validacoes estaticas do workflow gerado (nao substitui testar no n8n de
 * verdade, mas pega uma classe grande de erros de geracao):
 *   - JSON valido
 *   - nomes de node unicos
 *   - toda conexao aponta para um node que existe
 *   - todo node tem os campos obrigatorios
 *   - todo Code node tem jsCode sintaticamente valido (via `new Function`)
 *   - toda referencia $('Nome do Node') dentro de um Code node aponta para
 *     um node que existe no workflow
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const file = path.join(ROOT, "workflows/agente-cta.json");

let workflow;
try {
  workflow = JSON.parse(readFileSync(file, "utf-8"));
} catch (err) {
  console.error(`FALHA: ${file} nao e um JSON valido: ${err.message}`);
  process.exit(1);
}

const errors = [];
const warnings = [];

const nodeNames = new Set();
for (const node of workflow.nodes) {
  for (const field of ["id", "name", "type", "typeVersion", "position", "parameters"]) {
    if (node[field] === undefined) errors.push(`Node "${node.name || node.id}" sem campo obrigatorio "${field}"`);
  }
  if (nodeNames.has(node.name)) errors.push(`Nome de node duplicado: "${node.name}"`);
  nodeNames.add(node.name);
}

for (const [fromName, def] of Object.entries(workflow.connections)) {
  if (!nodeNames.has(fromName)) errors.push(`Conexao parte de node inexistente: "${fromName}"`);
  for (const output of def.main || []) {
    for (const target of output || []) {
      if (!nodeNames.has(target.node)) {
        errors.push(`Conexao de "${fromName}" aponta para node inexistente: "${target.node}"`);
      }
    }
  }
}

const backRefPattern = /\$\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
for (const node of workflow.nodes) {
  if (node.type !== "n8n-nodes-base.code") continue;
  const jsCode = node.parameters && node.parameters.jsCode;
  if (typeof jsCode !== "string") {
    errors.push(`Code node "${node.name}" sem parameters.jsCode`);
    continue;
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function(jsCode);
  } catch (err) {
    errors.push(`Code node "${node.name}" tem jsCode invalido: ${err.message}`);
  }
  let m;
  while ((m = backRefPattern.exec(jsCode))) {
    const referenced = m[2];
    if (!nodeNames.has(referenced)) {
      errors.push(`Code node "${node.name}" referencia $('${referenced}') que nao existe no workflow`);
    }
  }
}

// Verifica a sintaxe JS de toda expressao "={{ ... }}" encontrada em qualquer
// parametro string de qualquer node (HTTP Request, Postgres, Email, etc.),
// nao so em Code nodes. Fornece stubs para $json/$input/$binary/$('Node')/$now
// para permitir o parse; nao executa a expressao de verdade (so checa sintaxe).
function collectExpressionStrings(value, out) {
  if (typeof value === "string") {
    if (value.startsWith("={{") && value.endsWith("}}")) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectExpressionStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectExpressionStrings(v, out);
  }
}

const STUB_PRELUDE = [
  "const $json = new Proxy({}, { get: () => ({}) });",
  "const $binary = {};",
  "const $input = { first: () => ({ json: {} }), all: () => [], item: { json: {} } };",
  "const $ = (name) => ({ first: () => ({ json: {} }), all: () => [], item: { json: {} } });",
  "const $now = 0;",
].join("\n");

for (const node of workflow.nodes) {
  const exprs = [];
  collectExpressionStrings(node.parameters, exprs);
  for (const expr of exprs) {
    const inner = expr.slice(3, -2);
    try {
      // eslint-disable-next-line no-new-func
      new Function(STUB_PRELUDE + "\nreturn (" + inner + ");");
    } catch (err) {
      errors.push(`Node "${node.name}" tem expressao com sintaxe invalida: ${err.message} :: ${expr.slice(0, 120)}...`);
    }
  }
}

// Todo node (exceto triggers) deveria ser alcancavel a partir de algum trigger.
const TRIGGER_TYPES = new Set(["n8n-nodes-base.webhook", "n8n-nodes-base.scheduleTrigger"]);
const reachable = new Set();
const queue = workflow.nodes.filter((n) => TRIGGER_TYPES.has(n.type)).map((n) => n.name);
for (const name of queue) reachable.add(name);
while (queue.length) {
  const current = queue.shift();
  const def = workflow.connections[current];
  if (!def) continue;
  for (const output of def.main || []) {
    for (const target of output || []) {
      if (!reachable.has(target.node)) {
        reachable.add(target.node);
        queue.push(target.node);
      }
    }
  }
}
for (const node of workflow.nodes) {
  if (!reachable.has(node.name)) warnings.push(`Node "${node.name}" nao e alcancavel a partir de nenhum trigger`);
}

console.log(`Nodes: ${workflow.nodes.length}`);
console.log(`Alcancaveis a partir de triggers: ${reachable.size}`);

if (warnings.length) {
  console.log("\nAvisos:");
  for (const w of warnings) console.log(`  - ${w}`);
}

if (errors.length) {
  console.log("\nErros:");
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}

console.log("\nOK: nenhum erro estrutural encontrado.");
