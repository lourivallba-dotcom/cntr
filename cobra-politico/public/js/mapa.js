// Mapa do Brasil em SVG: cada estado é um botão acessível (mouse, toque e teclado).
import { h, s } from './util.js';

let dadosMapa;
async function carregarMapa() {
  if (!dadosMapa) dadosMapa = await fetch('/data/brasil-mapa.json').then((r) => r.json());
  return dadosMapa;
}

export async function desenharMapa(container, estados, aoEscolher) {
  const mapa = await carregarMapa();
  const porUf = Object.fromEntries(estados.map((e) => [e.uf, e]));
  const dica = h('div', { class: 'mapa-dica oculto' });
  const svg = s('svg', { viewBox: mapa.viewBox, role: 'group', 'aria-label': 'Mapa do Brasil: escolha um estado' });
  const rotulos = [];

  for (const loc of mapa.locations) {
    const uf = loc.id.toUpperCase();
    const e = porUf[uf];
    if (!e) continue;
    const rotulo = `${e.nome}${e.manifestacoes ? ` — ${e.manifestacoes} cobrança(s)` : ''}`;
    const caminho = s('path', {
      d: loc.path,
      tabindex: '0',
      role: 'button',
      'aria-label': rotulo,
      class: e.manifestacoes ? 'tem-cobranca' : '',
      onclick: () => aoEscolher(uf),
      onkeydown: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          aoEscolher(uf);
        }
      },
      onmousemove: (ev) => {
        const r = container.getBoundingClientRect();
        dica.textContent = rotulo;
        dica.style.left = `${ev.clientX - r.left}px`;
        dica.style.top = `${ev.clientY - r.top}px`;
        dica.classList.remove('oculto');
      },
      onmouseleave: () => dica.classList.add('oculto'),
    });
    caminho.append(s('title', {}, rotulo));
    svg.append(caminho);
    rotulos.push([caminho, uf]);
  }

  container.replaceChildren(svg, dica);
  // Siglas no centro de cada estado (precisa estar no DOM para medir).
  const pequenos = new Set(['DF', 'SE', 'AL', 'RN', 'PB', 'ES', 'RJ']);
  for (const [caminho, uf] of rotulos) {
    if (pequenos.has(uf)) continue;
    const b = caminho.getBBox();
    svg.append(s('text', { x: b.x + b.width / 2, y: b.y + b.height / 2 }, uf));
  }
}
