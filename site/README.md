# Site — ALBS Transportes

Site institucional estático (um único `index.html`, sem build). Basta publicar a
pasta `site/` em qualquer hospedagem estática (Hostinger, Netlify, Vercel,
GitHub Pages, cPanel etc.) apontando o domínio `albstransportes.com.br`.

## O que editar antes de publicar

Dados de exemplo que precisam ser trocados pelos reais em `index.html`:

| Item | Onde |
| --- | --- |
| Número do WhatsApp (DDI+DDD, só dígitos) | constante `WHATSAPP` no `<script>` no fim do arquivo |
| Telefone exibido `(00) 00000-0000` | seção **Contato** |
| E-mail `contato@albstransportes.com.br` | seção **Contato** |
| Endereço `Rua Exemplo, 000 — Cidade/UF` | seção **Contato** |
| Horário de atendimento | seção **Contato** |
| CNPJ `00.000.000/0000-00` | rodapé |
| Fotos (Unsplash) | `.hero` e `.photo` no `<style>` — troque pelas fotos da frota |

## Funcionalidades

- Layout responsivo (desktop e celular) com menu mobile.
- Modo claro/escuro automático, conforme o sistema do visitante.
- Formulário de cotação que abre o WhatsApp com a mensagem já preenchida
  (não precisa de servidor).
- Botão flutuante de WhatsApp.
