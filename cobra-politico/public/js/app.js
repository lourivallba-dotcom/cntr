import {
  h, api, avisar, foto, img, dataBR, numero, CARGO, TIPO, classeSelo, enviarComProgresso,
} from './util.js';
import { desenharMapa } from './mapa.js';
import { Estudio, gravacaoSuportada } from './moldura.js';

const app = document.getElementById('app');
const estadoGlobal = { eu: null, estados: null, temas: null, provedores: null, limpar: null };

// ================================================================ dados

async function estados() {
  if (!estadoGlobal.estados) estadoGlobal.estados = (await api('/api/estados')).estados;
  return estadoGlobal.estados;
}
async function temas() {
  if (!estadoGlobal.temas) estadoGlobal.temas = (await api('/api/temas')).temas;
  return estadoGlobal.temas;
}
const cachePoliticos = new Map();
async function politicosDe(uf) {
  if (!cachePoliticos.has(uf)) cachePoliticos.set(uf, api(`/api/estados/${uf}/politicos`).catch((e) => { cachePoliticos.delete(uf); throw e; }));
  return cachePoliticos.get(uf);
}

// ================================================================ login

async function carregarEu() {
  estadoGlobal.eu = (await api('/api/eu')).usuario;
  desenharUsuario();
}

function desenharUsuario() {
  const area = document.getElementById('area-usuario');
  const eu = estadoGlobal.eu;
  if (!eu) {
    area.replaceChildren(h('button', { class: 'btn btn-fantasma btn-pequeno', onclick: () => abrirLogin() }, 'Entrar'));
    return;
  }
  area.replaceChildren(
    foto(eu.avatar, eu.nome, 'avatar'),
    h('a', { href: '/minhas', class: 'nome', style: { color: '#fff' } }, eu.nome),
    h('button', {
      class: 'btn btn-fantasma btn-pequeno',
      onclick: async () => {
        await api('/auth/sair', { metodo: 'POST' });
        estadoGlobal.eu = null;
        desenharUsuario();
        rotear();
      },
    }, 'Sair'),
  );
  area.querySelector('.avatar').style.width = '32px';
  area.querySelector('.avatar').style.height = '32px';
}

const ICONES = { google: 'G', facebook: 'f', instagram: '◎' };

async function abrirLogin(mensagem) {
  const dlg = document.getElementById('dialogo-login');
  if (!estadoGlobal.provedores) estadoGlobal.provedores = await api('/auth/provedores');
  const { provedores, devLogin } = estadoGlobal.provedores;
  const voltar = encodeURIComponent(location.pathname + location.search);
  const botoes = provedores.map((p) => (p.ativo
    ? h('a', { class: `btn ${p.id === 'google' ? 'google' : p.id === 'facebook' ? 's-facebook' : 's-instagram'}`, href: `/auth/${p.id}?voltar=${voltar}` },
      h('b', {}, ICONES[p.id]), `Entrar com ${p.nome}`)
    : h('button', { class: 'btn btn-fantasma', disabled: true, type: 'button', title: 'Configure as chaves no servidor' },
      h('b', {}, ICONES[p.id]), `${p.nome} (não configurado)`)));
  if (devLogin) {
    const nome = h('input', { type: 'text', placeholder: 'Seu nome (teste)', value: 'Cidadão de Teste' });
    const email = h('input', { type: 'email', placeholder: 'seu@email', value: 'teste@exemplo.invalid' });
    botoes.push(h('div', { class: 'cartao', style: { padding: '12px', display: 'grid', gap: '8px' } },
      h('span', { class: 'pequeno' }, 'Modo de desenvolvimento — login sem rede social:'), nome, email,
      h('button', {
        type: 'button',
        class: 'btn btn-verde',
        onclick: async () => {
          await api('/auth/dev', { metodo: 'POST', corpo: { nome: nome.value, email: email.value } });
          dlg.close();
          await carregarEu();
          rotear();
        },
      }, 'Entrar (teste)')));
  }
  document.getElementById('botoes-login').replaceChildren(...(mensagem ? [h('p', { class: 'erro-form' }, mensagem)] : []), ...botoes);
  dlg.showModal();
}

function exigirLogin(msg = 'Entre para continuar.') {
  if (estadoGlobal.eu) return true;
  abrirLogin(msg);
  return false;
}

// ============================================================== roteador

function navegar(url) {
  history.pushState(null, '', url);
  rotear();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a || a.target || a.hasAttribute('download') || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || /^\/(api|auth|uploads)\//.test(url.pathname)) return;
  e.preventDefault();
  navegar(url.pathname + url.search);
});
window.addEventListener('popstate', rotear);

const ROTAS = [
  [/^\/$/, inicio],
  [/^\/estado\/([A-Za-z]{2})$/, (m) => paginaEstado(m[1].toUpperCase())],
  [/^\/criar$/, criar],
  [/^\/e\/([A-Za-z0-9]+)$/, (m) => paginaManifestacao(m[1])],
  [/^\/responder\/([A-Za-z0-9_-]+)$/, (m) => responder(m[1])],
  [/^\/ranking$/, ranking],
  [/^\/politico\/([a-zA-Z0-9-]+)$/, (m) => paginaPolitico(m[1])],
  [/^\/minhas$/, minhas],
];

async function rotear() {
  estadoGlobal.limpar?.();
  estadoGlobal.limpar = null;
  const caminho = location.pathname;
  document.querySelectorAll('.menu a').forEach((a) => a.toggleAttribute('aria-current', a.getAttribute('href') === caminho));
  app.replaceChildren(h('p', { class: 'carregando' }, 'Carregando…'));
  for (const [re, fn] of ROTAS) {
    const m = caminho.match(re);
    if (m) {
      try {
        await fn(m);
      } catch (e) {
        console.error(e);
        app.replaceChildren(h('div', { class: 'cartao' }, h('h2', {}, 'Ops!'), h('p', {}, e.message || 'Algo deu errado.'),
          h('a', { href: '/', class: 'btn' }, 'Voltar ao início')));
      }
      window.scrollTo(0, 0);
      const params = new URLSearchParams(location.search);
      if (params.get('login') === 'cancelado') avisar('Login cancelado.', 'erro');
      return;
    }
  }
  app.replaceChildren(h('div', { class: 'cartao' }, h('h2', {}, 'Página não encontrada'), h('a', { href: '/' }, 'Voltar ao início')));
}

