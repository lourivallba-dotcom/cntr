'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cobra-'));
Object.assign(process.env, {
  DADOS_OFFLINE: '1',
  ALLOW_DEV_LOGIN: '1',
  UPLOADS_DIR: path.join(tmp, 'uploads'),
  CACHE_DIR: path.join(tmp, 'cache'),
  ADMIN_EMAILS: 'admin@exemplo.invalid',
  SMTP_URL: '',
  SOCIAL_WEBHOOK_URL: '',
});

const { criarApp } = require('../server');
const politicos = require('../src/politicos');

let servidor;
let base;
let app;

before(async () => {
  app = criarApp({ dbPath: ':memory:' });
  await new Promise((ok) => { servidor = app.listen(0, ok); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => {
  servidor.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function entrar(nome, email) {
  const r = await fetch(`${base}/auth/dev`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome, email }),
  });
  return r.headers.get('set-cookie').split(';')[0];
}

async function req(caminho, { cookie, metodo = 'GET', corpo, form, headers = {} } = {}) {
  const opts = { method: metodo, headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) } };
  if (form) opts.body = form;
  else if (corpo) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(corpo);
  }
  const r = await fetch(`${base}${caminho}`, opts);
  const texto = await r.text();
  let json = null;
  try { json = JSON.parse(texto); } catch { /* html */ }
  return { status: r.status, json, texto };
}

function formEnquete(extra = {}) {
  const f = new FormData();
  const campos = {
    tipo: 'enquete',
    uf: 'SP',
    tema: 'Saúde',
    titulo: 'Quando o hospital regional vai reabrir?',
    descricao: 'O hospital está fechado desde janeiro e a população está sem atendimento.',
    opcoes: JSON.stringify(['Sim', 'Não', 'Não sei']),
    destinatarios: JSON.stringify(['gov-SP', 'sen-exSP1', 'dep-exSP1', 'dep-exSP2']),
    ...extra,
  };
  for (const [k, v] of Object.entries(campos)) f.set(k, v);
  return f;
}

test('normaliza o formato da API da Câmara', () => {
  const d = politicos._normalizarDeputado({
    id: 204554, nome: 'Fulana de Tal', siglaPartido: 'XYZ', siglaUf: 'BA',
    urlFoto: 'https://www.camara.leg.br/internet/deputado/bandep/204554.jpg', email: 'dep.fulana@camara.leg.br',
  });
  assert.deepEqual(d, {
    id: 'dep-204554', cargo: 'deputado', nome: 'Fulana de Tal', partido: 'XYZ', uf: 'BA',
    foto: 'https://www.camara.leg.br/internet/deputado/bandep/204554.jpg', email: 'dep.fulana@camara.leg.br',
    url: 'https://www.camara.leg.br/deputados/204554',
  });
});

test('normaliza o formato da API do Senado', () => {
  const s = politicos._normalizarSenador({
    IdentificacaoParlamentar: {
      CodigoParlamentar: '5012', NomeParlamentar: 'Beltrano', SiglaPartidoParlamentar: 'ABC', UfParlamentar: 'RJ',
      UrlFotoParlamentar: 'http://www.senado.leg.br/senadores/img/fotos-oficiais/senador5012.jpg', EmailParlamentar: 'sen.beltrano@senado.leg.br',
    },
  });
  assert.equal(s.id, 'sen-5012');
  assert.equal(s.uf, 'RJ');
  assert.equal(s.email, 'sen.beltrano@senado.leg.br');
});

test('lista estados e políticos sem expor e-mails', async () => {
  const e = await req('/api/estados');
  assert.equal(e.json.estados.length, 27);
  const p = await req('/api/estados/SP/politicos');
  assert.equal(p.status, 200);
  assert.equal(p.json.governador.id, 'gov-SP');
  assert.equal(p.json.senadores.length, 3);
  assert.ok(p.json.deputados.length > 5);
  assert.equal(p.json.deputados[0].email, undefined);
  assert.equal((await req('/api/estados/XX/politicos')).status, 404);
});

