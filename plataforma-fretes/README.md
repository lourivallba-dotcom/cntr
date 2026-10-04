# Plataforma de Fretes

Marketplace de fretes no estilo das plataformas de cargas do mercado: conecta
**embarcadores** (empresas com carga para transportar) a **caminhoneiros**.
Feito em FastAPI + SQLite + páginas HTML renderizadas no servidor (funciona bem
no celular, que é onde o motorista usa).

## O que já faz

| Embarcador | Motorista |
|---|---|
| Cadastro com empresa e CNPJ | Cadastro com CPF e WhatsApp |
| Publica frete: origem/destino, produto, espécie, peso, valor (total, por tonelada ou "a combinar"), data de coleta, veículos e carrocerias aceitos, rastreamento, observações | Cadastra o veículo: tipo (VUC a rodotrem), carroceria (baú, sider, graneleiro, porta-contêiner…), placa, RNTRC |
| Vê os motoristas interessados com veículo, placa, RNTRC e reputação | Busca fretes por cidade/UF de origem e destino, veículo e carroceria (busca ignora acentos) |
| Chama o motorista no WhatsApp com 1 clique | Painel com "fretes para o seu veículo" |
| Fecha o frete com um candidato (os demais são recusados automaticamente) ou cancela | Clica em "Tenho interesse" (com mensagem/contraproposta) e acompanha o status |
| Avalia o motorista (1–5 ★) depois do frete fechado | Avalia o embarcador depois do frete fechado |

- O **contato (WhatsApp) só aparece para usuários logados** — a busca é pública, como nas plataformas do mercado.
- Perfil público com reputação média e comentários (`/usuarios/{id}`).
- **API JSON** somente leitura para integrações (ex.: o n8n deste repositório postar fretes novos num grupo de WhatsApp):
  - `GET /api/fretes?origem_uf=SP&destino_uf=MG&veiculo=carreta&carroceria=porta_container`
  - `GET /api/fretes/{id}`
  - Documentação interativa em `/docs`.

## Rodando localmente

```bash
cd plataforma-fretes
pip install -r requirements-dev.txt
python -m fretes.seed            # opcional: dados de demonstração
uvicorn fretes.main:app --reload --port 8100
```

Acesse http://localhost:8100. Com o seed, entre como `demo@embarcador.com` ou
`demo@motorista.com` (senha `demo12345`).

Testes:

```bash
cd plataforma-fretes
python -m pytest
```

## Docker

```bash
cd plataforma-fretes
cp .env.example .env   # troque FRETES_SECRET_KEY
docker build -t plataforma-fretes .
docker run -p 8100:8100 --env-file .env -v fretes_data:/srv/fretes/data plataforma-fretes
```

## Configuração (variáveis de ambiente)

| Variável | Padrão | Para quê |
|---|---|---|
| `FRETES_SECRET_KEY` | `troque-esta-chave-em-producao` | Assina o cookie de sessão. **Troque em produção.** |
| `FRETES_HTTPS_ONLY` | `false` | Cookie só via HTTPS — ligue atrás de TLS. |
| `FRETES_DB_PATH` | `data/fretes.db` | Arquivo do SQLite. |

## Estrutura

```
fretes/
  main.py        rotas (páginas + API JSON), sessão, permissões
  db.py          esquema SQLite e consultas
  catalog.py     UFs, veículos, carrocerias, formatação de R$
  auth.py        hash de senha (PBKDF2)
  seed.py        dados de demonstração
  templates/     páginas HTML (Jinja2)
  static/        CSS (com modo escuro)
tests/           fluxo completo: cadastro → frete → interesse → fechamento → avaliação
```

## Próximos passos sugeridos

O que as plataformas grandes têm e ainda não está aqui:

1. **Assinatura/pagamento** para motoristas verem contatos (modelo de receita) — ex.: Mercado Pago/Stripe.
2. **Validação de documentos**: consulta de CNPJ, RNTRC na ANTT, CNH, upload de fotos do veículo.
3. **Alertas de frete novo** por WhatsApp/push para motoristas com veículo compatível (dá para reaproveitar o n8n + Evolution API deste repositório).
4. **Cálculo de distância e piso mínimo da ANTT** (tabela de frete) a partir de origem/destino.
5. **App mobile** (PWA ou React Native) consumindo a API.
6. **Postgres/Supabase** no lugar do SQLite quando houver mais de um servidor; proteção CSRF por token nos formulários (hoje a proteção é o cookie `SameSite=Lax`) e recuperação de senha por e-mail.
