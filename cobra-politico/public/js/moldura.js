// Estúdio de vídeo: grava pela câmera (ou reprocessa um vídeo do celular)
// desenhando por cima uma moldura com a bandeira do estado, o título e as
// fotos do governador, senadores e deputados escolhidos para responder.
import { h, img, iniciais } from './util.js';

const L = 720;
const A = 1280;
const DURACAO_MAX = 180; // segundos
const CARGO_CURTO = { governador: 'Governador', senador: 'Senador', deputado: 'Deputado' };

const TIPOS_MIME = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function gravacaoSuportada() {
  return Boolean(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream && navigator.mediaDevices?.getUserMedia);
}

function escolherMime() {
  return TIPOS_MIME.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function carregarImagem(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => resolve(null);
    i.src = img(url);
  });
}

function nomeCurto(nome) {
  const partes = nome.replace(/\(.*?\)/g, '').trim().split(/\s+/);
  return partes.length <= 2 ? partes.join(' ') : `${partes[0]} ${partes[partes.length - 1]}`;
}

function quebrarTexto(ctx, texto, largura, maxLinhas) {
  const palavras = texto.split(/\s+/);
  const linhas = [];
  let atual = '';
  for (const p of palavras) {
    const teste = atual ? `${atual} ${p}` : p;
    if (ctx.measureText(teste).width > largura && atual) {
      linhas.push(atual);
      atual = p;
    } else atual = teste;
  }
  if (atual) linhas.push(atual);
  if (linhas.length > maxLinhas) {
    linhas.length = maxLinhas;
    let ult = linhas[maxLinhas - 1];
    while (ctx.measureText(`${ult}…`).width > largura && ult.length) ult = ult.slice(0, -1);
    linhas[maxLinhas - 1] = `${ult}…`;
  }
  return linhas;
}

