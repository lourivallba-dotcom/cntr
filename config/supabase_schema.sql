-- Schema do Supabase usado pelo cntr-vision.
--
-- Rode isto no SQL Editor do seu projeto Supabase. A(s) tabela(s) de estoque
-- (a planilha do Google Sheets importada — uma tabela por aba) NÃO são
-- criadas aqui — elas já existem e são de vocês; ajuste os nomes via
-- variáveis de ambiente SUPABASE_ESTOQUE_* para bater com as colunas reais.

-- 1) Tabela do dashboard do cliente: 1 linha por contêiner processado.
create table if not exists public.operacoes (
  id bigint generated always as identity primary key,
  chat_id text not null,
  booking text not null,
  cliente text not null,
  container_number text,
  container_check_digit_valid boolean,
  flex_number text,
  flex_number_source text,
  flex_em_estoque boolean,
  flex_estoque_tabela text,  -- qual aba/tabela de estoque tinha esse flex (se encontrado)
  fotos jsonb not null default '[]'::jsonb,   -- [{"role": "...", "filename": "...", "url": "..."}]
  warnings jsonb not null default '[]'::jsonb,
  criado_em timestamptz not null default now()
);

create index if not exists operacoes_cliente_idx on public.operacoes (cliente);
create index if not exists operacoes_booking_idx on public.operacoes (booking);
create index if not exists operacoes_container_idx on public.operacoes (container_number);

-- 2) Bucket de Storage para as fotos (público, para os links no dashboard
-- funcionarem sem precisar gerar signed URL toda hora).
insert into storage.buckets (id, name, public)
values ('fotos-operacoes', 'fotos-operacoes', true)
on conflict (id) do nothing;

-- Observação sobre RLS: o serviço se conecta com a service role key (não a
-- anon key), que já ignora Row Level Security por padrão — não é necessário
-- criar policies extras para o backend conseguir inserir/atualizar. Se algum
-- dia um front-end for ler essas tabelas direto do navegador com a anon key
-- (ex: uma tela de dashboard), aí sim será preciso habilitar RLS e criar
-- policies de leitura para `operacoes`.

-- 3) Referência esperada nas tabelas de estoque (já existentes, uma por aba
-- da planilha do Google Sheets) — apenas os nomes usados pelo serviço, e
-- assumindo que TODAS as abas/tabelas seguem o mesmo padrão de colunas:
--   numero_flex  (text)   -- valor lido do QR/código de barras/OCR da etiqueta
--   status       (text)   -- 'em_estoque' | 'baixado' (valores configuráveis)
-- Se os nomes reais forem diferentes, configure em .env:
--   SUPABASE_ESTOQUE_TABLES=tabela_aba1,tabela_aba2,tabela_aba3
--   SUPABASE_ESTOQUE_COL_FLEX_NUMBER=nome_da_coluna_do_numero_do_flex
--   SUPABASE_ESTOQUE_COL_STATUS=nome_da_coluna_de_status
--   SUPABASE_ESTOQUE_STATUS_EM_ESTOQUE=valor_que_significa_em_estoque
--   SUPABASE_ESTOQUE_STATUS_BAIXADO=valor_que_significa_baixado
--
-- O serviço procura o número do flex em cada tabela da lista, na ordem, até
-- achar — pare pra pensar na ordem se o mesmo número puder existir (por
-- engano) em mais de uma aba: a primeira tabela da lista tem prioridade.
-- Se as abas tiverem nomes de coluna DIFERENTES entre si (não só nomes de
-- tabela diferentes), essa consulta genérica não serve — avise que nesse
-- caso precisamos de uma função por aba em vez de uma lista simples.