function titulo(t) {
  document.title = t ? `${t} — Cobra Político` : 'Cobra Político — o Reclame Aqui dos políticos';
}

// ================================================================ componentes

function botoesEstados(lista) {
  return h('div', { class: 'botoes-uf' }, lista.map((e) => h('a', { href: `/estado/${e.uf}`, class: 'botao-uf' },
    h('span', { class: 'sigla', style: { background: `linear-gradient(135deg, ${e.cores[0]}, ${e.cores[1]})` } }, e.uf),
    e.nome,
    e.manifestacoes ? h('span', { class: 'qtd' }, e.manifestacoes) : null)));
}

function cardManif(m) {
  const status = m.respostas
    ? h('span', { class: 'etiqueta respondida' }, `${m.respostas}/${m.destinatarios.length} respondeu`)
    : h('span', { class: 'etiqueta aguardando' }, 'Aguardando resposta');
  return h('a', { href: `/e/${m.id}`, class: 'cartao card-manif' },
    h('div', { class: 'etiquetas' },
      h('span', { class: `etiqueta ${m.tipo}` }, TIPO[m.tipo]),
      h('span', { class: 'etiqueta' }, m.uf),
      h('span', { class: 'etiqueta' }, m.tema),
      m.tem_video ? h('span', { class: 'etiqueta' }, '🎥 vídeo') : null),
    h('h3', {}, m.titulo),
    h('p', { class: 'pequeno', style: { margin: 0 } }, m.descricao),
    h('div', { class: 'mini-fotos', title: m.destinatarios.map((d) => d.nome).join(', ') },
      m.destinatarios.slice(0, 9).map((d) => {
        const f = foto(d.foto, d.nome, d.respondeu ? 'ok' : '');
        return f;
      })),
    h('div', { class: 'rodape-card' },
      h('span', {}, m.tipo === 'abaixo_assinado' ? `✍ ${numero(m.apoios)} assinaturas` : `🗳 ${numero(m.apoios)} votos`),
      status));
}

async function listaManifestacoes(filtros) {
  const box = h('div', {});
  const grade = h('div', { class: 'grade grade-cards' });
  const mais = h('button', { class: 'btn btn-fantasma oculto', type: 'button' }, 'Ver mais');
  let pagina = 0;
  async function carregar() {
    const q = new URLSearchParams({ ...filtros, pagina });
    const r = await api(`/api/manifestacoes?${q}`);
    if (!r.itens.length && pagina === 0) {
      grade.replaceChildren(h('p', { class: 'suave' }, 'Nenhuma cobrança ainda. Seja o primeiro!'));
    } else grade.append(...r.itens.map(cardManif));
    mais.classList.toggle('oculto', !r.mais);
  }
  mais.onclick = () => { pagina += 1; carregar(); };
  await carregar();
  box.append(grade, h('div', { style: { textAlign: 'center', marginTop: '16px' } }, mais));
  return box;
}

function cardPolitico(p, extra) {
  return h('a', { href: `/politico/${p.id}`, class: 'politico', style: { textDecoration: 'none' } },
    foto(p.foto, p.nome),
    h('span', { class: 'info' },
      h('span', { class: 'nome' }, p.nome),
      h('span', { class: 'det' }, `${CARGO[p.cargo]}${p.partido ? ` · ${p.partido}` : ''}`),
      extra || null));
}

// ================================================================ páginas

async function inicio() {
  titulo('');
  const lista = await estados();
  const mapa = h('div', { class: 'mapa-box' }, h('p', { class: 'carregando' }, 'Carregando mapa…'));
  const total = lista.reduce((s, e) => s + e.manifestacoes, 0);
  app.replaceChildren(
    h('section', { class: 'hero' },
      h('div', {},
        h('h1', {}, 'Cobre seus políticos. ', h('span', { style: { color: 'var(--verde)' } }, 'Em público.')),
        h('p', { class: 'lead' }, 'O Reclame Aqui dos políticos: crie uma enquete ou um abaixo-assinado, escolha o governador, senadores e até 5 deputados do seu estado para responder, grave um vídeo e compartilhe nas redes.'),
        h('ol', { class: 'passos' },
          h('li', {}, h('span', {}, '1'), 'Clique no seu estado no mapa.'),
          h('li', {}, h('span', {}, '2'), 'Escolha o tema e quem deve responder.'),
          h('li', {}, h('span', {}, '3'), 'Grave um vídeo — a moldura com a bandeira e os políticos é automática.'),
          h('li', {}, h('span', {}, '4'), 'Enviamos por e-mail aos políticos (com cópia para você) e divulgamos nas redes.')),
        h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
          h('a', { href: '/criar', class: 'btn' }, '+ Criar cobrança'),
          h('a', { href: '/ranking', class: 'btn btn-fantasma' }, 'Ver ranking dos políticos')),
        total ? h('p', { class: 'pequeno' }, `${numero(total)} cobranças publicadas até agora.`) : null),
      mapa),
    h('section', { class: 'secao' },
      h('div', { class: 'secao-cab' }, h('h2', {}, 'Ou escolha o estado pelo botão')),
      botoesEstados(lista)),
    h('section', { class: 'secao' },
      h('div', { class: 'secao-cab' }, h('h2', {}, 'Cobranças mais apoiadas')),
      await listaManifestacoes({ ordem: 'populares' })),
  );
  await desenharMapa(mapa, lista, (uf) => navegar(`/estado/${uf}`));
}

