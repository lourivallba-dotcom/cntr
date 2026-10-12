'use strict';

// Login social (Google, Facebook, Instagram) via OAuth 2.0 "authorization code",
// implementado direto com fetch, e sessões guardadas no SQLite.

const crypto = require('node:crypto');
const express = require('express');
const config = require('./config');

const SESSAO_DIAS = 30;
const COOKIE_SESSAO = 'cp_sid';
const COOKIE_ESTADO = 'cp_oauth';

const PROVEDORES = {
  google: {
    nome: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'openid email profile',
    async perfil(code, cred, redirectUri) {
      const token = await postForm('https://oauth2.googleapis.com/token', {
        code,
        client_id: cred.clientId,
        client_secret: cred.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
      const u = await getJson('https://openidconnect.googleapis.com/v1/userinfo', token.access_token);
      return { id: u.sub, nome: u.name || u.email, email: u.email_verified ? u.email : null, avatar: u.picture };
    },
  },
  facebook: {
    nome: 'Facebook',
    authorize: 'https://www.facebook.com/v21.0/dialog/oauth',
    scope: 'public_profile,email',
    async perfil(code, cred, redirectUri) {
      const q = new URLSearchParams({
        client_id: cred.clientId,
        client_secret: cred.clientSecret,
        redirect_uri: redirectUri,
        code,
      });
      const token = await getJson(`https://graph.facebook.com/v21.0/oauth/access_token?${q}`);
      const u = await getJson(
        `https://graph.facebook.com/v21.0/me?fields=id,name,email,picture.type(large)&access_token=${encodeURIComponent(token.access_token)}`,
      );
      return { id: u.id, nome: u.name, email: u.email || null, avatar: u.picture?.data?.url };
    },
  },
  // "Instagram API with Instagram Login" (a Basic Display API foi desligada em 2024).
  // Só funciona com contas profissionais (comercial/criador) e não fornece e-mail.
  instagram: {
    nome: 'Instagram',
    authorize: 'https://www.instagram.com/oauth/authorize',
    scope: 'instagram_business_basic',
    async perfil(code, cred, redirectUri) {
      const token = await postForm('https://api.instagram.com/oauth/access_token', {
        client_id: cred.clientId,
        client_secret: cred.clientSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      });
      const u = await getJson(
        `https://graph.instagram.com/v21.0/me?fields=user_id,username,name,profile_picture_url&access_token=${encodeURIComponent(token.access_token)}`,
      );
      return { id: String(u.user_id || token.user_id), nome: u.name || `@${u.username}`, email: null, avatar: u.profile_picture_url };
    },
  },
};

async function postForm(url, campos) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(campos),
    signal: AbortSignal.timeout(15000),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) throw new Error(`troca de código falhou (HTTP ${resp.status})`);
  return json;
}

async function getJson(url, bearer) {
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    signal: AbortSignal.timeout(15000),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`HTTP ${resp.status} em ${new URL(url).host}`);
  return json;
}

