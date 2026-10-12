'use strict';

// Busca deputados federais (API da Câmara), senadores (API do Senado) e
// governadores (Wikidata + data/governadores.json) de cada estado.
//
// Formato normalizado de um político:
//   { id, cargo: 'governador'|'senador'|'deputado', nome, partido, uf, foto, email, url }
// O `id` tem prefixo do cargo (dep-123, sen-456, gov-SP) para ser único no site.

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { ESTADOS, POR_UF, isUf } = require('./estados');

const CAMARA = 'https://dadosabertos.camara.leg.br/api/v2';
const SENADO = 'https://legis.senado.leg.br/dadosabertos';
const WIKIDATA = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'CobraPolitico/1.0 (enquetes cidadas; contato no site)';

const memoria = new Map();

async function getJson(url, { timeoutMs = 15000, headers = {} } = {}) {
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`${url} respondeu HTTP ${resp.status}`);
  return resp.json();
}

function arquivoCache(chave) {
  return path.join(config.cacheDir, `${chave.replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

// Cache em memória + disco. Se a API cair, devolve a última cópia boa
// (mesmo vencida) em vez de deixar o site sem políticos.
async function comCache(chave, buscar) {
  const ttl = config.cacheHoras * 3600 * 1000;
  const agora = Date.now();
  let item = memoria.get(chave);
  if (!item) {
    try {
      item = JSON.parse(fs.readFileSync(arquivoCache(chave), 'utf8'));
      memoria.set(chave, item);
    } catch { /* sem cache em disco */ }
  }
  if (item && agora - item.em < ttl) return item.dados;
  try {
    const dados = await buscar();
    item = { em: agora, dados };
    memoria.set(chave, item);
    try {
      fs.mkdirSync(config.cacheDir, { recursive: true });
      fs.writeFileSync(arquivoCache(chave), JSON.stringify(item));
    } catch (e) {
      console.warn(`[politicos] não consegui gravar cache ${chave}: ${e.message}`);
    }
    return dados;
  } catch (e) {
    if (item) {
      console.warn(`[politicos] ${chave}: usando cache vencido (${e.message})`);
      return item.dados;
    }
    throw e;
  }
}

// ---------------------------------------------------------------- Câmara

function normalizarDeputado(d) {
  return {
    id: `dep-${d.id}`,
    cargo: 'deputado',
    nome: d.nome,
    partido: d.siglaPartido || '',
    uf: d.siglaUf,
    foto: d.urlFoto || `https://www.camara.leg.br/internet/deputado/bandep/${d.id}.jpg`,
    email: d.email || '',
    url: `https://www.camara.leg.br/deputados/${d.id}`,
  };
}

async function buscarDeputadosApi(uf) {
  const lista = [];
  let url = `${CAMARA}/deputados?siglaUf=${uf}&ordem=ASC&ordenarPor=nome&itens=100`;
  for (let pagina = 0; url && pagina < 10; pagina++) {
    const json = await getJson(url);
    lista.push(...(json.dados || []).map(normalizarDeputado));
    const prox = (json.links || []).find((l) => l.rel === 'next');
    url = prox ? prox.href : null;
  }
  return lista;
}

// ---------------------------------------------------------------- Senado

