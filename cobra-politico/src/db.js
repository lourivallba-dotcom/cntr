'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provedor TEXT NOT NULL,
  provedor_id TEXT NOT NULL,
  nome TEXT NOT NULL,
  email TEXT,
  avatar TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provedor, provedor_id)
);

CREATE TABLE IF NOT EXISTS sessoes (
  id TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em INTEGER NOT NULL
);

-- Uma "manifestação" é uma enquete ou um abaixo-assinado.
CREATE TABLE IF NOT EXISTS manifestacoes (
  id TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('enquete', 'abaixo_assinado')),
  uf TEXT NOT NULL,
  tema TEXT NOT NULL,
  titulo TEXT NOT NULL,
  descricao TEXT NOT NULL,
  meta_assinaturas INTEGER,
  email_copia TEXT,
  video TEXT,
  status TEXT NOT NULL DEFAULT 'publicada' CHECK (status IN ('publicada', 'oculta')),
  denuncias INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_manif_uf ON manifestacoes (uf, criado_em);

CREATE TABLE IF NOT EXISTS opcoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manifestacao_id TEXT NOT NULL REFERENCES manifestacoes(id) ON DELETE CASCADE,
  texto TEXT NOT NULL,
  ordem INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS votos (
  manifestacao_id TEXT NOT NULL REFERENCES manifestacoes(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  opcao_id INTEGER NOT NULL REFERENCES opcoes(id),
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (manifestacao_id, usuario_id)
);

CREATE TABLE IF NOT EXISTS assinaturas (
  manifestacao_id TEXT NOT NULL REFERENCES manifestacoes(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  cidade TEXT,
  comentario TEXT,
  publica INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (manifestacao_id, usuario_id)
);

-- Políticos escolhidos para responder. Cada um recebe um link secreto (token).
CREATE TABLE IF NOT EXISTS destinatarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manifestacao_id TEXT NOT NULL REFERENCES manifestacoes(id) ON DELETE CASCADE,
  politico_id TEXT NOT NULL,
  cargo TEXT NOT NULL,
  nome TEXT NOT NULL,
  partido TEXT,
  uf TEXT NOT NULL,
  foto TEXT,
  email TEXT,
  token TEXT NOT NULL UNIQUE,
  email_status TEXT NOT NULL DEFAULT 'pendente',
  enviado_em TEXT,
  resposta TEXT,
  respondido_em TEXT
);
CREATE INDEX IF NOT EXISTS ix_dest_politico ON destinatarios (politico_id);

CREATE TABLE IF NOT EXISTS comentarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manifestacao_id TEXT NOT NULL REFERENCES manifestacoes(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  texto TEXT NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS denuncias (
  manifestacao_id TEXT NOT NULL REFERENCES manifestacoes(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  motivo TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (manifestacao_id, usuario_id)
);

-- Registro de todo e-mail enviado (ou que falhou), para auditoria.
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  para TEXT NOT NULL,
  cc TEXT,
  assunto TEXT NOT NULL,
  corpo TEXT NOT NULL,
  status TEXT NOT NULL,
  erro TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function abrir(arquivo) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  if (arquivo !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

// Executa fn dentro de uma transação.
function transacao(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { abrir, transacao };
