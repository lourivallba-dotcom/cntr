// Utilitários do front-end (sem framework).

// Cria elementos sem innerHTML, para nunca interpretar texto de usuário como HTML.
export function h(tag, attrs = {}, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const f of filhos.flat(Infinity)) {
    if (f === null || f === undefined || f === false) continue;
    el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...filhos) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const f of filhos.flat()) el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  return el;
}

export class ErroApi extends Error {
  constructor(msg, status) {
    super(msg);
    this.status = status;
  }
}

export async function api(caminho, { metodo = 'GET', corpo, form } = {}) {
  const opcoes = { method: metodo, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (form) opcoes.body = form;
  else if (corpo !== undefined) {
    opcoes.headers['Content-Type'] = 'application/json';
    opcoes.body = JSON.stringify(corpo);
  }
  const resp = await fetch(caminho, opcoes);
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new ErroApi(json.erro || `Erro ${resp.status}`, resp.status);
  return json;
}

// Envio com barra de progresso (fetch não informa progresso de upload).
export function enviarComProgresso(caminho, form, aoProgresso) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', caminho);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => e.lengthComputable && aoProgresso(e.loaded / e.total);
    xhr.onload = () => {
      let json = {};
      try { json = JSON.parse(xhr.responseText); } catch { /* vazio */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(json);
      else reject(new ErroApi(json.erro || `Erro ${xhr.status}`, xhr.status));
    };
    xhr.onerror = () => reject(new ErroApi('Falha de conexão.', 0));
    xhr.send(form);
  });
}

let timerAviso;
export function avisar(msg, tipo = 'ok') {
  const el = document.getElementById('aviso');
  el.textContent = msg;
  el.className = `aviso visivel ${tipo === 'erro' ? 'erro' : ''}`;
  clearTimeout(timerAviso);
  timerAviso = setTimeout(() => el.classList.remove('visivel'), 4500);
}

export function img(url) {
  return url ? `/api/img?url=${encodeURIComponent(url)}` : '';
}

export function iniciais(nome = '') {
  return nome.replace(/\(.*?\)/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

// Foto redonda com fallback para as iniciais quando a imagem não carrega.
export function foto(url, nome, classe = 'foto') {
  const reserva = h('span', { class: classe, 'aria-hidden': 'true' }, iniciais(nome));
  if (!url) return reserva;
  const el = h('img', { class: classe, src: img(url), alt: '', loading: 'lazy' });
  el.addEventListener('error', () => el.replaceWith(reserva), { once: true });
  return el;
}

export function dataBR(iso) {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function numero(n) {
  return Number(n || 0).toLocaleString('pt-BR');
}

export const CARGO = { governador: 'Governador(a)', senador: 'Senador(a)', deputado: 'Deputado(a) federal' };
export const TIPO = { enquete: 'Enquete', abaixo_assinado: 'Abaixo-assinado' };

export function classeSelo(selo) {
  return {
    'Ótimo': 'selo-otimo', Bom: 'selo-bom', Regular: 'selo-regular', Ruim: 'selo-ruim', 'Não recomendado': 'selo-nao',
  }[selo] || 'selo-neutro';
}
