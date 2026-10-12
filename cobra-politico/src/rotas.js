'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');

const config = require('./config');
const { transacao } = require('./db');
const { ESTADOS, POR_UF, estadoPublico, isUf } = require('./estados');
const politicos = require('./politicos');
const { emailValido } = require('./auth');
const { emailParaPolitico, emailRespostaParaAutor } = require('./mailer');
const { divulgar } = require('./social');

const TEMAS = [
  'Saúde', 'Educação', 'Segurança pública', 'Transporte e mobilidade', 'Infraestrutura e obras',
  'Saneamento e água', 'Meio ambiente', 'Economia e emprego', 'Impostos', 'Habitação',
  'Assistência social', 'Cultura e esporte', 'Agricultura', 'Combate à corrupção', 'Direitos humanos', 'Outros',
];

const TIPOS_VIDEO = { 'video/webm': '.webm', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv' };

const HOSTS_IMAGEM = new Set([
  'www.camara.leg.br', 'camara.leg.br', 'www.senado.leg.br', 'senado.leg.br', 'legis.senado.leg.br',
  'www25.senado.leg.br', 'commons.wikimedia.org', 'upload.wikimedia.org',
]);

function novoId() {
  // 10 caracteres base62 ≈ 59 bits: curto para compartilhar, difícil de adivinhar.
  const alfabeto = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, (b) => alfabeto[b % 62]).join('');
}

function texto(v, min, max) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n/g, '\n').trim();
  return t.length >= min && t.length <= max ? t : null;
}

class ErroValidacao extends Error {}

// Limitador simples em memória (por IP + ação).
function limitador(acao, max, janelaMs) {
  const contagens = new Map();
  setInterval(() => contagens.clear(), janelaMs).unref();
  return (req, res, next) => {
    const chave = `${acao}:${req.usuario?.id || req.ip}`;
    const n = (contagens.get(chave) || 0) + 1;
    contagens.set(chave, n);
    if (n > max) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos.' });
    next();
  };
}

function reputacao(recebidas, respondidas) {
  if (!recebidas) return { indice: null, selo: 'Sem cobranças' };
  const taxa = Math.round((respondidas / recebidas) * 100);
  if (recebidas < 3) return { indice: taxa, selo: 'Em avaliação' };
  if (taxa >= 80) return { indice: taxa, selo: 'Ótimo' };
  if (taxa >= 60) return { indice: taxa, selo: 'Bom' };
  if (taxa >= 40) return { indice: taxa, selo: 'Regular' };
  if (taxa >= 20) return { indice: taxa, selo: 'Ruim' };
  return { indice: taxa, selo: 'Não recomendado' };
}