test('criar exige login e valida limites de destinatários', async () => {
  assert.equal((await req('/api/manifestacoes', { metodo: 'POST', form: formEnquete() })).status, 401);
  const cookie = await entrar('Maria', 'maria@exemplo.invalid');
  const seisDeputados = JSON.stringify([1, 2, 3, 4, 5, 6].map((i) => `dep-exSP${i}`));
  let r = await req('/api/manifestacoes', { cookie, metodo: 'POST', form: formEnquete({ destinatarios: seisDeputados }) });
  assert.equal(r.status, 400);
  assert.match(r.json.erro, /5 deputados/);
  r = await req('/api/manifestacoes', { cookie, metodo: 'POST', form: formEnquete({ destinatarios: JSON.stringify(['dep-exRJ1']) }) });
  assert.equal(r.status, 400, 'político de outro estado deve ser recusado');
  r = await req('/api/manifestacoes', { cookie, metodo: 'POST', form: formEnquete({ destinatarios: '[]' }) });
  assert.equal(r.status, 400);
  r = await req('/api/manifestacoes', { cookie, metodo: 'POST', form: formEnquete({ opcoes: '["Só uma"]' }) });
  assert.equal(r.status, 400);
});

test('fluxo completo: enquete com vídeo, e-mails com cópia, voto, resposta e ranking', async () => {
  const cookie = await entrar('João', 'joao@exemplo.invalid');
  const form = formEnquete();
  form.set('video', new Blob([Buffer.from('1A45DFA3', 'hex')], { type: 'video/webm' }), 'video.webm');
  const criado = await req('/api/manifestacoes', { cookie, metodo: 'POST', form });
  assert.equal(criado.status, 201, criado.texto);
  const { id } = criado.json;
  await app.locals.ultimoEnvio;

  const db = app.locals.db;
  const emails = db.prepare('SELECT para, cc, status FROM emails ORDER BY id').all();
  // governador sem e-mail configurado: só senador + 2 deputados recebem
  assert.deepEqual(emails.map((e) => e.para), ['senador1.sp@exemplo.invalid', 'deputado1.sp@exemplo.invalid', 'deputado2.sp@exemplo.invalid']);
  assert.ok(emails.every((e) => e.cc === 'joao@exemplo.invalid' && e.status === 'simulado'));

  const m = (await req(`/api/manifestacoes/${id}`, { cookie })).json;
  assert.equal(m.destinatarios.length, 4);
  assert.ok(m.video.startsWith('/uploads/videos/'));
  assert.equal(m.destinatarios.find((d) => d.cargo === 'governador').email_status, 'sem_email');
  assert.ok(!('token' in m.destinatarios[0]), 'token de resposta não pode vazar');
  assert.equal((await req(m.video)).status, 200);

  const votante = await entrar('Pedro', 'pedro@exemplo.invalid');
  let v = await req(`/api/manifestacoes/${id}/votar`, { cookie: votante, metodo: 'POST', corpo: { opcao_id: m.opcoes[0].id } });
  assert.equal(v.json.opcoes[0].votos, 1);
  v = await req(`/api/manifestacoes/${id}/votar`, { cookie: votante, metodo: 'POST', corpo: { opcao_id: m.opcoes[1].id } });
  assert.deepEqual(v.json.opcoes.map((o) => o.votos), [0, 1, 0], 'mudar voto não duplica');

  const { token } = db.prepare("SELECT token FROM destinatarios WHERE manifestacao_id = ? AND politico_id = 'sen-exSP1'").get(id);
  const pag = await req(`/api/responder/${token}`);
  assert.equal(pag.json.destinatario.cargo, 'senador');
  const resp = await req(`/api/responder/${token}`, { metodo: 'POST', corpo: { resposta: 'O hospital será reaberto em março, com 40 leitos.' } });
  assert.equal(resp.status, 200);
  await app.locals.ultimoEnvio;
  assert.equal((await req(`/api/responder/${token}`, { metodo: 'POST', corpo: { resposta: 'Outra resposta qualquer aqui.' } })).status, 409);
  const ultimo = db.prepare('SELECT para, assunto FROM emails ORDER BY id DESC LIMIT 1').get();
  assert.equal(ultimo.para, 'joao@exemplo.invalid');
  assert.match(ultimo.assunto, /respondeu/);

  const ranking = (await req('/api/ranking?uf=SP')).json;
  const sen = ranking.mais_cobrados.find((r) => r.politico_id === 'sen-exSP1');
  assert.equal(sen.respondidas, 1);
  assert.equal(sen.selo, 'Em avaliação');

  const pagina = await req(`/e/${id}`);
  assert.match(pagina.texto, /og:title" content="Enquete \(São Paulo\): Quando o hospital/);
  assert.match(pagina.texto, /og:video/);
});

