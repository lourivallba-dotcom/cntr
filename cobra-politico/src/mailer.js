'use strict';

const nodemailer = require('nodemailer');
const config = require('./config');

let transporte = null;
function obterTransporte() {
  if (!config.smtp.url) return null;
  if (!transporte) {
    transporte = nodemailer.createTransport(config.smtp.url, {
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }
  return transporte;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function paragrafos(texto) {
  return esc(texto).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

const CARGO = { governador: 'Governador(a)', senador: 'Senador(a)', deputado: 'Deputado(a) Federal' };
const TIPO = { enquete: 'enquete', abaixo_assinado: 'abaixo-assinado' };

function layout(conteudo) {
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;background:#f4f6f8;margin:0;padding:24px">
<div style="max-width:620px;margin:auto;background:#fff;border-radius:12px;padding:28px;color:#1d2433">
<div style="font-weight:800;font-size:20px;color:#0b6b3a;margin-bottom:16px">${esc(config.nomeSite)}</div>
${conteudo}
<hr style="border:none;border-top:1px solid #e3e7ec;margin:24px 0">
<p style="font-size:12px;color:#6b7686">Mensagem enviada pela plataforma ${esc(config.nomeSite)} em nome de um cidadão.
Endereço de origem: ${esc(config.baseUrl)}</p></div></body></html>`;
}

// E-mail para cada político escolhido, com cópia para quem criou a enquete.
function emailParaPolitico({ manifestacao, destinatario, autor, estado, totalApoios }) {
  const linkPublico = `${config.baseUrl}/e/${manifestacao.id}`;
  const linkResposta = `${config.baseUrl}/responder/${destinatario.token}`;
  const tipo = TIPO[manifestacao.tipo];
  const assunto = `[${config.nomeSite}] Nova ${tipo} para ${CARGO[destinatario.cargo]} ${destinatario.nome}: ${manifestacao.titulo}`;
  const texto = [
    `Prezado(a) ${CARGO[destinatario.cargo]} ${destinatario.nome},`,
    '',
    `O(a) cidadão(ã) ${autor.nome}, do estado de ${estado.nome}, publicou uma ${tipo} direcionada ao seu mandato no tema "${manifestacao.tema}".`,
    '',
    manifestacao.titulo,
    '',
    manifestacao.descricao,
    '',
    totalApoios ? `Apoios até agora: ${totalApoios}` : '',
    `Ver publicamente: ${linkPublico}`,
    `Responder (link exclusivo do seu gabinete — não compartilhe): ${linkResposta}`,
    '',
    'A resposta será publicada na página da enquete e enviada ao cidadão.',
  ].filter((l) => l !== null).join('\n');
  const html = layout(`
<p>Prezado(a) <b>${esc(CARGO[destinatario.cargo])} ${esc(destinatario.nome)}</b>,</p>
<p>O(a) cidadão(ã) <b>${esc(autor.nome)}</b>, do estado de <b>${esc(estado.nome)}</b>, publicou uma
<b>${esc(tipo)}</b> direcionada ao seu mandato no tema <b>${esc(manifestacao.tema)}</b>:</p>
<div style="border-left:4px solid #0b6b3a;padding:4px 16px;margin:16px 0;background:#f6faf7">
<h2 style="margin:8px 0;font-size:18px">${esc(manifestacao.titulo)}</h2>${paragrafos(manifestacao.descricao)}</div>
<p style="text-align:center;margin:24px 0">
<a href="${esc(linkResposta)}" style="background:#0b6b3a;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Responder ao cidadão</a></p>
<p style="font-size:13px">O link acima é exclusivo do seu gabinete. A resposta ficará pública na página
<a href="${esc(linkPublico)}">${esc(linkPublico)}</a>.</p>`);
  return { assunto, texto, html };
}

function emailRespostaParaAutor({ manifestacao, destinatario }) {
  const link = `${config.baseUrl}/e/${manifestacao.id}`;
  const assunto = `[${config.nomeSite}] ${CARGO[destinatario.cargo]} ${destinatario.nome} respondeu: ${manifestacao.titulo}`;
  const texto = `${CARGO[destinatario.cargo]} ${destinatario.nome} respondeu à sua ${TIPO[manifestacao.tipo]} "${manifestacao.titulo}":\n\n${destinatario.resposta}\n\nVeja e compartilhe: ${link}`;
  const html = layout(`<p><b>${esc(CARGO[destinatario.cargo])} ${esc(destinatario.nome)}</b> respondeu à sua ${esc(TIPO[manifestacao.tipo])}
<b>${esc(manifestacao.titulo)}</b>:</p>
<div style="border-left:4px solid #1d4f9a;padding:4px 16px;margin:16px 0;background:#f4f7fc">${paragrafos(destinatario.resposta)}</div>
<p><a href="${esc(link)}">Veja a resposta e compartilhe nas redes sociais</a></p>`);
  return { assunto, texto, html };
}

function criarMailer(db) {
  const registrar = db.prepare('INSERT INTO emails (para, cc, assunto, corpo, status, erro) VALUES (?, ?, ?, ?, ?, ?)');

  // Retorna 'enviado', 'simulado' (sem SMTP configurado) ou 'erro'.
  async function enviar({ para, cc, assunto, texto, html }) {
    const t = obterTransporte();
    if (!t) {
      console.log(`[email simulado] para=${para} cc=${cc || '-'} assunto="${assunto}"`);
      registrar.run(para, cc || null, assunto, texto, 'simulado', null);
      return 'simulado';
    }
    try {
      await t.sendMail({
        from: config.smtp.from,
        replyTo: config.smtp.replyTo,
        to: para,
        cc: cc || undefined,
        subject: assunto,
        text: texto,
        html,
      });
      registrar.run(para, cc || null, assunto, texto, 'enviado', null);
      return 'enviado';
    } catch (e) {
      console.error(`[email] falha para ${para}: ${e.message}`);
      registrar.run(para, cc || null, assunto, texto, 'erro', e.message);
      return 'erro';
    }
  }

  return { enviar };
}

module.exports = { criarMailer, emailParaPolitico, emailRespostaParaAutor, CARGO };
