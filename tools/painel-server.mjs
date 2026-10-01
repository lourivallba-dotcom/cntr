#!/usr/bin/env node
/**
 * Painel web local para editar tools/config.json e gerar o workflow,
 * sem precisar mexer no JSON na mao nem rodar comando nenhum.
 *
 * Uso:
 *   node tools/painel-server.mjs
 *   abra http://localhost:4000
 *
 * Sem dependencias externas (so modulos nativos do Node). Nao expoe
 * isso na internet sem proteger com senha/VPN - ele le e escreve
 * tools/config.json e roda o gerador do workflow no mesmo servidor.
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "tools/config.json");
const CONFIG_EXAMPLE_PATH = path.join(ROOT, "tools/config.example.json");
const GENERATOR_PATH = path.join(ROOT, "tools/generate-workflows.mjs");
const WORKFLOW_PATH = path.join(ROOT, "workflows/agente-cta.json");
const HTML_PATH = path.join(__dirname, "painel.html");

const PORT = process.env.PAINEL_PORT || 4000;

function loadConfig() {
  const p = existsSync(CONFIG_PATH) ? CONFIG_PATH : CONFIG_EXAMPLE_PATH;
  return JSON.parse(readFileSync(p, "utf-8"));
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function validateConfig(cfg) {
  const errors = [];
  if (!cfg.evolution || typeof cfg.evolution.baseUrl !== "string" || !cfg.evolution.baseUrl) errors.push("evolution.baseUrl e obrigatorio.");
  if (!cfg.evolution || typeof cfg.evolution.instance !== "string" || !cfg.evolution.instance) errors.push("evolution.instance e obrigatorio.");
  if (!cfg.whatsapp || !Array.isArray(cfg.whatsapp.allowedGroupIds)) errors.push("whatsapp.allowedGroupIds precisa ser uma lista.");
  if (!cfg.batch || !Number.isFinite(Number(cfg.batch.expectedPhotos)) || Number(cfg.batch.expectedPhotos) < 1) errors.push("batch.expectedPhotos precisa ser um numero >= 1.");
  if (!cfg.batch || !Number.isFinite(Number(cfg.batch.windowSeconds)) || Number(cfg.batch.windowSeconds) < 1) errors.push("batch.windowSeconds precisa ser um numero >= 1.");
  if (!cfg.batch || !Number.isFinite(Number(cfg.batch.sweepIntervalMinutes)) || Number(cfg.batch.sweepIntervalMinutes) < 1) errors.push("batch.sweepIntervalMinutes precisa ser um numero >= 1.");
  if (!cfg.email || !Array.isArray(cfg.email.to) || !cfg.email.to.length) errors.push("email.to precisa ter pelo menos 1 destinatario.");
  if (!Array.isArray(cfg.responsibles)) errors.push("responsibles precisa ser uma lista.");
  for (const r of cfg.responsibles || []) {
    if (!r.name || !r.phone) errors.push("Cada responsavel precisa de nome e telefone.");
    if (r.phone && !/^\d{10,15}$/.test(String(r.phone))) errors.push(`Telefone invalido: "${r.phone}" (so digitos, DDI+DDD+numero).`);
  }
  if (!cfg.pdfRecipients || !Array.isArray(cfg.pdfRecipients.numbers)) errors.push("pdfRecipients.numbers precisa ser uma lista.");
  for (const n of (cfg.pdfRecipients && cfg.pdfRecipients.numbers) || []) {
    if (!/^\d{10,15}$/.test(String(n))) errors.push(`Numero de PDF invalido: "${n}" (so digitos, DDI+DDD+numero).`);
  }
  return errors;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      const html = readFileSync(HTML_PATH, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      sendJson(res, 200, loadConfig());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/config") {
      const body = await readBody(req);
      let cfg;
      try {
        cfg = JSON.parse(body);
      } catch {
        sendJson(res, 400, { ok: false, errors: ["JSON invalido recebido do formulario."] });
        return;
      }
      const errors = validateConfig(cfg);
      if (errors.length) {
        sendJson(res, 400, { ok: false, errors });
        return;
      }
      cfg._comment = "Editado via painel web (tools/painel-server.mjs). Segredos (API keys) nao vao aqui - continuam configurados dentro do n8n.";
      writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/generate") {
      execFile(process.execPath, [GENERATOR_PATH], { cwd: ROOT, timeout: 30_000 }, (err, stdout, stderr) => {
        if (err) {
          sendJson(res, 500, { ok: false, output: (stdout || "") + (stderr || "") || err.message });
          return;
        }
        sendJson(res, 200, { ok: true, output: stdout });
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workflow") {
      if (!existsSync(WORKFLOW_PATH)) {
        sendJson(res, 404, { ok: false, errors: ["Ainda nao foi gerado nenhum workflow - clique em Gerar primeiro."] });
        return;
      }
      const data = readFileSync(WORKFLOW_PATH);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": "attachment; filename=agente-cta.json",
        "Content-Length": data.length,
      });
      res.end(data);
      return;
    }

    sendJson(res, 404, { ok: false, errors: ["Rota nao encontrada."] });
  } catch (e) {
    sendJson(res, 500, { ok: false, errors: [String((e && e.message) || e)] });
  }
});

server.listen(PORT, () => {
  console.log(`Painel disponivel em http://localhost:${PORT}`);
});