async function paginaEstado(uf) {
  const e = (await estados()).find((x) => x.uf === uf);
  if (!e) throw new Error('Estado não encontrado.');
  titulo(e.nome);
  const blocoPoliticos = h('div', {}, h('p', { class: 'carregando' }, 'Consultando Câmara e Senado…'));
  const temaSel = h('select', { 'aria-label': 'Filtrar por tema' }, h('option', { value: '' }, 'Todos os temas'), (await temas()).map((t) => h('option', {}, t)));
  const listaBox = h('div', {});
  const recarregarLista = async () => listaBox.replaceChildren(await listaManifestacoes({ uf, ...(temaSel.value ? { tema: temaSel.value } : {}) }));
  temaSel.onchange = recarregarLista;

  app.replaceChildren(
    h('div', { class: 'cab-estado' },
      h('img', { class: 'bandeira', src: img(e.bandeira), alt: `Bandeira de ${e.nome}`, onerror: (ev) => { ev.target.style.visibility = 'hidden'; } }),
      h('div', {}, h('p', { class: 'pequeno', style: { margin: 0 } }, e.regiao), h('h1', { style: { margin: 0 } }, e.nome)),
      h('a', { href: `/criar?uf=${uf}`, class: 'btn', style: { marginLeft: 'auto' } }, `+ Cobrar políticos de ${uf}`)),
    h('section', { class: 'secao' }, blocoPoliticos),
    h('section', { class: 'secao' },
      h('div', { class: 'secao-cab' }, h('h2', {}, `Cobranças em ${e.nome}`), temaSel),
      listaBox),
  );
  recarregarLista();

  try {
    const d = await politicosDe(uf);
    const busca = h('input', { type: 'search', class: 'filtro', placeholder: 'Buscar deputado por nome ou partido…' });
    const gradeDep = h('div', { class: 'lista-politicos' });
    const pintarDeputados = () => {
      const q = busca.value.trim().toLowerCase();
      gradeDep.replaceChildren(...d.deputados.filter((p) => !q || `${p.nome} ${p.partido}`.toLowerCase().includes(q)).map((p) => cardPolitico(p)));
    };
    busca.oninput = pintarDeputados;
    pintarDeputados();
    blocoPoliticos.replaceChildren(
      d.exemplo ? h('p', { class: 'faixa-exemplo' }, '⚠ Modo de demonstração: os políticos abaixo são FICTÍCIOS (servidor sem acesso às APIs oficiais).') : '',
      h('div', { class: 'grade grade-2' },
        h('div', {}, h('h2', {}, 'Governador(a)'), d.governador ? cardPolitico(d.governador) : h('p', { class: 'suave' }, 'Não informado.')),
        h('div', {}, h('h2', {}, 'Senadores'), h('div', { class: 'lista-politicos' }, d.senadores.map((p) => cardPolitico(p))))),
      h('div', { class: 'secao' },
        h('div', { class: 'secao-cab' }, h('h2', {}, `Deputados federais (${d.deputados.length})`), busca),
        gradeDep));
  } catch (err) {
    blocoPoliticos.replaceChildren(h('p', { class: 'erro-form' }, err.message));
  }
}

// ---------------------------------------------------------------- criar

