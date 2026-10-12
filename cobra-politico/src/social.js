'use strict';

// Divulgação automática nos perfis oficiais do site: dispara um webhook
// (n8n, Make, Zapier…) que faz o post no Instagram/Facebook/X/etc.
const config = require('./config');

async function divulgar(evento, dados) {
  if (!config.socialWebhookUrl) return false;
  try {
    const resp = await fetch(config.socialWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.socialWebhookToken ? { Authorization: `Bearer ${config.socialWebhookToken}` } : {}),
      },
      body: JSON.stringify({ evento, ...dados }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return true;
  } catch (e) {
    console.warn(`[social] webhook falhou (${evento}): ${e.message}`);
    return false;
  }
}

module.exports = { divulgar };
