-- Schema Postgres para o agente de WhatsApp (programacao + container/flex tanque) via n8n.
--
-- Como os workflows do n8n sao disparados por evento (webhook) ou por
-- agendamento (cron), cada execucao e independente e nao guarda estado em
-- memoria entre uma foto e outra. Por isso tanto a programacao (bookings)
-- quanto o "lote" de fotos de uma operacao (etiqueta, porta, interna vazia,
-- interna com flex, trava) sao persistidos aqui.
--
-- Rode este arquivo uma vez no Postgres que o n8n vai usar:
--   psql "$DATABASE_URL" -f sql/schema.sql

-- ---------------------------------------------------------------------------
-- bookings: uma linha por booking da planilha de programacao (recebida como
-- foto no grupo e lida via Claude Vision). qty_assembled vai sendo
-- incrementado a cada operacao de montagem concluida para aquele booking.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
    id                  BIGSERIAL PRIMARY KEY,
    group_id            TEXT NOT NULL,
    booking             TEXT NOT NULL UNIQUE,
    received_at         DATE,
    qty_containers      INT NOT NULL DEFAULT 1,
    qty_assembled       INT NOT NULL DEFAULT 0,
    loading_date        DATE,
    flex_assembly_date  DATE,
    empty_pickup_date   DATE,
    loading_plant       TEXT,
    carrier             TEXT,
    notes               TEXT,
    -- open: ainda tem containers pendentes de montagem | completed: qty_assembled >= qty_containers
    status              TEXT NOT NULL DEFAULT 'open',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Usado para achar candidatos abertos de um armador ao tentar casar uma
-- operacao de fotos com o booking correspondente.
CREATE INDEX IF NOT EXISTS idx_bookings_matching
    ON bookings (group_id, carrier, status);

-- ---------------------------------------------------------------------------
-- photo_batches: um lote = as fotos de uma operacao de montagem enviadas em
-- sequencia por uma pessoa no grupo.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS photo_batches (
    id                  BIGSERIAL PRIMARY KEY,
    group_id            TEXT NOT NULL,
    group_name          TEXT,
    sender_id           TEXT NOT NULL,
    sender_name         TEXT,
    -- pending: aguardando mais fotos
    -- processing: finalizando (trava para evitar processamento duplicado)
    -- awaiting_booking_choice: mais de um booking candidato, aguardando resposta no grupo
    -- done: concluido (e-mail enviado, numeros publicados, progresso atualizado)
    status              TEXT NOT NULL DEFAULT 'pending',
    container_number    TEXT,
    flex_tank_number    TEXT,
    flex_lot_no         TEXT,
    carrier_text        TEXT,
    matched_booking_id  BIGINT REFERENCES bookings(id),
    -- auto: 1 candidato so | ambiguous: aguardando escolha | unmatched: nenhum candidato | resolved: escolhido via resposta no grupo
    match_status        TEXT,
    candidate_bookings  TEXT[],
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Usado pelo workflow principal para achar/criar o lote aberto de um remetente.
CREATE INDEX IF NOT EXISTS idx_photo_batches_open_lookup
    ON photo_batches (group_id, sender_id, status);

-- Usado pelo workflow de varredura (sweep) para achar lotes parados.
CREATE INDEX IF NOT EXISTS idx_photo_batches_sweep
    ON photo_batches (status, updated_at);

-- Usado para achar o lote aguardando escolha de booking quando chega uma
-- resposta em texto no grupo.
CREATE INDEX IF NOT EXISTS idx_photo_batches_awaiting
    ON photo_batches (group_id, status);

-- ---------------------------------------------------------------------------
-- batch_photos: cada foto individual de um lote, com sua classificacao e
-- leitura (OCR/QR/barcode) apos a analise.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batch_photos (
    id                     BIGSERIAL PRIMARY KEY,
    batch_id               BIGINT NOT NULL REFERENCES photo_batches(id) ON DELETE CASCADE,
    message_id             TEXT,
    mime_type              TEXT NOT NULL,
    -- Conteudo da foto em base64. Volume esperado e baixo (5 fotos por
    -- operacao, imagens ja comprimidas pelo WhatsApp), entao guardar aqui e
    -- mais simples/robusto do que depender de storage externo.
    base64_data            TEXT NOT NULL,
    -- Preenchido apos a analise: etiqueta | porta | interna_vazia | interna_flex | trava | geral | desconhecida
    photo_type             TEXT,
    container_number_text  TEXT,
    flex_tank_number_text  TEXT,
    flex_lot_no_text       TEXT,
    carrier_text           TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_batch_photos_batch_id
    ON batch_photos (batch_id);