async function criar() {
  titulo('Criar cobrança');
  const params = new URLSearchParams(location.search);
  const lista = await estados();
  const listaTemas = await temas();
  const estudio = gravacaoSuportada() ? new Estudio() : null;
  estadoGlobal.limpar = () => estudio?.destruir();

  let dadosUf = null;
  const escolhidos = new Map(); // id -> político
  const preSelecionado = params.get('p');

  const erro = h('p', { class: 'erro-form', role: 'alert' });
  const ufSel = h('select', { name: 'uf', required: true },
    h('option', { value: '' }, 'Selecione o estado…'),
    lista.map((e) => h('option', { value: e.uf, selected: e.uf === params.get('uf') }, `${e.nome} (${e.uf})`)));
  const temaSel = h('select', { name: 'tema', required: true },
    h('option', { value: '' }, 'Selecione o tema…'), listaTemas.map((t) => h('option', {}, t)));
  const tituloIn = h('input', { type: 'text', name: 'titulo', maxlength: 140, required: true, placeholder: 'Ex.: Quando o hospital regional vai ser reaberto?' });
  const descIn = h('textarea', { name: 'descricao', maxlength: 5000, required: true, placeholder: 'Explique o problema, desde quando acontece, quem é afetado e o que você espera do político.' });
  const contDesc = h('div', { class: 'contador' }, '0 / 5000');
  descIn.oninput = () => { contDesc.textContent = `${descIn.value.length} / 5000`; };

  const opcoesBox = h('div', {});
  const addOpcao = (v = '') => {
    if (opcoesBox.children.length >= 6) return;
    const inp = h('input', { type: 'text', maxlength: 100, value: v, placeholder: `Opção ${opcoesBox.children.length + 1}` });
    const linha = h('div', { class: 'opcao-linha' }, inp,
      h('button', { type: 'button', class: 'btn btn-fantasma btn-pequeno', 'aria-label': 'Remover opção', onclick: () => { if (opcoesBox.children.length > 2) linha.remove(); } }, '✕'));
    opcoesBox.append(linha);
  };
  ['Sim', 'Não'].forEach(addOpcao);
  const blocoOpcoes = h('div', { class: 'campo' }, h('label', {}, 'Opções de resposta da enquete (2 a 6)'), opcoesBox,
    h('button', { type: 'button', class: 'link-botao', onclick: () => addOpcao() }, '+ adicionar opção'));
  const metaIn = h('input', { type: 'number', name: 'meta', min: 10, max: 10000000, value: 1000 });
  const blocoMeta = h('div', { class: 'campo oculto' }, h('label', {}, 'Meta de assinaturas'), metaIn);

  const tipoRadios = ['enquete', 'abaixo_assinado'].map((t) => h('label', { class: 'tipo' },
    h('input', { type: 'radio', name: 'tipo', value: t, checked: t === (params.get('tipo') || 'enquete') }), ' ',
    h('b', {}, t === 'enquete' ? '🗳 Enquete' : '✍ Abaixo-assinado'),
    h('span', { class: 'pequeno' }, t === 'enquete' ? 'Pergunte e deixe a população votar.' : 'Reúna assinaturas por uma causa.')));
  const tipoAtual = () => tipoRadios.map((l) => l.querySelector('input')).find((i) => i.checked)?.value;
  const atualizarTipo = () => {
    blocoOpcoes.classList.toggle('oculto', tipoAtual() !== 'enquete');
    blocoMeta.classList.toggle('oculto', tipoAtual() !== 'abaixo_assinado');
  };
  tipoRadios.forEach((l) => l.querySelector('input').addEventListener('change', atualizarTipo));
  atualizarTipo();

  const contagem = h('p', { class: 'pequeno' });
  const politicosBox = h('div', {}, h('p', { class: 'suave' }, 'Escolha o estado para ver os políticos.'));

  const emailIn = h('input', { type: 'email', name: 'email_copia', value: estadoGlobal.eu?.email || '', placeholder: 'voce@email.com' });

  function atualizarMoldura() {
    if (!estudio) return;
    const est = lista.find((e) => e.uf === ufSel.value) || null;
    estudio.atualizar({ estado: est, titulo: tituloIn.value.trim(), tema: temaSel.value, politicos: [...escolhidos.values()] });
  }
  tituloIn.addEventListener('input', atualizarMoldura);
  temaSel.addEventListener('change', atualizarMoldura);

  const LIMITES = { governador: 1, senador: 3, deputado: 5 };
  function contar(cargo) {
    return [...escolhidos.values()].filter((p) => p.cargo === cargo).length;
  }
  function atualizarBloqueios() {
    politicosBox.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.disabled = !cb.checked && contar(cb.dataset.cargo) >= LIMITES[cb.dataset.cargo];
    });
    contagem.textContent = `Escolhidos: ${contar('governador')}/1 governador · ${contar('senador')}/3 senadores · ${contar('deputado')}/5 deputados`;
    atualizarMoldura();
  }
  function opcaoPolitico(p) {
    const cb = h('input', { type: 'checkbox', value: p.id, dataset: { cargo: p.cargo }, checked: escolhidos.has(p.id) });
    cb.onchange = () => {
      if (cb.checked) escolhidos.set(p.id, p);
      else escolhidos.delete(p.id);
      atualizarBloqueios();
    };
    return h('label', { class: 'politico' }, cb, foto(p.foto, p.nome),
      h('span', { class: 'info' }, h('span', { class: 'nome' }, p.nome),
        h('span', { class: 'det' }, `${p.partido || ''}${p.tem_email ? '' : ' · sem e-mail público'}`)));
  }

  async function carregarPoliticos() {
    escolhidos.clear();
    const uf = ufSel.value;
    if (!uf) {
      politicosBox.replaceChildren(h('p', { class: 'suave' }, 'Escolha o estado para ver os políticos.'));
      atualizarBloqueios();
      return;
    }
    politicosBox.replaceChildren(h('p', { class: 'carregando' }, 'Consultando Câmara e Senado…'));
    try {
      dadosUf = await politicosDe(uf);
    } catch (e) {
      politicosBox.replaceChildren(h('p', { class: 'erro-form' }, e.message));
      return;
    }
    if (uf !== ufSel.value) return;
    const todos = [dadosUf.governador, ...dadosUf.senadores, ...dadosUf.deputados].filter(Boolean);
    const pre = todos.find((p) => p.id === preSelecionado);
    if (pre) escolhidos.set(pre.id, pre);
    const busca = h('input', { type: 'search', class: 'filtro', placeholder: 'Buscar deputado…' });
    const depBox = h('div', { class: 'lista-politicos' }, dadosUf.deputados.map(opcaoPolitico));
    busca.oninput = () => {
      const q = busca.value.trim().toLowerCase();
      [...depBox.children].forEach((el) => el.classList.toggle('oculto', q && !el.textContent.toLowerCase().includes(q)));
    };
    politicosBox.replaceChildren(
      dadosUf.exemplo ? h('p', { class: 'faixa-exemplo' }, '⚠ Modo de demonstração: políticos FICTÍCIOS.') : '',
      h('h3', {}, 'Governador(a)'),
      h('div', { class: 'lista-politicos' }, dadosUf.governador ? opcaoPolitico(dadosUf.governador) : h('p', { class: 'suave' }, 'Não informado.')),
      h('h3', { style: { marginTop: '16px' } }, 'Senadores (até 3)'),
      h('div', { class: 'lista-politicos' }, dadosUf.senadores.map(opcaoPolitico)),
      h('div', { class: 'secao-cab', style: { marginTop: '16px' } }, h('h3', { style: { margin: 0 } }, 'Deputados federais (até 5)'), busca),
      depBox);
    atualizarBloqueios();
  }
  ufSel.addEventListener('change', carregarPoliticos);

  const progresso = h('progress', { max: 1, value: 0, class: 'oculto', style: { width: '100%' } });
  const enviar = h('button', { type: 'submit', class: 'btn btn-verde btn-bloco' }, 'Publicar e enviar aos políticos');

  const form = h('form', { class: 'grade', novalidate: true },
    h('div', { class: 'cartao' },
      h('h2', {}, '1. O que você quer criar?'),
      h('div', { class: 'tipos' }, tipoRadios)),
    h('div', { class: 'cartao' },
      h('h2', {}, '2. Estado e tema'),
      h('div', { class: 'grade grade-2' },
        h('div', { class: 'campo' }, h('label', {}, 'Estado'), ufSel),
        h('div', { class: 'campo' }, h('label', {}, 'Tema'), temaSel))),
    h('div', { class: 'cartao' },
      h('h2', {}, '3. Quem deve responder?'),
      h('p', { class: 'pequeno' }, 'Escolha o governador, até 3 senadores e até 5 deputados federais. Cada um recebe um e-mail com um link exclusivo para responder publicamente.'),
      contagem, politicosBox),
    h('div', { class: 'cartao' },
      h('h2', {}, '4. Sua cobrança'),
      h('div', { class: 'campo' }, h('label', {}, 'Título'), tituloIn),
      h('div', { class: 'campo' }, h('label', {}, 'Descrição'), descIn, contDesc),
      blocoOpcoes, blocoMeta),
    h('div', { class: 'cartao' },
      h('h2', {}, '5. Vídeo (opcional)'),
      estudio ? h('div', { class: 'estudio' }, estudio.el,
        h('div', {},
          h('p', {}, 'Grave um vídeo de até 3 minutos explicando a sua cobrança. O sistema coloca automaticamente uma moldura com:'),
          h('ul', {}, h('li', {}, 'a bandeira e o nome do estado;'), h('li', {}, 'o título e o tema;'),
            h('li', {}, 'as fotos do governador, senadores e deputados (até 5) escolhidos.')),
          h('p', { class: 'pequeno' }, 'Dica: grave com o celular na vertical — o formato é ideal para Reels, Stories, TikTok e Shorts.')))
        : h('p', { class: 'suave' }, 'Seu navegador não suporta gravação de vídeo. Tente pelo Chrome, Edge, Firefox ou Safari atualizados.')),
    h('div', { class: 'cartao' },
      h('h2', {}, '6. Publicar'),
      h('div', { class: 'campo' }, h('label', {}, 'Seu e-mail (você recebe cópia de tudo que for enviado)'), emailIn),
      erro, progresso, enviar,
      h('p', { class: 'pequeno' }, 'Ao publicar você declara que o conteúdo é verdadeiro e respeitoso. Conteúdo ofensivo pode ser removido.')),
  );

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    erro.textContent = '';
    if (!exigirLogin('Entre para publicar sua cobrança.')) return;
    if (estudio?.gravando()) { erro.textContent = 'Pare a gravação do vídeo antes de publicar.'; return; }
    const fd = new FormData();
    fd.set('tipo', tipoAtual());
    fd.set('uf', ufSel.value);
    fd.set('tema', temaSel.value);
    fd.set('titulo', tituloIn.value);
    fd.set('descricao', descIn.value);
    fd.set('opcoes', JSON.stringify([...opcoesBox.querySelectorAll('input')].map((i) => i.value)));
    fd.set('meta_assinaturas', metaIn.value);
    fd.set('destinatarios', JSON.stringify([...escolhidos.keys()]));
    fd.set('email_copia', emailIn.value);
    if (estudio?.blob) fd.set('video', estudio.blob, `video${estudio.extensao()}`);
    enviar.disabled = true;
    progresso.classList.remove('oculto');
    try {
      const r = await enviarComProgresso('/api/manifestacoes', fd, (p) => { progresso.value = p; });
      estudio?.destruir();
      estadoGlobal.estados = null;
      navegar(`/e/${r.id}?nova=1`);
    } catch (e) {
      if (e.status === 401) abrirLogin('Sua sessão expirou. Entre novamente.');
      erro.textContent = e.message;
      enviar.disabled = false;
      progresso.classList.add('oculto');
    }
  });

  app.replaceChildren(h('h1', {}, 'Criar cobrança'),
    estadoGlobal.eu ? '' : h('p', { class: 'faixa-exemplo' }, 'Você pode preencher agora e entrar com Google, Facebook ou Instagram na hora de publicar.'),
    form);
  if (ufSel.value) carregarPoliticos();
  atualizarBloqueios();
}

