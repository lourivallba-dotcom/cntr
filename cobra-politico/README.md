# Cobra Político — o "Reclame Aqui" dos políticos

Site onde o cidadão escolhe o estado no **mapa do Brasil**, vê o **governador, os
senadores e os deputados federais** daquele estado (via APIs oficiais) e cria uma
**enquete** ou um **abaixo-assinado** direcionado a quem ele quer que responda.

## O que o site faz

| Funcionalidade | Como funciona |
|---|---|
| Mapa do Brasil | Mapa SVG onde cada estado é um botão (mouse, toque e teclado), mais uma grade com os 27 estados em forma de botão. |
| Políticos por estado | Deputados: [API da Câmara](https://dadosabertos.camara.leg.br/swagger/api.html). Senadores: [API do Senado](https://legis.senado.leg.br/dadosabertos/docs/). Governadores: Wikidata, com reserva em `data/governadores.json`. Cache de 12 h em disco; se a API cair, o site usa a última cópia boa. |
| Criar cobrança | Tipo (enquete ou abaixo-assinado), estado, tema, título, descrição, opções de voto ou meta de assinaturas. O cidadão escolhe **1 governador, até 3 senadores e até 5 deputados** para responder. |
| Login | Google, Facebook e Instagram (OAuth 2.0). |
| Vídeo com moldura | Gravação pela câmera (ou reaproveitando um vídeo do celular) direto no navegador. O sistema desenha por cima do vídeo uma moldura com a **bandeira do estado**, o título, o tema e as **fotos do governador, dos senadores e dos deputados (até 5) escolhidos**. Formato vertical 9:16 (Reels/Stories/TikTok/Shorts). |
| E-mail | Cada político recebe um e-mail com **cópia para o cidadão** e um **link exclusivo** para responder. Quando ele responde, o cidadão recebe a resposta por e-mail. |
| Respostas públicas | A resposta aparece na página da cobrança, com o status "Respondeu" ou "Sem resposta há N dias". |
| Ranking (reputação) | Percentual de cobranças respondidas e tempo médio de resposta: Ótimo, Bom, Regular, Ruim e Não recomendado ("Em avaliação" com menos de 3 cobranças). |
| Abaixo-assinado | Uma assinatura por pessoa, meta, barra de progresso, cidade e comentário opcionais, nome público ou anônimo. |
| Compartilhar | WhatsApp, Facebook, Instagram (pelo menu de compartilhamento do celular, com o arquivo do vídeo), X, Telegram, LinkedIn, copiar link e baixar o vídeo. As páginas têm meta tags Open Graph para a prévia nas redes. |
| Divulgação oficial | Toda cobrança nova e toda resposta disparam um webhook (`SOCIAL_WEBHOOK_URL`) para o n8n/Make/Zapier postar nos perfis do site. |
| Moderação | Botão "Denunciar" e administradores (`ADMIN_EMAILS`) que podem ocultar ou republicar conteúdo. |

## Rodar localmente

Requer **Node.js 22.5 ou mais recente** (usa o SQLite embutido do Node, então não há banco externo).

```bash
cd cobra-politico
npm install
npm run dev      # http://localhost:3000, com políticos FICTÍCIOS e login de teste
npm test         # testes automatizados
```

Para usar os dados reais, rode `npm start` com `DADOS_OFFLINE=0` (o padrão) num servidor com acesso à internet.

## Colocar em produção

1. Copie `.env.example` para `.env` e preencha os campos. O mínimo é: `BASE_URL`, as chaves de pelo menos um login social e o `SMTP_URL`.
2. `docker build -t cobra-politico . && docker run -d --env-file .env -p 3000:3000 -v cobra_dados:/dados cobra-politico`
3. Coloque um proxy com HTTPS na frente (Caddy, Nginx ou Cloudflare). A câmera só funciona em HTTPS.

### Login social

| Provedor | Onde criar | URL de retorno |
|---|---|---|
| Google | Google Cloud Console → Credenciais → ID do cliente OAuth (Aplicativo da Web) | `BASE_URL/auth/google/callback` |
| Facebook | developers.facebook.com → app do tipo "Consumidor" → Login do Facebook | `BASE_URL/auth/facebook/callback` |
| Instagram | developers.facebook.com → produto Instagram → "API com login do Instagram" | `BASE_URL/auth/instagram/callback` |

> **Instagram:** a antiga *Basic Display API* foi desligada pela Meta em dezembro de 2024. O login atual só aceita **contas profissionais** (comercial ou criador de conteúdo) e não fornece e-mail. Quem entra pelo Instagram informa o e-mail em "Minhas cobranças" para receber as cópias.

### E-mails dos políticos

* **Deputados e senadores:** o e-mail oficial vem das APIs da Câmara e do Senado.
* **Governadores:** não existe API pública de contato. Preencha `"email"` em `data/governadores.json` (por exemplo, o e-mail da ouvidoria ou do gabinete).
* **Lista de governadores:** o arquivo vem com os eleitos em 2022. Vários renunciaram em 2026 para disputar eleições, e o site prefere o Wikidata quando ele está disponível. Use `"fixo": true` para forçar uma entrada do arquivo.

### Divulgação automática (n8n)

O webhook recebe um `POST` em JSON com `evento` (`nova_manifestacao` ou `resposta`), `url`, `titulo`, `uf`, `tema`, `video` e os políticos envolvidos. No n8n, ligue esse webhook aos nós do Instagram, Facebook e X para publicar nos perfis oficiais.

## Estrutura

```
server.js            app Express, segurança, meta tags Open Graph
src/politicos.js     APIs da Câmara, do Senado e do Wikidata, com cache
src/rotas.js         API: cobranças, votos, assinaturas, respostas, ranking, proxy de imagens
src/auth.js          OAuth Google/Facebook/Instagram e sessões
src/mailer.js        e-mails (Nodemailer) para os políticos e para o cidadão
src/social.js        webhook de divulgação
public/js/moldura.js gravação do vídeo com a moldura (canvas + MediaRecorder)
public/js/mapa.js    mapa do Brasil clicável
public/js/app.js     páginas do site (SPA sem framework)
data/governadores.json
```

Créditos: mapa [svg-maps/brazil](https://github.com/VictorCazanave/svg-maps) (CC BY 4.0) e bandeiras do Wikimedia Commons.