function cobrirImagem(ctx, fonte, fw, fh, x, y, w, h, espelhar) {
  const escala = Math.max(w / fw, h / fh);
  const dw = fw * escala;
  const dh = fh * escala;
  ctx.save();
  if (espelhar) {
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(fonte, (w - dw) / 2, (h - dh) / 2 + 0, dw, dh);
  } else {
    ctx.drawImage(fonte, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }
  ctx.restore();
}

export class Estudio {
  constructor() {
    this.canvas = h('canvas', { width: L, height: A, 'aria-label': 'Prévia do vídeo com moldura' });
    this.ctx = this.canvas.getContext('2d');
    this.fonte = null; // <video> da câmera ou do arquivo
    this.espelhar = false;
    this.stream = null;
    this.gravador = null;
    this.blob = null;
    this.mime = '';
    this.dados = { estado: null, titulo: '', tema: '', politicos: [] };
    this.imagens = new Map();
    this.facing = 'user';
    this.desenhando = false;
    this.el = this.montar();
    this.desenharQuadro();
  }

  montar() {
    this.statusRec = h('span', { class: 'rec oculto' }, '● REC 0:00');
    this.player = h('video', { class: 'oculto', controls: true, playsinline: true });
    this.tela = h('div', { class: 'tela-video' }, this.canvas, this.player, this.statusRec);
    this.inputArquivo = h('input', { type: 'file', accept: 'video/*', class: 'oculto', onchange: (e) => this.usarArquivo(e.target.files[0]) });

    this.bCamera = h('button', { type: 'button', class: 'btn btn-azul', onclick: () => this.ligarCamera() }, '📷 Ligar câmera');
    this.bTrocar = h('button', { type: 'button', class: 'btn btn-fantasma oculto', onclick: () => this.trocarCamera() }, '🔄 Trocar câmera');
    this.bArquivo = h('button', { type: 'button', class: 'btn btn-fantasma', onclick: () => this.inputArquivo.click() }, '📁 Usar vídeo do celular');
    this.bGravar = h('button', { type: 'button', class: 'btn btn-vermelho oculto', onclick: () => this.gravar() }, '⏺ Gravar');
    this.bParar = h('button', { type: 'button', class: 'btn btn-vermelho oculto', onclick: () => this.parar() }, '⏹ Parar');
    this.bRefazer = h('button', { type: 'button', class: 'btn btn-fantasma oculto', onclick: () => this.refazer() }, '↺ Gravar de novo');
    this.bBaixar = h('a', { class: 'btn btn-fantasma oculto', download: 'cobranca.webm' }, '⬇ Baixar vídeo');
    this.msg = h('p', { class: 'pequeno' },
      gravacaoSuportada()
        ? `Grave até ${DURACAO_MAX / 60} minutos. A moldura com a bandeira e os políticos escolhidos entra automaticamente no vídeo.`
        : 'Seu navegador não permite gravar vídeo aqui. Você pode publicar sem vídeo.');

    return h('div', {},
      this.tela,
      h('div', { class: 'controles-video' }, this.bCamera, this.bTrocar, this.bArquivo, this.bGravar, this.bParar, this.bRefazer, this.bBaixar),
      this.inputArquivo, this.msg);
  }

  async atualizar(dados) {
    this.dados = { ...this.dados, ...dados };
    const urls = [this.dados.estado?.bandeira, ...this.dados.politicos.map((p) => p.foto)].filter(Boolean);
    await Promise.all(urls.filter((u) => !this.imagens.has(u)).map(async (u) => {
      this.imagens.set(u, null);
      this.imagens.set(u, await carregarImagem(u));
    }));
    if (!this.desenhando) this.desenharQuadro();
  }

  // ------------------------------------------------------------ fontes

  pararFonte() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.fonte) {
      this.fonte.pause();
      if (this.fonte.dataset.url) URL.revokeObjectURL(this.fonte.dataset.url);
    }
    this.fonte = null;
    this.audioCtx?.close();
    this.audioCtx = null;
  }

  async ligarCamera() {
    this.pararFonte();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.facing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      this.msg.textContent = e.name === 'NotAllowedError'
        ? 'Permita o acesso à câmera e ao microfone nas configurações do navegador.'
        : 'Não foi possível abrir a câmera neste aparelho.';
      return;
    }
    const v = h('video', { playsinline: true, muted: true, autoplay: true });
    v.muted = true;
    v.srcObject = this.stream;
    await v.play().catch(() => {});
    this.fonte = v;
    this.espelhar = this.facing === 'user';
    this.audioTracks = this.stream.getAudioTracks();
    this.modo = 'camera';
    this.prontoParaGravar();
  }

  async trocarCamera() {
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    await this.ligarCamera();
  }

  async usarArquivo(arquivo) {
    if (!arquivo) return;
    this.pararFonte();
    const url = URL.createObjectURL(arquivo);
    const v = h('video', { playsinline: true });
    v.dataset.url = url;
    v.src = url;
    v.muted = false;
    await new Promise((ok) => { v.onloadedmetadata = ok; v.onerror = ok; });
    if (!v.videoWidth) {
      this.msg.textContent = 'Formato de vídeo não suportado por este navegador.';
      return;
    }
    if (v.duration > DURACAO_MAX) this.msg.textContent = `O vídeo será cortado em ${DURACAO_MAX / 60} minutos.`;
    // O áudio do arquivo vai para a gravação (não para o alto-falante).
    this.audioCtx = new AudioContext();
    const destino = this.audioCtx.createMediaStreamDestination();
    this.audioCtx.createMediaElementSource(v).connect(destino);
    this.audioTracks = destino.stream.getAudioTracks();
    this.fonte = v;
    this.espelhar = false;
    this.modo = 'arquivo';
    v.currentTime = 0.01;
    this.prontoParaGravar();
    this.msg.textContent = 'Clique em "Gravar" para gerar o vídeo com a moldura (ele é reproduzido do início ao fim).';
  }

  prontoParaGravar() {
    this.blob = null;
    this.player.classList.add('oculto');
    this.canvas.classList.remove('oculto');
    this.bGravar.classList.remove('oculto');
    this.bTrocar.classList.toggle('oculto', this.modo !== 'camera');
    this.bRefazer.classList.add('oculto');
    this.bBaixar.classList.add('oculto');
    this.iniciarLaco();
  }

  // ---------------------------------------------------------- desenho

  iniciarLaco() {
    if (this.desenhando) return;
    this.desenhando = true;
    const passo = () => {
      if (!this.desenhando) return;
      this.desenharQuadro();
      requestAnimationFrame(passo);
    };
    requestAnimationFrame(passo);
  }

  desenharQuadro() {
    const c = this.ctx;
    const { estado, titulo, tema, politicos } = this.dados;
    const cores = estado?.cores || ['#0b6b3a', '#1d4f9a'];

    c.fillStyle = '#111';
    c.fillRect(0, 0, L, A);
    const f = this.fonte;
    if (f && f.videoWidth) cobrirImagem(c, f, f.videoWidth, f.videoHeight, 0, 0, L, A, this.espelhar);
    else {
      c.fillStyle = '#9aa4b2';
      c.font = '600 30px system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText('Ligue a câmera ou escolha um vídeo', L / 2, A / 2);
    }

    // Faixa superior: bandeira + estado + título
    const grad = c.createLinearGradient(0, 0, 0, 260);
    grad.addColorStop(0, 'rgba(0,0,0,.85)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = grad;
    c.fillRect(0, 0, L, 260);

    const bandeira = estado && this.imagens.get(estado.bandeira);
    let xTexto = 34;
    if (bandeira) {
      const bh = 84;
      const bw = Math.min(140, (bandeira.width / bandeira.height) * bh);
      c.drawImage(bandeira, 34, 36, bw, bh);
      c.strokeStyle = 'rgba(255,255,255,.8)';
      c.lineWidth = 2;
      c.strokeRect(34, 36, bw, bh);
      xTexto = 34 + bw + 20;
    } else if (estado) {
      c.fillStyle = cores[0];
      c.fillRect(34, 36, 120, 84);
      c.fillStyle = '#fff';
      c.font = '800 40px system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText(estado.uf, 94, 92);
      xTexto = 174;
    }
    c.textAlign = 'left';
    c.fillStyle = '#f7d116';
    c.font = '800 24px system-ui, sans-serif';
    c.fillText('COBRANÇA AO VIVO', xTexto, 62);
    c.fillStyle = '#fff';
    c.font = '700 34px system-ui, sans-serif';
    c.fillText(estado ? estado.nome : 'Escolha o estado', xTexto, 102);
    if (tema) {
      c.font = '600 22px system-ui, sans-serif';
      c.fillStyle = 'rgba(255,255,255,.85)';
      c.fillText(`Tema: ${tema}`, xTexto, 132);
    }
    if (titulo) {
      c.font = '800 36px system-ui, sans-serif';
      c.fillStyle = '#fff';
      c.shadowColor = 'rgba(0,0,0,.7)';
      c.shadowBlur = 8;
      quebrarTexto(c, titulo, L - 68, 2).forEach((linha, i) => c.fillText(linha, 34, 182 + i * 42));
      c.shadowBlur = 0;
    }

    // Painel inferior: quem deve responder
    const lista = politicos.slice(0, 9);
    const porLinha = 5;
    const linhas = Math.max(1, Math.ceil(lista.length / porLinha));
    const alturaPainel = 70 + linhas * 150 + 50;
    const y0 = A - alturaPainel;
    const g2 = c.createLinearGradient(0, y0 - 60, 0, A);
    g2.addColorStop(0, 'rgba(0,0,0,0)');
    g2.addColorStop(0.25, 'rgba(0,0,0,.78)');
    g2.addColorStop(1, 'rgba(0,0,0,.92)');
    c.fillStyle = g2;
    c.fillRect(0, y0 - 60, L, alturaPainel + 60);

    c.fillStyle = '#f7d116';
    c.font = '800 24px system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText(lista.length ? 'QUEM DEVE RESPONDER' : 'Escolha quem deve responder', L / 2, y0 + 34);

    lista.forEach((p, i) => {
      const linha = Math.floor(i / porLinha);
      const naLinha = Math.min(porLinha, lista.length - linha * porLinha);
      const col = i % porLinha;
      const passoX = L / porLinha;
      const x = L / 2 + (col - (naLinha - 1) / 2) * passoX;
      const y = y0 + 110 + linha * 150;
      const r = 46;
      const corCargo = p.cargo === 'governador' ? '#f7d116' : p.cargo === 'senador' ? '#4f8fe8' : '#3ecf7a';
      c.save();
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.closePath();
      c.fillStyle = '#e8eef7';
      c.fill();
      c.clip();
      const foto = this.imagens.get(p.foto);
      if (foto) cobrirImagem(c, foto, foto.width, foto.height, x - r, y - r, r * 2, r * 2, false);
      else {
        c.fillStyle = '#1d4f9a';
        c.font = '800 32px system-ui, sans-serif';
        c.fillText(iniciais(p.nome), x, y + 11);
      }
      c.restore();
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.lineWidth = 5;
      c.strokeStyle = corCargo;
      c.stroke();
      c.fillStyle = '#fff';
      c.font = '700 19px system-ui, sans-serif';
      const nome = quebrarTexto(c, nomeCurto(p.nome), passoX - 10, 1)[0];
      c.fillText(nome, x, y + r + 26);
      c.fillStyle = corCargo;
      c.font = '700 15px system-ui, sans-serif';
      const sub = `${CARGO_CURTO[p.cargo]}${p.partido ? ` · ${p.partido}` : ''}`;
      c.fillText(quebrarTexto(c, sub, passoX - 10, 1)[0], x, y + r + 46);
    });

    c.fillStyle = 'rgba(255,255,255,.9)';
    c.font = '700 22px system-ui, sans-serif';
    c.fillText(`#CobraPolítico  •  ${location.host}`, L / 2, A - 26);

    // Borda nas cores do estado
    const g3 = c.createLinearGradient(0, 0, L, A);
    g3.addColorStop(0, cores[0]);
    g3.addColorStop(1, cores[1] || cores[0]);
    c.lineWidth = 16;
    c.strokeStyle = g3;
    c.strokeRect(8, 8, L - 16, A - 16);
  }

  // --------------------------------------------------------- gravação

  async gravar() {
    if (!this.fonte) return;
    this.mime = escolherMime();
    const stream = this.canvas.captureStream(30);
    (this.audioTracks || []).forEach((t) => stream.addTrack(t));
    const partes = [];
    try {
      this.gravador = new MediaRecorder(stream, { mimeType: this.mime || undefined, videoBitsPerSecond: 3_000_000 });
    } catch {
      this.gravador = new MediaRecorder(stream);
    }
    this.mime = this.gravador.mimeType || this.mime || 'video/webm';
    this.gravador.ondataavailable = (e) => e.data.size && partes.push(e.data);
    this.gravador.onstop = () => this.finalizar(partes);

    if (this.modo === 'arquivo') {
      if (this.audioCtx?.state === 'suspended') await this.audioCtx.resume();
      this.fonte.currentTime = 0;
      this.fonte.onended = () => this.parar();
      await this.fonte.play();
    }
    this.gravador.start(1000);
    this.inicio = Date.now();
    this.statusRec.classList.remove('oculto');
    this.bGravar.classList.add('oculto');
    this.bCamera.classList.add('oculto');
    this.bArquivo.classList.add('oculto');
    this.bTrocar.classList.add('oculto');
    this.bParar.classList.remove('oculto');
    this.cronometro = setInterval(() => {
      const seg = Math.floor((Date.now() - this.inicio) / 1000);
      this.statusRec.textContent = `● REC ${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, '0')}`;
      if (seg >= DURACAO_MAX) this.parar();
    }, 250);
  }

  parar() {
    clearInterval(this.cronometro);
    if (this.gravador && this.gravador.state !== 'inactive') this.gravador.stop();
    if (this.modo === 'arquivo') this.fonte?.pause();
  }

  finalizar(partes) {
    this.desenhando = false;
    this.pararFonte();
    this.blob = new Blob(partes, { type: this.mime.split(';')[0] });
    const url = URL.createObjectURL(this.blob);
    this.player.src = url;
    this.player.classList.remove('oculto');
    this.canvas.classList.add('oculto');
    this.statusRec.classList.add('oculto');
    this.bParar.classList.add('oculto');
    this.bRefazer.classList.remove('oculto');
    this.bCamera.classList.remove('oculto');
    this.bArquivo.classList.remove('oculto');
    this.bBaixar.href = url;
    this.bBaixar.download = `cobranca${this.extensao()}`;
    this.bBaixar.classList.remove('oculto');
    const mb = (this.blob.size / 1048576).toFixed(1);
    this.msg.textContent = `Vídeo pronto (${mb} MB). Ele será publicado junto com a sua cobrança.`;
  }

  refazer() {
    this.blob = null;
    this.player.removeAttribute('src');
    this.player.classList.add('oculto');
    this.canvas.classList.remove('oculto');
    this.bRefazer.classList.add('oculto');
    this.bBaixar.classList.add('oculto');
    this.desenharQuadro();
    this.msg.textContent = 'Ligue a câmera ou escolha um vídeo para gravar de novo.';
  }

  extensao() {
    return this.mime.startsWith('video/mp4') ? '.mp4' : '.webm';
  }

  gravando() {
    return this.gravador?.state === 'recording';
  }

  destruir() {
    this.parar();
    this.desenhando = false;
    this.pararFonte();
  }
}
