'use strict';

const path = require('node:path');

const raiz = path.join(__dirname, '..');
const env = process.env;
const producao = env.NODE_ENV === 'production';

function bool(v, padrao = false) {
  if (v === undefined || v === '') return padrao;
  return ['1', 'true', 'sim', 'yes', 'on'].includes(String(v).toLowerCase());
}

const config = {
  producao,
  porta: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  nomeSite: env.SITE_NOME || 'Cobra Político',

  dbPath: env.DB_PATH || path.join(raiz, 'data', 'cobra-politico.sqlite'),
  uploadsDir: env.UPLOADS_DIR || path.join(raiz, 'uploads'),
  cacheDir: env.CACHE_DIR || path.join(raiz, 'data', 'cache'),
  governadoresPath: path.join(raiz, 'data', 'governadores.json'),

  // Sem acesso às APIs oficiais (ex.: ambiente de desenvolvimento offline),
  // usa políticos FICTÍCIOS marcados como "Exemplo". Nunca ligue em produção.
  dadosOffline: bool(env.DADOS_OFFLINE),
  cacheHoras: Number(env.CACHE_HORAS || 12),

  allowDevLogin: bool(env.ALLOW_DEV_LOGIN, !producao),
  admins: (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  oauth: {
    google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    facebook: { clientId: env.FACEBOOK_APP_ID, clientSecret: env.FACEBOOK_APP_SECRET },
    instagram: { clientId: env.INSTAGRAM_APP_ID, clientSecret: env.INSTAGRAM_APP_SECRET },
  },

  smtp: {
    url: env.SMTP_URL, // ex.: smtps://usuario:senha@smtp.exemplo.com:465
    from: env.EMAIL_FROM || 'Cobra Político <nao-responda@cobrapolitico.com.br>',
    replyTo: env.EMAIL_REPLY_TO,
  },

  // Webhook (n8n, Make, Zapier…) chamado quando uma enquete é publicada ou
  // respondida, para postar automaticamente nos perfis oficiais do site.
  socialWebhookUrl: env.SOCIAL_WEBHOOK_URL,
  socialWebhookToken: env.SOCIAL_WEBHOOK_TOKEN,

  limites: {
    videoMb: Number(env.VIDEO_MAX_MB || 150),
    maxDeputados: 5,
    maxSenadores: 3,
  },
};

module.exports = config;
