'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const config = require('./src/config');
const { abrir } = require('./src/db');
const { criarAuth } = require('./src/auth');
const { criarMailer } = require('./src/mailer');
const { criarRotas } = require('./src/rotas');
const { POR_UF, bandeiraUrl } = require('./src/estados');

const PUBLIC = path.join(__dirname, 'public');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function criarApp({ dbPath = config.dbPath } = {}) {
  const db = abrir(dbPath);
  const mailer = criarMailer(db);
  const auth = criarAuth(db);
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
      'Content-Security-Policy': [
        "default-src 'self'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    });
    next();
  });

  // Rejeita POST/DELETE vindos de outros sites (além do SameSite=Lax do cookie).
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origem = req.headers.origin;
    if (origem && origem !== config.baseUrl && origem !== `${req.protocol}://${req.get('host')}`) {
      return res.status(403).json({ erro: 'Origem não permitida.' });
    }
    next();
  });

  app.use(auth.carregarUsuario);
  app.use(auth.router);
  app.use(criarRotas({ db, mailer, auth }));

  app.use('/uploads/videos', express.static(path.join(config.uploadsDir, 'videos'), {
    maxAge: '7d',
    setHeaders: (res) => res.set('Content-Disposition', 'inline'),
  }));
  app.use(express.static(PUBLIC, { index: false, maxAge: config.producao ? '1h' : 0 }));

  // SPA: qualquer outra rota GET devolve o index.html. Para /e/:id injeta
  // as meta tags Open Graph, para a prévia ficar bonita no WhatsApp/Facebook/X.
  const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const manifPorId = db.prepare("SELECT id, titulo, descricao, uf, tipo, video FROM manifestacoes WHERE id = ? AND status = 'publicada'");

  app.get(/^\/(?!api\/|auth\/|uploads\/).*/, (req, res) => {
    let meta = {
      titulo: `${config.nomeSite} — o Reclame Aqui dos políticos`,
      descricao: 'Crie enquetes e abaixo-assinados para deputados, senadores e governadores do seu estado e cobre uma resposta pública.',
      imagem: `${config.baseUrl}/img/og.png`,
      url: `${config.baseUrl}${req.path}`,
      video: null,
    };
    const m = req.path.match(/^\/e\/([A-Za-z0-9]{6,20})$/);
    if (m) {
      const row = manifPorId.get(m[1]);
      if (row) {
        const tipo = row.tipo === 'abaixo_assinado' ? 'Abaixo-assinado' : 'Enquete';
        meta = {
          titulo: `${tipo} (${POR_UF[row.uf].nome}): ${row.titulo}`,
          descricao: row.descricao.slice(0, 200),
          imagem: bandeiraUrl(row.uf, 1200),
          url: `${config.baseUrl}/e/${row.id}`,
          video: row.video ? `${config.baseUrl}/uploads/videos/${row.video}` : null,
        };
      }
    }
    const tags = [
      `<title>${esc(meta.titulo)}</title>`,
      `<meta name="description" content="${esc(meta.descricao)}">`,
      `<meta property="og:site_name" content="${esc(config.nomeSite)}">`,
      `<meta property="og:type" content="${meta.video ? 'video.other' : 'website'}">`,
      `<meta property="og:title" content="${esc(meta.titulo)}">`,
      `<meta property="og:description" content="${esc(meta.descricao)}">`,
      `<meta property="og:image" content="${esc(meta.imagem)}">`,
      `<meta property="og:url" content="${esc(meta.url)}">`,
      meta.video ? `<meta property="og:video" content="${esc(meta.video)}">` : '',
      '<meta name="twitter:card" content="summary_large_image">',
    ].filter(Boolean).join('\n    ');
    res.type('html').set('Cache-Control', 'no-cache').send(indexHtml.replace('<!--META-->', tags));
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ erro: 'Erro interno.' });
  });

  app.locals.db = db;
  return app;
}

if (require.main === module) {
  const app = criarApp();
  app.listen(config.porta, () => {
    console.log(`${config.nomeSite} em ${config.baseUrl}`);
    if (config.dadosOffline) console.log('ATENÇÃO: DADOS_OFFLINE=1 — usando políticos FICTÍCIOS.');
    if (!config.smtp.url) console.log('SMTP_URL não configurado: e-mails serão apenas registrados (simulados).');
  });
}

module.exports = { criarApp };