// --------------------------------------------------------- manifestação

function blocoCompartilhar(m) {
  const url = `${location.origin}/e/${m.id}`;
  const texto = `${TIPO[m.tipo]} (${m.estado.nome}): ${m.titulo} — participe e cobre junto! #CobraPolítico`;
  const enc = encodeURIComponent;
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(`${texto} ${url}`);
      avisar('Link copiado!');
    } catch {
      prompt('Copie o link:', url);
    }
  };
  const instagram = async () => {
    // Instagram não tem link de compartilhamento na web: usa o menu nativo
    // do celular com o arquivo do vídeo, ou baixa o vídeo e copia a legenda.
    if (m.video && navigator.canShare) {
      try {
        const blob = await fetch(m.video).then((r) => r.blob());
        const arq = new File([blob], `cobranca${m.video.slice(m.video.lastIndexOf('.'))}`, { type: blob.type });
        if (navigator.canShare({ files: [arq] })) {
          await navigator.share({ files: [arq], title: m.titulo, text: `${texto} ${url}` });
          return;
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    await copiar();
    avisar(m.video ? 'Legenda copiada! Baixe o vídeo e publique no Instagram (Reels/Stories).' : 'Legenda copiada! Cole no seu post ou Story do Instagram.');
  };
  return h('div', { class: 'compartilhar' },
    navigator.share ? h('button', { class: 'btn btn-verde', type: 'button', onclick: () => navigator.share({ title: m.titulo, text: texto, url }).catch(() => {}) }, '📤 Compartilhar') : null,
    h('a', { class: 'btn s-whatsapp', target: '_blank', rel: 'noopener', href: `https://wa.me/?text=${enc(`${texto} ${url}`)}` }, 'WhatsApp'),
    h('a', { class: 'btn s-facebook', target: '_blank', rel: 'noopener', href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}` }, 'Facebook'),
    h('button', { class: 'btn s-instagram', type: 'button', onclick: instagram }, 'Instagram'),
    h('a', { class: 'btn s-x', target: '_blank', rel: 'noopener', href: `https://twitter.com/intent/tweet?text=${enc(texto)}&url=${enc(url)}` }, 'X'),
    h('a', { class: 'btn s-telegram', target: '_blank', rel: 'noopener', href: `https://t.me/share/url?url=${enc(url)}&text=${enc(texto)}` }, 'Telegram'),
    h('a', { class: 'btn s-linkedin', target: '_blank', rel: 'noopener', href: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}` }, 'LinkedIn'),
    h('button', { class: 'btn btn-fantasma', type: 'button', onclick: copiar }, '🔗 Copiar link'),
    m.video ? h('a', { class: 'btn btn-fantasma', href: m.video, download: '' }, '⬇ Baixar vídeo') : null);
}

function blocoVotacao(m, recarregar) {
  const total = m.opcoes.reduce((s, o) => s + o.votos, 0);
  return h('div', { class: 'cartao' },
    h('h2', {}, 'Vote nesta enquete'),
    m.opcoes.map((o) => {
      const pct = total ? Math.round((o.votos / total) * 100) : 0;
      return h('button', {
        type: 'button',
        class: `opcao-voto ${m.meu_voto === o.id ? 'minha' : ''}`,
        onclick: async () => {
          if (!exigirLogin('Entre para votar.')) return;
          try {
            await api(`/api/manifestacoes/${m.id}/votar`, { metodo: 'POST', corpo: { opcao_id: o.id } });
            avisar('Voto registrado!');
            recarregar();
          } catch (e) { avisar(e.message, 'erro'); }
        },
      },
      h('span', { class: 'linha' }, h('span', {}, `${m.meu_voto === o.id ? '✔ ' : ''}${o.texto}`), h('span', {}, `${pct}%`)),
      h('span', { class: 'barra' }, h('i', { style: { width: `${pct}%` } })),
      h('span', { class: 'pequeno' }, `${numero(o.votos)} voto(s)`));
    }),
    h('p', { class: 'pequeno' }, `${numero(total)} votos no total. Você pode mudar seu voto.`));
}

function blocoAssinatura(m, recarregar) {
  const meta = m.meta_assinaturas || 1000;
  const pct = Math.min(100, Math.round((m.total_assinaturas / meta) * 100));
  const cidade = h('input', { type: 'text', maxlength: 80, placeholder: 'Sua cidade (opcional)' });
  const coment = h('textarea', { maxlength: 500, placeholder: 'Por que você assina? (opcional)', style: { minHeight: '80px' } });
  const publica = h('input', { type: 'checkbox', checked: true });
  return h('div', { class: 'cartao' },
    h('h2', {}, 'Abaixo-assinado'),
    h('div', { class: 'numero-grande' }, numero(m.total_assinaturas)),
    h('p', { class: 'pequeno' }, `assinaturas de ${numero(meta)} (${pct}% da meta)`),
    h('div', { class: 'barra', style: { margin: '8px 0 16px' } }, h('i', { style: { width: `${pct}%` } })),
    m.assinei
      ? h('p', { style: { fontWeight: 700, color: 'var(--verde)' } }, '✔ Você já assinou. Agora compartilhe!')
      : h('div', { class: 'grade' }, cidade, coment,
        h('label', { class: 'pequeno' }, publica, ' Mostrar meu nome publicamente'),
        h('button', {
          type: 'button',
          class: 'btn btn-verde btn-bloco',
          onclick: async () => {
            if (!exigirLogin('Entre para assinar.')) return;
            try {
              await api(`/api/manifestacoes/${m.id}/assinar`, { metodo: 'POST', corpo: { cidade: cidade.value, comentario: coment.value, publica: publica.checked } });
              avisar('Assinatura registrada! Obrigado.');
              recarregar();
            } catch (e) { avisar(e.message, 'erro'); }
          },
        }, '✍ Assinar')),
    m.assinaturas.length ? h('div', { style: { marginTop: '16px' } }, h('h3', {}, 'Últimas assinaturas'),
      m.assinaturas.slice(0, 10).map((a) => h('p', { class: 'pequeno', style: { margin: '4px 0' } },
        h('b', {}, a.nome), a.cidade ? ` — ${a.cidade}` : '', a.comentario ? `: “${a.comentario}”` : ''))) : null);
}

function diasDesde(iso) {
  return Math.max(0, Math.floor((Date.now() - new Date(`${iso.replace(' ', 'T')}Z`)) / 86400000));
}

async function paginaManifestacao(id) {
  const m = await api(`/api/manifestacoes/${id}`);
  titulo(m.titulo);
  const nova = new URLSearchParams(location.search).get('nova') === '1';
  const recarregar = () => paginaManifestacao(id);

  const respostas = m.destinatarios.map((d) => h('div', { class: `resposta ${d.resposta ? 'respondida' : ''}` },
    h('div', { class: 'cab' }, foto(d.foto, d.nome),
      h('div', {},
        h('a', { href: `/politico/${d.politico_id}` }, h('b', {}, d.nome)),
        h('div', { class: 'pequeno' }, `${CARGO[d.cargo]}${d.partido ? ` · ${d.partido}` : ''}`)),
      h('span', { class: `etiqueta ${d.resposta ? 'respondida' : 'aguardando'}`, style: { marginLeft: 'auto' } },
        d.resposta ? `Respondeu em ${dataBR(d.respondido_em)}` : `Sem resposta há ${diasDesde(m.criado_em)} dia(s)`)),
    d.resposta ? h('div', { class: 'texto' }, d.resposta)
      : h('p', { class: 'pequeno', style: { margin: 0 } },
        d.tem_email ? (d.email_status === 'erro' ? 'Falha ao enviar o e-mail.' : 'Cobrança enviada por e-mail ao gabinete.') : 'Sem e-mail público: compartilhe e marque o político nas redes!')));

  const comentarioIn = h('textarea', { maxlength: 1000, placeholder: 'Escreva um comentário…', style: { minHeight: '80px' } });
  const comentarios = h('div', {}, m.comentarios.map((c) => h('div', { class: 'comentario' }, foto(c.avatar, c.nome, 'avatar'),
    h('div', {}, h('b', {}, c.nome), h('span', { class: 'pequeno' }, ` · ${dataBR(c.criado_em)}`), h('p', {}, c.texto)))));

  app.replaceChildren(
    nova ? h('div', { class: 'cartao', style: { background: 'var(--verde-claro)', borderColor: 'var(--verde)', marginBottom: '20px' } },
      h('h2', {}, '🎉 Cobrança publicada!'),
      h('p', {}, 'Enviamos o e-mail para os políticos escolhidos (com cópia para você). Agora compartilhe para ganhar força:'),
      blocoCompartilhar(m)) : null,
    h('div', { class: 'manif' },
      h('article', {},
        h('div', { class: 'etiquetas' },
          h('span', { class: `etiqueta ${m.tipo}` }, TIPO[m.tipo]),
          h('a', { class: 'etiqueta', href: `/estado/${m.uf}` }, m.estado.nome),
          h('span', { class: 'etiqueta' }, m.tema),
          m.status === 'oculta' ? h('span', { class: 'etiqueta aguardando' }, 'Oculta pela moderação') : null),
        h('h1', { style: { marginTop: '10px' } }, m.titulo),
        h('p', { class: 'pequeno' }, 'Por ', h('b', {}, m.autor.nome), ` em ${dataBR(m.criado_em)}`),
        m.video ? h('video', { src: m.video, controls: true, playsinline: true, preload: 'metadata' }) : null,
        h('div', { class: 'cartao', style: { marginTop: '16px' } }, h('p', { class: 'descricao', style: { margin: 0 } }, m.descricao)),
        h('section', { class: 'secao' },
          h('h2', {}, `Respostas dos políticos (${m.destinatarios.filter((d) => d.resposta).length}/${m.destinatarios.length})`),
          respostas),
        h('section', { class: 'secao' },
          h('h2', {}, `Comentários (${m.comentarios.length})`),
          h('div', { class: 'grade' }, comentarioIn, h('button', {
            type: 'button',
            class: 'btn btn-azul',
            onclick: async () => {
              if (!exigirLogin('Entre para comentar.')) return;
              try {
                await api(`/api/manifestacoes/${m.id}/comentarios`, { metodo: 'POST', corpo: { texto: comentarioIn.value } });
                recarregar();
              } catch (e) { avisar(e.message, 'erro'); }
            },
          }, 'Comentar')),
          comentarios),
        h('p', { class: 'pequeno', style: { marginTop: '24px' } }, h('button', {
          type: 'button',
          class: 'link-botao',
          onclick: async () => {
            if (!exigirLogin('Entre para denunciar.')) return;
            const motivo = prompt('Por que esta publicação deve ser revisada?');
            if (motivo === null) return;
            await api(`/api/manifestacoes/${m.id}/denunciar`, { metodo: 'POST', corpo: { motivo } });
            avisar('Denúncia enviada para a moderação.');
          },
        }, 'Denunciar conteúdo impróprio'),
        estadoGlobal.eu?.admin ? h('span', {}, ' · ', h('button', {
          type: 'button',
          class: 'link-botao',
          onclick: async () => {
            await api(`/api/admin/manifestacoes/${m.id}/status`, { metodo: 'POST', corpo: { status: m.status === 'oculta' ? 'publicada' : 'oculta' } });
            recarregar();
          },
        }, m.status === 'oculta' ? 'Republicar (admin)' : 'Ocultar (admin)')) : null)),
      h('aside', { class: 'grade' },
        m.tipo === 'enquete' ? blocoVotacao(m, recarregar) : blocoAssinatura(m, recarregar),
        h('div', { class: 'cartao' }, h('h2', {}, 'Divulgue'), blocoCompartilhar(m)))));
}

// ------------------------------------------------------------- responder

async function responder(token) {
  titulo('Responder cobrança');
  const r = await api(`/api/responder/${token}`);
  const { destinatario: d, manifestacao: m } = r;
  const erro = h('p', { class: 'erro-form' });
  const resp = h('textarea', { maxlength: 5000, style: { minHeight: '220px' }, placeholder: 'Escreva a resposta do seu gabinete ao cidadão…' });
  app.replaceChildren(h('div', { class: 'grade', style: { maxWidth: '760px', margin: 'auto' } },
    h('div', { class: 'cartao' },
      h('p', { class: 'pequeno' }, `Área de resposta exclusiva de ${CARGO[d.cargo]} ${d.nome}`),
      h('div', { class: 'etiquetas' }, h('span', { class: `etiqueta ${m.tipo}` }, TIPO[m.tipo]), h('span', { class: 'etiqueta' }, m.uf), h('span', { class: 'etiqueta' }, m.tema)),
      h('h1', { style: { marginTop: '10px' } }, m.titulo),
      h('p', { class: 'pequeno' }, `Por ${m.autor} em ${dataBR(m.criado_em)}`),
      h('p', { class: 'descricao', style: { whiteSpace: 'pre-wrap' } }, m.descricao),
      h('a', { href: `/e/${m.id}` }, 'Ver página pública')),
    d.resposta
      ? h('div', { class: 'cartao' }, h('h2', {}, `Respondido em ${dataBR(d.respondido_em)}`), h('p', { style: { whiteSpace: 'pre-wrap' } }, d.resposta))
      : h('div', { class: 'cartao' },
        h('h2', {}, 'Sua resposta'),
        h('p', { class: 'pequeno' }, 'A resposta será publicada na página da cobrança, enviada por e-mail ao cidadão e poderá ser divulgada nas redes sociais. Ela não poderá ser editada depois.'),
        resp, erro,
        h('button', {
          type: 'button',
          class: 'btn btn-verde btn-bloco',
          style: { marginTop: '12px' },
          onclick: async (ev) => {
            ev.target.disabled = true;
            try {
              const out = await api(`/api/responder/${token}`, { metodo: 'POST', corpo: { resposta: resp.value } });
              avisar('Resposta publicada. Obrigado!');
              navegar(out.url);
            } catch (e) {
              erro.textContent = e.message;
              ev.target.disabled = false;
            }
          },
        }, 'Publicar resposta'))));
}

// ---------------------------------------------------------------- ranking

function tabelaRanking(linhas) {
  if (!linhas.length) return h('p', { class: 'suave' }, 'Ainda sem dados suficientes (mínimo de 3 cobranças por político).');
  return h('div', { class: 'tabela-rolagem' }, h('table', { class: 'tabela' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Político'), h('th', {}, 'UF'), h('th', {}, 'Cobranças'), h('th', {}, 'Respondidas'), h('th', {}, 'Tempo médio'), h('th', {}, 'Reputação'))),
    h('tbody', {}, linhas.map((r) => h('tr', {},
      h('td', {}, h('a', { href: `/politico/${r.politico_id}`, style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        foto(r.foto, r.nome, 'avatar'), h('span', {}, h('b', {}, r.nome), h('br'), h('span', { class: 'pequeno' }, `${CARGO[r.cargo]}${r.partido ? ` · ${r.partido}` : ''}`)))),
      h('td', {}, r.uf),
      h('td', {}, numero(r.recebidas)),
      h('td', {}, `${numero(r.respondidas)} (${r.indice ?? 0}%)`),
      h('td', {}, r.dias_medios == null ? '—' : `${r.dias_medios} dia(s)`),
      h('td', {}, h('span', { class: `selo ${classeSelo(r.selo)}` }, r.selo)))))));
}

async function ranking() {
  titulo('Ranking dos políticos');
  const params = new URLSearchParams(location.search);
  const lista = await estados();
  const ufSel = h('select', {}, h('option', { value: '' }, 'Todo o Brasil'), lista.map((e) => h('option', { value: e.uf, selected: e.uf === params.get('uf') }, e.nome)));
  const cargoSel = h('select', {}, h('option', { value: '' }, 'Todos os cargos'),
    Object.entries(CARGO).map(([v, t]) => h('option', { value: v, selected: v === params.get('cargo') }, t)));
  const corpo = h('div', {});
  async function carregar() {
    const q = new URLSearchParams();
    if (ufSel.value) q.set('uf', ufSel.value);
    if (cargoSel.value) q.set('cargo', cargoSel.value);
    history.replaceState(null, '', `/ranking${q.toString() ? `?${q}` : ''}`);
    const r = await api(`/api/ranking?${q}`);
    corpo.replaceChildren(
      h('section', { class: 'secao' }, h('h2', {}, '🏆 Quem mais responde'), tabelaRanking(r.melhores)),
      h('section', { class: 'secao' }, h('h2', {}, '🚨 Quem menos responde'), tabelaRanking(r.piores)),
      h('section', { class: 'secao' }, h('h2', {}, '📣 Mais cobrados'), r.mais_cobrados.length ? tabelaRanking(r.mais_cobrados) : h('p', { class: 'suave' }, 'Nenhuma cobrança ainda.')));
  }
  ufSel.onchange = carregar;
  cargoSel.onchange = carregar;
  app.replaceChildren(
    h('h1', {}, 'Ranking dos políticos'),
    h('p', { class: 'suave' }, 'A reputação é o percentual de cobranças respondidas: Ótimo (80%+), Bom (60%+), Regular (40%+), Ruim (20%+) e Não recomendado. Políticos com menos de 3 cobranças ficam "Em avaliação".'),
    h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } }, ufSel, cargoSel),
    corpo);
  await carregar();
}

async function paginaPolitico(id) {
  const uf = (id.match(/^gov-([A-Z]{2})$/) || [])[1];
  const { politico: stats } = await api(`/api/politicos/${encodeURIComponent(id)}`);
  // Dados cadastrais: procura nos estados (a partir do ranking ou da lista do estado).
  let p = stats ? { id, nome: stats.nome, cargo: stats.cargo, partido: stats.partido, uf: stats.uf, foto: stats.foto } : null;
  const ufBusca = p?.uf || uf || new URLSearchParams(location.search).get('uf');
  if (ufBusca) {
    try {
      const d = await politicosDe(ufBusca);
      const achado = [d.governador, ...d.senadores, ...d.deputados].find((x) => x && x.id === id);
      if (achado) p = { ...achado };
    } catch { /* usa o que tiver */ }
  }
  if (!p) {
    // Deputado/senador ainda sem cobranças: busca nos estados já carregados
    for (const prom of cachePoliticos.values()) {
      const d = await prom.catch(() => null);
      const achado = d && [d.governador, ...d.senadores, ...d.deputados].find((x) => x && x.id === id);
      if (achado) { p = achado; break; }
    }
  }
  if (!p) throw new Error('Político não encontrado. Acesse pela página do estado.');
  titulo(p.nome);
  app.replaceChildren(
    h('div', { class: 'cartao', style: { display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' } },
      (() => { const f = foto(p.foto, p.nome); f.style.width = '96px'; f.style.height = '96px'; f.style.borderRadius = '50%'; f.style.objectFit = 'cover'; return f; })(),
      h('div', {},
        h('h1', { style: { margin: 0 } }, p.nome),
        h('p', { class: 'suave', style: { margin: 0 } }, `${CARGO[p.cargo]}${p.partido ? ` · ${p.partido}` : ''} · ${p.uf}`),
        p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener', class: 'pequeno' }, 'Perfil oficial ↗') : null),
      h('div', { style: { marginLeft: 'auto', textAlign: 'center' } },
        h('span', { class: `selo ${classeSelo(stats?.selo)}`, style: { fontSize: '1rem' } }, stats?.selo || 'Sem cobranças'),
        stats ? h('p', { class: 'pequeno' }, `${stats.respondidas} de ${stats.recebidas} cobranças respondidas`) : null),
      h('a', { href: `/criar?uf=${p.uf}&p=${p.id}`, class: 'btn' }, `Cobrar ${p.nome.split(' ')[0]}`)),
    h('section', { class: 'secao' }, h('h2', {}, 'Cobranças recebidas'), await listaManifestacoes({ politico: id })));
}

async function minhas() {
  titulo('Minhas cobranças');
  if (!estadoGlobal.eu) {
    app.replaceChildren(h('div', { class: 'cartao' }, h('h2', {}, 'Minhas cobranças'), h('p', {}, 'Entre para ver suas cobranças.'),
      h('button', { class: 'btn', onclick: () => abrirLogin() }, 'Entrar')));
    return;
  }
  const emailIn = h('input', { type: 'email', value: estadoGlobal.eu.email || '', placeholder: 'voce@email.com' });
  app.replaceChildren(
    h('h1', {}, 'Minhas cobranças'),
    h('div', { class: 'cartao', style: { marginBottom: '20px' } },
      h('div', { class: 'campo' }, h('label', {}, 'E-mail para receber cópias e respostas'), emailIn),
      h('button', {
        class: 'btn btn-azul',
        type: 'button',
        onclick: async () => {
          try {
            await api('/api/eu/email', { metodo: 'POST', corpo: { email: emailIn.value } });
            estadoGlobal.eu.email = emailIn.value;
            avisar('E-mail salvo.');
          } catch (e) { avisar(e.message, 'erro'); }
        },
      }, 'Salvar e-mail')),
    await listaManifestacoes({ minhas: '1' }));
}

// ================================================================ início

carregarEu().catch(() => desenharUsuario()).finally(rotear);