test('abaixo-assinado: assinatura única por pessoa', async () => {
  const cookie = await entrar('Ana', 'ana@exemplo.invalid');
  const f = formEnquete({ tipo: 'abaixo_assinado', meta_assinaturas: '500', uf: 'BA', destinatarios: JSON.stringify(['dep-exBA3']) });
  const { id } = (await req('/api/manifestacoes', { cookie, metodo: 'POST', form: f })).json;
  let r = await req(`/api/manifestacoes/${id}/assinar`, { cookie, metodo: 'POST', corpo: { cidade: 'Salvador' } });
  assert.equal(r.json.total, 1);
  r = await req(`/api/manifestacoes/${id}/assinar`, { cookie, metodo: 'POST', corpo: {} });
  assert.equal(r.json.ja_assinado, true);
  assert.equal(r.json.total, 1);
  assert.equal((await req(`/api/manifestacoes/${id}/votar`, { cookie, metodo: 'POST', corpo: { opcao_id: 1 } })).status, 400);
  const m = (await req(`/api/manifestacoes/${id}`)).json;
  assert.equal(m.meta_assinaturas, 500);
  assert.equal(m.assinaturas[0].cidade, 'Salvador');
});

test('moderação: só admin oculta, e conteúdo oculto some da lista', async () => {
  const autor = await entrar('Autor', 'autor@exemplo.invalid');
  const { id } = (await req('/api/manifestacoes', { cookie: autor, metodo: 'POST', form: formEnquete({ uf: 'AC', destinatarios: '["dep-exAC1"]' }) })).json;
  assert.equal((await req(`/api/admin/manifestacoes/${id}/status`, { cookie: autor, metodo: 'POST', corpo: { status: 'oculta' } })).status, 403);
  const admin = await entrar('Admin', 'admin@exemplo.invalid');
  assert.equal((await req(`/api/admin/manifestacoes/${id}/status`, { cookie: admin, metodo: 'POST', corpo: { status: 'oculta' } })).status, 200);
  const lista = (await req('/api/manifestacoes?uf=AC')).json.itens;
  assert.ok(!lista.some((i) => i.id === id));
  assert.equal((await req(`/api/manifestacoes/${id}`)).status, 404);
});

test('segurança: proxy de imagem só aceita hosts oficiais, POST de outra origem é bloqueado, voltar não redireciona para fora', async () => {
  assert.equal((await req(`/api/img?url=${encodeURIComponent('https://evil.example.com/x.png')}`)).status, 403);
  assert.equal((await req(`/api/img?url=${encodeURIComponent('http://169.254.169.254/latest')}`)).status, 403);
  const r = await req('/auth/dev', { metodo: 'POST', corpo: {}, headers: { Origin: 'https://evil.example.com' } });
  assert.equal(r.status, 403);
  const { voltarSeguro } = require('../src/auth');
  assert.equal(voltarSeguro('//evil.com'), '/');
  assert.equal(voltarSeguro('https://evil.com'), '/');
  assert.equal(voltarSeguro('/e/abc?x=1'), '/e/abc?x=1');
});