function criarRotas({ db, mailer, auth }) {
  const { exigirLogin, exigirAdmin } = auth;
  const router = express.Router();
  const json = express.json({ limit: '64kb' });

  fs.mkdirSync(path.join(config.uploadsDir, 'videos'), { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: path.join(config.uploadsDir, 'videos'),
      filename: (_req, file, cb) => cb(null, `${novoId()}${TIPOS_VIDEO[file.mimetype.split(';')[0]] || '.webm'}`),
    }),
    limits: { fileSize: config.limites.videoMb * 1024 * 1024, files: 1, fields: 30 },
    fileFilter: (_req, file, cb) => cb(null, Boolean(TIPOS_VIDEO[file.mimetype.split(';')[0]])),
  });

  const st = {
    inserirManif: db.prepare(`INSERT INTO manifestacoes (id, usuario_id, tipo, uf, tema, titulo, descricao, meta_assinaturas, email_copia, video)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    inserirOpcao: db.prepare('INSERT INTO opcoes (manifestacao_id, texto, ordem) VALUES (?, ?, ?)'),
    inserirDest: db.prepare(`INSERT INTO destinatarios (manifestacao_id, politico_id, cargo, nome, partido, uf, foto, email, token, email_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    manif: db.prepare(`SELECT m.*, u.nome AS autor_nome, u.avatar AS autor_avatar FROM manifestacoes m
      JOIN usuarios u ON u.id = m.usuario_id WHERE m.id = ?`),
    opcoes: db.prepare(`SELECT o.id, o.texto, (SELECT COUNT(*) FROM votos v WHERE v.opcao_id = o.id) AS votos
      FROM opcoes o WHERE o.manifestacao_id = ? ORDER BY o.ordem`),
    destinatarios: db.prepare(`SELECT id, politico_id, cargo, nome, partido, uf, foto, email_status, enviado_em, resposta, respondido_em,
      (email IS NOT NULL AND email <> '') AS tem_email
      FROM destinatarios WHERE manifestacao_id = ?
      ORDER BY CASE cargo WHEN 'governador' THEN 0 WHEN 'senador' THEN 1 ELSE 2 END, nome`),
    destParaEnvio: db.prepare('SELECT * FROM destinatarios WHERE manifestacao_id = ?'),
    marcarEnvio: db.prepare("UPDATE destinatarios SET email_status = ?, enviado_em = datetime('now') WHERE id = ?"),
    meuVoto: db.prepare('SELECT opcao_id FROM votos WHERE manifestacao_id = ? AND usuario_id = ?'),
    votar: db.prepare(`INSERT INTO votos (manifestacao_id, usuario_id, opcao_id) VALUES (?, ?, ?)
      ON CONFLICT (manifestacao_id, usuario_id) DO UPDATE SET opcao_id = excluded.opcao_id, criado_em = datetime('now')`),
    opcaoDaManif: db.prepare('SELECT id FROM opcoes WHERE id = ? AND manifestacao_id = ?'),
    totalAssin: db.prepare('SELECT COUNT(*) AS n FROM assinaturas WHERE manifestacao_id = ?'),
    totalVotos: db.prepare('SELECT COUNT(*) AS n FROM votos WHERE manifestacao_id = ?'),
    minhaAssin: db.prepare('SELECT 1 FROM assinaturas WHERE manifestacao_id = ? AND usuario_id = ?'),
    assinar: db.prepare(`INSERT INTO assinaturas (manifestacao_id, usuario_id, cidade, comentario, publica) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`),
    assinaturasRecentes: db.prepare(`SELECT CASE WHEN a.publica = 1 THEN u.nome ELSE 'Assinatura anônima' END AS nome,
      a.cidade, a.comentario, a.criado_em FROM assinaturas a JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.manifestacao_id = ? ORDER BY a.criado_em DESC LIMIT 30`),
    comentarios: db.prepare(`SELECT c.id, c.texto, c.criado_em, u.nome, u.avatar FROM comentarios c JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.manifestacao_id = ? ORDER BY c.criado_em DESC LIMIT 100`),
    comentar: db.prepare('INSERT INTO comentarios (manifestacao_id, usuario_id, texto) VALUES (?, ?, ?)'),
    denunciar: db.prepare('INSERT INTO denuncias (manifestacao_id, usuario_id, motivo) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'),
    contarDenuncia: db.prepare('UPDATE manifestacoes SET denuncias = (SELECT COUNT(*) FROM denuncias WHERE manifestacao_id = ?) WHERE id = ?'),
    destPorToken: db.prepare('SELECT * FROM destinatarios WHERE token = ?'),
    responder: db.prepare("UPDATE destinatarios SET resposta = ?, respondido_em = datetime('now') WHERE id = ? AND resposta IS NULL"),
    emailAutor: db.prepare('SELECT m.email_copia, u.email FROM manifestacoes m JOIN usuarios u ON u.id = m.usuario_id WHERE m.id = ?'),
    contagemUf: db.prepare("SELECT uf, COUNT(*) AS n FROM manifestacoes WHERE status = 'publicada' GROUP BY uf"),
    status: db.prepare('UPDATE manifestacoes SET status = ? WHERE id = ?'),
  };

  // ------------------------------------------------------------ catálogo

  router.get('/api/temas', (_req, res) => res.json({ temas: TEMAS }));

  router.get('/api/estados', (_req, res) => {
    const contagem = Object.fromEntries(st.contagemUf.all().map((r) => [r.uf, r.n]));
    res.json({ estados: ESTADOS.map((e) => ({ ...estadoPublico(e), manifestacoes: contagem[e.uf] || 0 })) });
  });

  router.get('/api/estados/:uf/politicos', async (req, res) => {
    const uf = String(req.params.uf).toUpperCase();
    if (!isUf(uf)) return res.status(404).json({ erro: 'Estado não encontrado.' });
    try {
      const d = await politicos.politicosDoEstado(uf);
      // e-mails dos políticos não vão para o navegador: só o servidor envia
      const semEmail = (p) => p && { ...p, email: undefined, tem_email: Boolean(p.email) };
      res.set('Cache-Control', 'public, max-age=600');
      res.json({
        estado: estadoPublico(d.estado),
        governador: semEmail(d.governador),
        senadores: d.senadores.map(semEmail),
        deputados: d.deputados.map(semEmail),
        exemplo: d.exemplo,
      });
    } catch (e) {
      console.error(`[politicos] ${uf}: ${e.message}`);
      res.status(502).json({ erro: 'Não foi possível consultar as APIs da Câmara/Senado agora. Tente em instantes.' });
    }
  });

  // ------------------------------------------------------- manifestações

  function resumo(m) {
    const dest = st.destinatarios.all(m.id);
    return {
      id: m.id,
      tipo: m.tipo,
      uf: m.uf,
      tema: m.tema,
      titulo: m.titulo,
      descricao: m.descricao.length > 280 ? `${m.descricao.slice(0, 277)}…` : m.descricao,
      autor: m.autor_nome,
      criado_em: m.criado_em,
      tem_video: Boolean(m.video),
      apoios: m.tipo === 'abaixo_assinado' ? st.totalAssin.get(m.id).n : st.totalVotos.get(m.id).n,
      meta_assinaturas: m.meta_assinaturas,
      destinatarios: dest.map((d) => ({ nome: d.nome, cargo: d.cargo, foto: d.foto, respondeu: Boolean(d.resposta) })),
      respostas: dest.filter((d) => d.resposta).length,
    };
  }

  router.get('/api/manifestacoes', (req, res) => {
    const where = ["m.status = 'publicada'"];
    const params = [];
    const uf = String(req.query.uf || '').toUpperCase();
    if (uf) {
      if (!isUf(uf)) return res.status(400).json({ erro: 'UF inválida.' });
      where.push('m.uf = ?');
      params.push(uf);
    }
    if (req.query.tema && TEMAS.includes(req.query.tema)) {
      where.push('m.tema = ?');
      params.push(req.query.tema);
    }
    if (['enquete', 'abaixo_assinado'].includes(req.query.tipo)) {
      where.push('m.tipo = ?');
      params.push(req.query.tipo);
    }
    if (req.query.politico) {
      where.push('m.id IN (SELECT manifestacao_id FROM destinatarios WHERE politico_id = ?)');
      params.push(String(req.query.politico));
    }
    if (req.query.minhas === '1') {
      if (!req.usuario) return res.status(401).json({ erro: 'Faça login.' });
      where[0] = '1 = 1';
      where.push('m.usuario_id = ?');
      params.push(req.usuario.id);
    }
    const ordem = req.query.ordem === 'populares'
      ? `((SELECT COUNT(*) FROM assinaturas a WHERE a.manifestacao_id = m.id) + (SELECT COUNT(*) FROM votos v WHERE v.manifestacao_id = m.id)) DESC, m.criado_em DESC`
      : 'm.criado_em DESC';
    const pagina = Math.max(0, Number.parseInt(req.query.pagina, 10) || 0);
    const linhas = db.prepare(`SELECT m.*, u.nome AS autor_nome FROM manifestacoes m JOIN usuarios u ON u.id = m.usuario_id
      WHERE ${where.join(' AND ')} ORDER BY ${ordem} LIMIT 21 OFFSET ?`).all(...params, pagina * 20);
    res.json({ itens: linhas.slice(0, 20).map(resumo), mais: linhas.length > 20 });
  });

  router.post('/api/manifestacoes', exigirLogin, limitador('criar', 10, 3600 * 1000), upload.single('video'), async (req, res) => {
    const videoArquivo = req.file ? req.file.filename : null;
    const descartarVideo = () => {
      if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    };
    try {
      const b = req.body || {};
      const tipo = b.tipo === 'abaixo_assinado' ? 'abaixo_assinado' : b.tipo === 'enquete' ? 'enquete' : null;
      if (!tipo) throw new ErroValidacao('Escolha entre enquete ou abaixo-assinado.');
      const uf = String(b.uf || '').toUpperCase();
      if (!isUf(uf)) throw new ErroValidacao('Escolha um estado.');
      if (!TEMAS.includes(b.tema)) throw new ErroValidacao('Escolha um tema.');
      const titulo = texto(b.titulo, 10, 140);
      if (!titulo) throw new ErroValidacao('O título deve ter entre 10 e 140 caracteres.');
      const descricao = texto(b.descricao, 20, 5000);
      if (!descricao) throw new ErroValidacao('A descrição deve ter entre 20 e 5000 caracteres.');

      let opcoes = [];
      if (tipo === 'enquete') {
        try {
          opcoes = JSON.parse(b.opcoes || '[]');
        } catch {
          throw new ErroValidacao('Opções inválidas.');
        }
        if (!Array.isArray(opcoes)) throw new ErroValidacao('Opções inválidas.');
        opcoes = opcoes.map((o) => texto(o, 1, 100)).filter(Boolean);
        if (new Set(opcoes.map((o) => o.toLowerCase())).size !== opcoes.length) throw new ErroValidacao('Há opções repetidas.');
        if (opcoes.length < 2 || opcoes.length > 6) throw new ErroValidacao('A enquete precisa de 2 a 6 opções.');
      }
      let meta = null;
      if (tipo === 'abaixo_assinado') {
        meta = Number.parseInt(b.meta_assinaturas, 10) || 1000;
        if (meta < 10 || meta > 10_000_000) throw new ErroValidacao('A meta de assinaturas deve ficar entre 10 e 10 milhões.');
      }

      let ids;
      try {
        ids = JSON.parse(b.destinatarios || '[]');
      } catch {
        throw new ErroValidacao('Destinatários inválidos.');
      }
      if (!Array.isArray(ids) || !ids.length) throw new ErroValidacao('Escolha pelo menos um político para responder.');
      if (ids.length > 1 + config.limites.maxSenadores + config.limites.maxDeputados) throw new ErroValidacao('Destinatários demais.');
      const { escolhidos, desconhecidos } = await politicos.resolverDestinatarios(uf, ids.map(String));
      if (desconhecidos.length) throw new ErroValidacao('Algum político escolhido não pertence a esse estado.');
      const conta = (c) => escolhidos.filter((p) => p.cargo === c).length;
      if (conta('governador') > 1) throw new ErroValidacao('Só há um governador por estado.');
      if (conta('senador') > config.limites.maxSenadores) throw new ErroValidacao(`Escolha no máximo ${config.limites.maxSenadores} senadores.`);
      if (conta('deputado') > config.limites.maxDeputados) throw new ErroValidacao(`Escolha no máximo ${config.limites.maxDeputados} deputados.`);

      const emailCopia = String(b.email_copia || req.usuario.email || '').trim() || null;
      if (emailCopia && !emailValido(emailCopia)) throw new ErroValidacao('E-mail para cópia inválido.');

      const id = novoId();
      transacao(db, () => {
        st.inserirManif.run(id, req.usuario.id, tipo, uf, b.tema, titulo, descricao, meta, emailCopia, videoArquivo);
        opcoes.forEach((o, i) => st.inserirOpcao.run(id, o, i));
        for (const p of escolhidos) {
          st.inserirDest.run(id, p.id, p.cargo, p.nome, p.partido || '', uf, p.foto || '', p.email || '',
            crypto.randomBytes(24).toString('base64url'), p.email ? 'pendente' : 'sem_email');
        }
      });

      res.status(201).json({ id, url: `${config.baseUrl}/e/${id}` });

      // Depois de responder ao navegador: e-mails + divulgação.
      req.app.locals.ultimoEnvio = enviarParaPoliticos(id, req.usuario).then(() =>
        divulgar('nova_manifestacao', { id, url: `${config.baseUrl}/e/${id}`, tipo, uf, tema: b.tema, titulo,
          video: videoArquivo ? `${config.baseUrl}/uploads/videos/${videoArquivo}` : null,
          destinatarios: escolhidos.map((p) => ({ nome: p.nome, cargo: p.cargo, partido: p.partido })) }));
    } catch (e) {
      descartarVideo();
      if (e instanceof ErroValidacao) return res.status(400).json({ erro: e.message });
      console.error('[criar]', e);
      res.status(500).json({ erro: 'Erro ao publicar. Tente novamente.' });
    }
  });

  async function enviarParaPoliticos(id, autor) {
    const m = st.manif.get(id);
    const estado = POR_UF[m.uf];
    for (const d of st.destParaEnvio.all(id)) {
      if (!d.email) continue;
      const msg = emailParaPolitico({ manifestacao: m, destinatario: d, autor, estado, totalApoios: 0 });
      const status = await mailer.enviar({ para: d.email, cc: m.email_copia, ...msg });
      st.marcarEnvio.run(status, d.id);
    }
  }

  function carregarPublica(req, res) {
    const m = st.manif.get(String(req.params.id));
    if (!m || (m.status !== 'publicada' && !req.usuario?.admin && req.usuario?.id !== m.usuario_id)) {
      res.status(404).json({ erro: 'Enquete não encontrada.' });
      return null;
    }
    return m;
  }

  router.get('/api/manifestacoes/:id', (req, res) => {
    const m = carregarPublica(req, res);
    if (!m) return;
    const u = req.usuario;
    res.json({
      id: m.id,
      tipo: m.tipo,
      uf: m.uf,
      estado: estadoPublico(POR_UF[m.uf]),
      tema: m.tema,
      titulo: m.titulo,
      descricao: m.descricao,
      autor: { nome: m.autor_nome, avatar: m.autor_avatar },
      criado_em: m.criado_em,
      status: m.status,
      video: m.video ? `/uploads/videos/${m.video}` : null,
      meta_assinaturas: m.meta_assinaturas,
      opcoes: m.tipo === 'enquete' ? st.opcoes.all(m.id) : [],
      total_votos: st.totalVotos.get(m.id).n,
      total_assinaturas: st.totalAssin.get(m.id).n,
      assinaturas: m.tipo === 'abaixo_assinado' ? st.assinaturasRecentes.all(m.id) : [],
      destinatarios: st.destinatarios.all(m.id).map((d) => ({ ...d, tem_email: Boolean(d.tem_email) })),
      comentarios: st.comentarios.all(m.id),
      meu_voto: u ? st.meuVoto.get(m.id, u.id)?.opcao_id ?? null : null,
      assinei: u ? Boolean(st.minhaAssin.get(m.id, u.id)) : false,
      sou_autor: Boolean(u && u.id === m.usuario_id),
    });
  });

  router.post('/api/manifestacoes/:id/votar', exigirLogin, json, (req, res) => {
    const m = carregarPublica(req, res);
    if (!m) return;
    if (m.tipo !== 'enquete') return res.status(400).json({ erro: 'Isto é um abaixo-assinado: assine em vez de votar.' });
    const opcao = Number(req.body?.opcao_id);
    if (!st.opcaoDaManif.get(opcao, m.id)) return res.status(400).json({ erro: 'Opção inválida.' });
    st.votar.run(m.id, req.usuario.id, opcao);
    res.json({ ok: true, opcoes: st.opcoes.all(m.id) });
  });

  router.post('/api/manifestacoes/:id/assinar', exigirLogin, json, (req, res) => {
    const m = carregarPublica(req, res);
    if (!m) return;
    if (m.tipo !== 'abaixo_assinado') return res.status(400).json({ erro: 'Isto é uma enquete: vote em vez de assinar.' });
    const cidade = texto(req.body?.cidade || '', 0, 80) || null;
    const comentario = texto(req.body?.comentario || '', 0, 500) || null;
    const publica = req.body?.publica === false ? 0 : 1;
    const r = st.assinar.run(m.id, req.usuario.id, cidade, comentario, publica);
    res.json({ ok: true, ja_assinado: r.changes === 0, total: st.totalAssin.get(m.id).n });
  });

  router.post('/api/manifestacoes/:id/comentarios', exigirLogin, limitador('comentar', 30, 3600 * 1000), json, (req, res) => {
    const m = carregarPublica(req, res);
    if (!m) return;
    const t = texto(req.body?.texto, 2, 1000);
    if (!t) return res.status(400).json({ erro: 'O comentário deve ter entre 2 e 1000 caracteres.' });
    st.comentar.run(m.id, req.usuario.id, t);
    res.status(201).json({ ok: true, comentarios: st.comentarios.all(m.id) });
  });

  router.post('/api/manifestacoes/:id/denunciar', exigirLogin, json, (req, res) => {
    const m = carregarPublica(req, res);
    if (!m) return;
    st.denunciar.run(m.id, req.usuario.id, texto(req.body?.motivo || '', 0, 300) || null);
    st.contarDenuncia.run(m.id, m.id);
    res.json({ ok: true });
  });

  // ------------------------------------------------- resposta do político

  function carregarToken(req, res) {
    const d = st.destPorToken.get(String(req.params.token));
    if (!d) {
      res.status(404).json({ erro: 'Link de resposta inválido.' });
      return null;
    }
    return d;
  }

  router.get('/api/responder/:token', (req, res) => {
    const d = carregarToken(req, res);
    if (!d) return;
    const m = st.manif.get(d.manifestacao_id);
    res.json({
      destinatario: { nome: d.nome, cargo: d.cargo, partido: d.partido, uf: d.uf, resposta: d.resposta, respondido_em: d.respondido_em },
      manifestacao: { id: m.id, tipo: m.tipo, titulo: m.titulo, descricao: m.descricao, tema: m.tema, uf: m.uf, autor: m.autor_nome, criado_em: m.criado_em },
    });
  });

  router.post('/api/responder/:token', limitador('responder', 20, 3600 * 1000), json, async (req, res) => {
    const d = carregarToken(req, res);
    if (!d) return;
    const resposta = texto(req.body?.resposta, 10, 5000);
    if (!resposta) return res.status(400).json({ erro: 'A resposta deve ter entre 10 e 5000 caracteres.' });
    const r = st.responder.run(resposta, d.id);
    if (r.changes === 0) return res.status(409).json({ erro: 'Esta cobrança já foi respondida.' });
    res.json({ ok: true, url: `/e/${d.manifestacao_id}` });

    const m = st.manif.get(d.manifestacao_id);
    const contato = st.emailAutor.get(m.id);
    const para = contato.email_copia || contato.email;
    const msg = emailRespostaParaAutor({ manifestacao: m, destinatario: { ...d, resposta } });
    req.app.locals.ultimoEnvio = Promise.all([
      para ? mailer.enviar({ para, ...msg }) : null,
      divulgar('resposta', { id: m.id, url: `${config.baseUrl}/e/${m.id}`, titulo: m.titulo, uf: m.uf,
        politico: { nome: d.nome, cargo: d.cargo, partido: d.partido }, resposta }),
    ]);
  });

  // --------------------------------------------------- ranking / político

  const SQL_RANKING = `
    SELECT d.politico_id, d.cargo, d.nome, d.partido, d.uf, MAX(d.foto) AS foto,
      COUNT(*) AS recebidas,
      SUM(CASE WHEN d.resposta IS NOT NULL THEN 1 ELSE 0 END) AS respondidas,
      AVG(CASE WHEN d.resposta IS NOT NULL THEN julianday(d.respondido_em) - julianday(m.criado_em) END) AS dias_medios
    FROM destinatarios d JOIN manifestacoes m ON m.id = d.manifestacao_id AND m.status = 'publicada'`;

  function linhaRanking(r) {
    return {
      ...r,
      dias_medios: r.dias_medios == null ? null : Math.round(r.dias_medios * 10) / 10,
      ...reputacao(r.recebidas, r.respondidas),
    };
  }

  router.get('/api/ranking', (req, res) => {
    const uf = String(req.query.uf || '').toUpperCase();
    const cargo = ['governador', 'senador', 'deputado'].includes(req.query.cargo) ? req.query.cargo : null;
    const where = [];
    const params = [];
    if (isUf(uf)) { where.push('d.uf = ?'); params.push(uf); }
    if (cargo) { where.push('d.cargo = ?'); params.push(cargo); }
    const linhas = db.prepare(`${SQL_RANKING} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY d.politico_id ORDER BY recebidas DESC LIMIT 200`).all(...params).map(linhaRanking);
    const avaliados = linhas.filter((r) => r.recebidas >= 3);
    res.json({
      mais_cobrados: linhas.slice(0, 20),
      melhores: [...avaliados].sort((a, b) => b.indice - a.indice || b.recebidas - a.recebidas).slice(0, 10),
      piores: [...avaliados].sort((a, b) => a.indice - b.indice || b.recebidas - a.recebidas).slice(0, 10),
    });
  });

  router.get('/api/politicos/:politicoId', (req, res) => {
    const r = db.prepare(`${SQL_RANKING} WHERE d.politico_id = ? GROUP BY d.politico_id`).get(String(req.params.politicoId));
    if (!r) return res.json({ politico: null });
    res.json({ politico: linhaRanking(r) });
  });

  // -------------------------------------------------------------- admin

  router.get('/api/admin/denuncias', exigirAdmin, (_req, res) => {
    res.json({
      itens: db.prepare(`SELECT m.id, m.titulo, m.uf, m.status, m.denuncias, m.criado_em, u.nome AS autor FROM manifestacoes m
        JOIN usuarios u ON u.id = m.usuario_id WHERE m.denuncias > 0 OR m.status = 'oculta' ORDER BY m.denuncias DESC LIMIT 100`).all(),
    });
  });

  router.post('/api/admin/manifestacoes/:id/status', exigirAdmin, json, (req, res) => {
    const status = req.body?.status;
    if (!['publicada', 'oculta'].includes(status)) return res.status(400).json({ erro: 'Status inválido.' });
    const r = st.status.run(status, String(req.params.id));
    if (!r.changes) return res.status(404).json({ erro: 'Não encontrada.' });
    res.json({ ok: true });
  });

  // ---------------------------------------------------- proxy de imagens
  // Fotos oficiais e bandeiras passam pelo servidor para poderem ser
  // desenhadas no <canvas> da moldura do vídeo (exige mesma origem / CORS).

  router.get('/api/img', limitador('img', 600, 60 * 1000), async (req, res) => {
    let url;
    try {
      url = new URL(String(req.query.url || ''));
    } catch {
      return res.status(400).end();
    }
    try {
      for (let saltos = 0; saltos < 4; saltos++) {
        if (url.protocol !== 'https:' || !HOSTS_IMAGEM.has(url.hostname)) return res.status(403).end();
        const resp = await fetch(url, {
          redirect: 'manual',
          headers: { 'User-Agent': 'CobraPolitico/1.0 (proxy de imagens)' },
          signal: AbortSignal.timeout(10000),
        });
        if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
          url = new URL(resp.headers.get('location'), url);
          continue;
        }
        const tipo = resp.headers.get('content-type') || '';
        if (!resp.ok || !/^image\/(png|jpe?g|gif|webp|svg\+xml)/.test(tipo)) return res.status(502).end();
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length > 5 * 1024 * 1024) return res.status(502).end();
        res.set({
          'Content-Type': tipo,
          'Cache-Control': 'public, max-age=86400',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
          'X-Content-Type-Options': 'nosniff',
        });
        return res.send(buf);
      }
      res.status(502).end();
    } catch {
      res.status(502).end();
    }
  });

  // Erros do multer (arquivo grande demais etc.)
  router.use((err, _req, res, next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `O vídeo passa de ${config.limites.videoMb} MB.` : 'Envio inválido.';
      return res.status(400).json({ erro: msg });
    }
    next(err);
  });

  return router;
}

module.exports = { criarRotas, TEMAS, reputacao };