function lerCookies(req) {
  const out = {};
  for (const parte of (req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0) out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return out;
}

function opcoesCookie(maxAgeMs) {
  return { httpOnly: true, sameSite: 'lax', secure: config.producao, path: '/', maxAge: maxAgeMs };
}

// Só aceita voltar para caminhos do próprio site (evita open redirect).
function voltarSeguro(v) {
  return typeof v === 'string' && /^\/(?!\/)[^\s\\]*$/.test(v) ? v : '/';
}

function provedorConfigurado(p) {
  const c = config.oauth[p];
  return Boolean(c && c.clientId && c.clientSecret);
}

function criarAuth(db) {
  const st = {
    upsertUsuario: db.prepare(`
      INSERT INTO usuarios (provedor, provedor_id, nome, email, avatar) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (provedor, provedor_id) DO UPDATE SET
        nome = excluded.nome,
        email = COALESCE(excluded.email, usuarios.email),
        avatar = COALESCE(excluded.avatar, usuarios.avatar)
      RETURNING id`),
    criarSessao: db.prepare('INSERT INTO sessoes (id, usuario_id, expira_em) VALUES (?, ?, ?)'),
    sessao: db.prepare(`
      SELECT u.id, u.provedor, u.nome, u.email, u.avatar FROM sessoes s
      JOIN usuarios u ON u.id = s.usuario_id WHERE s.id = ? AND s.expira_em > ?`),
    apagarSessao: db.prepare('DELETE FROM sessoes WHERE id = ?'),
    limparVencidas: db.prepare('DELETE FROM sessoes WHERE expira_em <= ?'),
    atualizarEmail: db.prepare('UPDATE usuarios SET email = ? WHERE id = ?'),
  };

  function hashSessao(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  function iniciarSessao(res, usuarioId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const ms = SESSAO_DIAS * 86400 * 1000;
    st.criarSessao.run(hashSessao(token), usuarioId, Date.now() + ms);
    res.cookie(COOKIE_SESSAO, token, opcoesCookie(ms));
  }

  function entrar(res, provedor, perfil) {
    const { id } = st.upsertUsuario.get(provedor, String(perfil.id), perfil.nome || 'Cidadão', perfil.email || null, perfil.avatar || null);
    iniciarSessao(res, id);
    return id;
  }

  // Middleware: preenche req.usuario quando há sessão válida.
  function carregarUsuario(req, _res, next) {
    const token = lerCookies(req)[COOKIE_SESSAO];
    req.usuario = null;
    if (token) {
      const u = st.sessao.get(hashSessao(token), Date.now());
      if (u) req.usuario = { ...u, admin: Boolean(u.email && config.admins.includes(u.email.toLowerCase())) };
    }
    next();
  }

  function exigirLogin(req, res, next) {
    if (!req.usuario) return res.status(401).json({ erro: 'Faça login para continuar.' });
    next();
  }

  function exigirAdmin(req, res, next) {
    if (!req.usuario?.admin) return res.status(403).json({ erro: 'Apenas administradores.' });
    next();
  }

  const router = express.Router();

  router.get('/auth/provedores', (_req, res) => {
    res.json({
      provedores: Object.entries(PROVEDORES).map(([id, p]) => ({ id, nome: p.nome, ativo: provedorConfigurado(id) })),
      devLogin: config.allowDevLogin,
    });
  });

  router.get('/auth/:provedor', (req, res, next) => {
    const p = PROVEDORES[req.params.provedor];
    if (!p) return next();
    if (!provedorConfigurado(req.params.provedor)) {
      return res.status(503).send(`Login com ${p.nome} ainda não foi configurado neste servidor.`);
    }
    const estado = crypto.randomBytes(16).toString('base64url');
    const voltar = voltarSeguro(req.query.voltar);
    res.cookie(COOKIE_ESTADO, JSON.stringify({ estado, voltar, p: req.params.provedor }), opcoesCookie(10 * 60 * 1000));
    const q = new URLSearchParams({
      client_id: config.oauth[req.params.provedor].clientId,
      redirect_uri: `${config.baseUrl}/auth/${req.params.provedor}/callback`,
      response_type: 'code',
      scope: p.scope,
      state: estado,
    });
    if (req.params.provedor === 'google') q.set('prompt', 'select_account');
    res.redirect(`${p.authorize}?${q}`);
  });

  router.get('/auth/:provedor/callback', async (req, res, next) => {
    const nomeProvedor = req.params.provedor;
    const p = PROVEDORES[nomeProvedor];
    if (!p) return next();
    let salvo = {};
    try {
      salvo = JSON.parse(lerCookies(req)[COOKIE_ESTADO] || '{}');
    } catch { /* cookie corrompido */ }
    res.clearCookie(COOKIE_ESTADO, { path: '/' });
    const voltar = voltarSeguro(salvo.voltar);
    if (req.query.error || !req.query.code) return res.redirect(`${voltar}${voltar.includes('?') ? '&' : '?'}login=cancelado`);
    if (!salvo.estado || salvo.estado !== req.query.state || salvo.p !== nomeProvedor) {
      return res.status(400).send('Sessão de login expirada ou inválida. Tente novamente.');
    }
    try {
      const perfil = await p.perfil(String(req.query.code), config.oauth[nomeProvedor], `${config.baseUrl}/auth/${nomeProvedor}/callback`);
      entrar(res, nomeProvedor, perfil);
      res.redirect(voltar);
    } catch (e) {
      console.error(`[auth] ${nomeProvedor}: ${e.message}`);
      res.status(502).send(`Não foi possível concluir o login com ${p.nome}. Tente novamente.`);
    }
  });

  // Login de desenvolvimento (sem OAuth). Desligado por padrão em produção.
  router.post('/auth/dev', express.json(), (req, res) => {
    if (!config.allowDevLogin) return res.status(404).end();
    const nome = String(req.body?.nome || 'Cidadão de Teste').slice(0, 80);
    const email = String(req.body?.email || 'teste@exemplo.invalid').slice(0, 200);
    entrar(res, 'dev', { id: email, nome, email, avatar: null });
    res.json({ ok: true });
  });

  router.post('/auth/sair', (req, res) => {
    const token = lerCookies(req)[COOKIE_SESSAO];
    if (token) st.apagarSessao.run(hashSessao(token));
    res.clearCookie(COOKIE_SESSAO, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/api/eu', (req, res) => res.json({ usuario: req.usuario }));

  // Instagram não fornece e-mail: o usuário pode informar um para receber cópias.
  router.post('/api/eu/email', express.json(), exigirLogin, (req, res) => {
    const email = String(req.body?.email || '').trim();
    if (!emailValido(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
    st.atualizarEmail.run(email, req.usuario.id);
    res.json({ ok: true });
  });

  setInterval(() => st.limparVencidas.run(Date.now()), 3600 * 1000).unref();

  return { router, carregarUsuario, exigirLogin, exigirAdmin };
}

function emailValido(e) {
  return typeof e === 'string' && e.length <= 200 && /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(e);
}

module.exports = { criarAuth, emailValido, voltarSeguro };