function comoLista(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

function normalizarSenador(p) {
  const id = p.IdentificacaoParlamentar || {};
  return {
    id: `sen-${id.CodigoParlamentar}`,
    cargo: 'senador',
    nome: id.NomeParlamentar || id.NomeCompletoParlamentar,
    partido: id.SiglaPartidoParlamentar || '',
    uf: id.UfParlamentar,
    foto: id.UrlFotoParlamentar || '',
    email: id.EmailParlamentar || '',
    url: id.UrlPaginaParlamentar || `https://www25.senado.leg.br/web/senadores/senador/-/perfil/${id.CodigoParlamentar}`,
  };
}

async function buscarTodosSenadoresApi() {
  const json = await getJson(`${SENADO}/senador/lista/atual.json`);
  const parl = json?.ListaParlamentarEmExercicio?.Parlamentares?.Parlamentar;
  return comoLista(parl).map(normalizarSenador).filter((s) => isUf(s.uf));
}

// ---------------------------------------------------------- Governadores

function lerGovernadoresArquivo() {
  try {
    return JSON.parse(fs.readFileSync(config.governadoresPath, 'utf8'));
  } catch (e) {
    console.warn(`[politicos] não consegui ler ${config.governadoresPath}: ${e.message}`);
    return {};
  }
}

// Chefe de governo atual (P6 sem data de término) de cada UF, pelo código ISO 3166-2 (P300).
const SPARQL_GOVERNADORES = `
SELECT ?iso ?gov ?govLabel ?img WHERE {
  { ?uf wdt:P31 wd:Q485258 } UNION { VALUES ?uf { wd:Q119158 } }
  ?uf wdt:P300 ?iso .
  ?uf p:P6 ?st . ?st ps:P6 ?gov .
  FILTER NOT EXISTS { ?st pq:P582 ?fim }
  OPTIONAL { ?gov wdt:P18 ?img }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "pt-br,pt,en". }
}`;

async function buscarGovernadoresWikidata() {
  const url = `${WIKIDATA}?format=json&query=${encodeURIComponent(SPARQL_GOVERNADORES)}`;
  const json = await getJson(url, { headers: { Accept: 'application/sparql-results+json' } });
  const porUf = {};
  for (const b of json?.results?.bindings || []) {
    const uf = String(b.iso?.value || '').replace(/^BR-/, '');
    if (!isUf(uf) || porUf[uf]) continue;
    porUf[uf] = {
      nome: b.govLabel?.value,
      foto: b.img?.value ? `${b.img.value.replace(/^http:/, 'https:')}?width=300` : '',
      url: b.gov?.value,
    };
  }
  return porUf;
}

async function governadores() {
  const arquivo = lerGovernadoresArquivo();
  let wiki = {};
  if (!config.dadosOffline) {
    try {
      wiki = await comCache('governadores-wikidata', buscarGovernadoresWikidata);
    } catch (e) {
      console.warn(`[politicos] Wikidata indisponível, usando data/governadores.json (${e.message})`);
    }
  }
  const out = {};
  for (const { uf } of ESTADOS) {
    const a = arquivo[uf] || {};
    const w = wiki[uf] || {};
    const base = a.fixo ? { ...w, ...a } : { ...a, ...w };
    if (!base.nome) continue;
    out[uf] = {
      id: `gov-${uf}`,
      cargo: 'governador',
      nome: base.nome,
      partido: base.partido || a.partido || '',
      uf,
      foto: base.foto || a.foto || '',
      // e-mail nunca vem do Wikidata: só do arquivo, configurado pelo administrador
      email: a.email || '',
      url: base.url || '',
    };
  }
  return out;
}

// ------------------------------------------------- Dados fictícios (offline)

const BANCADA = { SP: 70, MG: 53, RJ: 46, BA: 39, RS: 31, PR: 30, PE: 25, CE: 22, MA: 18, GO: 17, PA: 17, SC: 16, PB: 12, ES: 10, PI: 10, AL: 9 };
const PARTIDOS = ['PARTIDO A', 'PARTIDO B', 'PARTIDO C', 'PARTIDO D'];

function exemplo(uf) {
  const n = Math.min(BANCADA[uf] || 8, 12);
  const deputados = Array.from({ length: n }, (_, i) => ({
    id: `dep-ex${uf}${i + 1}`,
    cargo: 'deputado',
    nome: `Deputado(a) Exemplo ${i + 1} (${uf})`,
    partido: PARTIDOS[i % PARTIDOS.length],
    uf,
    foto: '',
    email: `deputado${i + 1}.${uf.toLowerCase()}@exemplo.invalid`,
    url: '',
  }));
  const senadores = [1, 2, 3].map((i) => ({
    id: `sen-ex${uf}${i}`,
    cargo: 'senador',
    nome: `Senador(a) Exemplo ${i} (${uf})`,
    partido: PARTIDOS[i % PARTIDOS.length],
    uf,
    foto: '',
    email: `senador${i}.${uf.toLowerCase()}@exemplo.invalid`,
    url: '',
  }));
  return { deputados, senadores };
}

// ---------------------------------------------------------------- Público

async function politicosDoEstado(uf) {
  if (!isUf(uf)) throw new Error(`UF inválida: ${uf}`);
  const govs = await governadores();
  if (config.dadosOffline) {
    return { estado: POR_UF[uf], governador: govs[uf] || null, ...exemplo(uf), exemplo: true };
  }
  const [deputados, senadores] = await Promise.all([
    comCache(`deputados-${uf}`, () => buscarDeputadosApi(uf)),
    comCache('senadores', buscarTodosSenadoresApi).then((l) => l.filter((s) => s.uf === uf)),
  ]);
  return { estado: POR_UF[uf], governador: govs[uf] || null, deputados, senadores, exemplo: false };
}

// Resolve ids escolhidos pelo usuário contra a lista oficial do estado,
// para que ninguém consiga enviar e-mail para um endereço arbitrário.
async function resolverDestinatarios(uf, ids) {
  const dados = await politicosDoEstado(uf);
  const todos = [dados.governador, ...dados.senadores, ...dados.deputados].filter(Boolean);
  const porId = new Map(todos.map((p) => [p.id, p]));
  const escolhidos = [];
  const desconhecidos = [];
  for (const id of new Set(ids)) {
    const p = porId.get(id);
    if (p) escolhidos.push(p);
    else desconhecidos.push(id);
  }
  return { escolhidos, desconhecidos };
}

function limparCacheMemoria() {
  memoria.clear();
}

module.exports = {
  politicosDoEstado,
  resolverDestinatarios,
  governadores,
  limparCacheMemoria,
  // exportados para testes
  _normalizarDeputado: normalizarDeputado,
  _normalizarSenador: normalizarSenador,
};
