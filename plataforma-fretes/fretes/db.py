"""Banco SQLite: esquema e consultas da plataforma.

SQLite é suficiente para começar (um único servidor). Para escalar, as mesmas
tabelas podem ir para Postgres/Supabase sem mudar o modelo.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from fretes.catalog import normalizar

SCHEMA = """
CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL CHECK (tipo IN ('embarcador', 'motorista')),
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    telefone TEXT NOT NULL,
    documento TEXT NOT NULL,          -- CNPJ (embarcador) ou CPF (motorista), só dígitos
    empresa TEXT,
    cidade TEXT,
    uf TEXT,
    senha_hash TEXT NOT NULL,
    criado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS veiculos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    motorista_id INTEGER NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
    tipo_veiculo TEXT NOT NULL,
    carroceria TEXT NOT NULL,
    placa TEXT NOT NULL,
    rntrc TEXT,
    capacidade_kg INTEGER
);

CREATE TABLE IF NOT EXISTS fretes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    embarcador_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    origem_cidade TEXT NOT NULL,
    origem_uf TEXT NOT NULL,
    origem_busca TEXT NOT NULL,
    destino_cidade TEXT NOT NULL,
    destino_uf TEXT NOT NULL,
    destino_busca TEXT NOT NULL,
    produto TEXT NOT NULL,
    especie TEXT NOT NULL,
    peso_kg INTEGER NOT NULL,
    valor_centavos INTEGER,           -- NULL = a combinar
    tipo_valor TEXT NOT NULL DEFAULT 'total',
    veiculos TEXT NOT NULL,           -- códigos separados por vírgula
    carrocerias TEXT NOT NULL,        -- códigos separados por vírgula
    data_coleta TEXT NOT NULL,
    rastreamento INTEGER NOT NULL DEFAULT 0,
    observacoes TEXT,
    status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'fechado', 'cancelado')),
    motorista_id INTEGER REFERENCES usuarios(id),
    criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fretes_status ON fretes(status, criado_em);

CREATE TABLE IF NOT EXISTS candidaturas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    frete_id INTEGER NOT NULL REFERENCES fretes(id) ON DELETE CASCADE,
    motorista_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    mensagem TEXT,
    status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'aceita', 'recusada')),
    criado_em TEXT NOT NULL,
    UNIQUE (frete_id, motorista_id)
);

CREATE TABLE IF NOT EXISTS avaliacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    frete_id INTEGER NOT NULL REFERENCES fretes(id) ON DELETE CASCADE,
    autor_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    avaliado_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    nota INTEGER NOT NULL CHECK (nota BETWEEN 1 AND 5),
    comentario TEXT,
    criado_em TEXT NOT NULL,
    UNIQUE (frete_id, autor_id)
);
"""


def agora() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path: str) -> sqlite3.Connection:
    if path != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    # Uma conexão por request; o FastAPI pode abri-la numa thread do pool e
    # usá-la no event loop, por isso check_same_thread=False.
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(path: str) -> None:
    with connect(path) as conn:
        conn.executescript(SCHEMA)


# --- usuários ---


def criar_usuario(conn: sqlite3.Connection, **campos) -> int:
    campos["criado_em"] = agora()
    colunas = ", ".join(campos)
    marcadores = ", ".join("?" for _ in campos)
    cur = conn.execute(f"INSERT INTO usuarios ({colunas}) VALUES ({marcadores})", tuple(campos.values()))
    return cur.lastrowid


def usuario_por_id(conn: sqlite3.Connection, usuario_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM usuarios WHERE id = ?", (usuario_id,)).fetchone()


def usuario_por_email(conn: sqlite3.Connection, email: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM usuarios WHERE email = ?", (email.strip().lower(),)).fetchone()


def reputacao(conn: sqlite3.Connection, usuario_id: int) -> dict:
    row = conn.execute(
        "SELECT COUNT(*) AS total, AVG(nota) AS media FROM avaliacoes WHERE avaliado_id = ?", (usuario_id,)
    ).fetchone()
    media = round(row["media"], 1) if row["media"] is not None else None
    return {"total": row["total"], "media": media}


def avaliacoes_recebidas(conn: sqlite3.Connection, usuario_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT a.*, u.nome AS autor_nome FROM avaliacoes a JOIN usuarios u ON u.id = a.autor_id
           WHERE a.avaliado_id = ? ORDER BY a.criado_em DESC""",
        (usuario_id,),
    ).fetchall()


# --- veículo do motorista ---


def veiculo_do_motorista(conn: sqlite3.Connection, motorista_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM veiculos WHERE motorista_id = ?", (motorista_id,)).fetchone()


def salvar_veiculo(conn: sqlite3.Connection, motorista_id: int, **campos) -> None:
    conn.execute(
        """INSERT INTO veiculos (motorista_id, tipo_veiculo, carroceria, placa, rntrc, capacidade_kg)
           VALUES (:motorista_id, :tipo_veiculo, :carroceria, :placa, :rntrc, :capacidade_kg)
           ON CONFLICT (motorista_id) DO UPDATE SET
             tipo_veiculo = excluded.tipo_veiculo, carroceria = excluded.carroceria,
             placa = excluded.placa, rntrc = excluded.rntrc, capacidade_kg = excluded.capacidade_kg""",
        {"motorista_id": motorista_id, **campos},
    )


# --- fretes ---


def criar_frete(conn: sqlite3.Connection, embarcador_id: int, **campos) -> int:
    campos["embarcador_id"] = embarcador_id
    campos["origem_busca"] = normalizar(campos["origem_cidade"])
    campos["destino_busca"] = normalizar(campos["destino_cidade"])
    campos["criado_em"] = agora()
    colunas = ", ".join(campos)
    marcadores = ", ".join("?" for _ in campos)
    cur = conn.execute(f"INSERT INTO fretes ({colunas}) VALUES ({marcadores})", tuple(campos.values()))
    return cur.lastrowid


_FRETE_SELECT = """
SELECT f.*, u.nome AS embarcador_nome, u.empresa AS embarcador_empresa, u.telefone AS embarcador_telefone
FROM fretes f JOIN usuarios u ON u.id = f.embarcador_id
"""


def frete_por_id(conn: sqlite3.Connection, frete_id: int) -> sqlite3.Row | None:
    return conn.execute(_FRETE_SELECT + " WHERE f.id = ?", (frete_id,)).fetchone()


def buscar_fretes(
    conn: sqlite3.Connection,
    *,
    origem_uf: str = "",
    origem_cidade: str = "",
    destino_uf: str = "",
    destino_cidade: str = "",
    veiculo: str = "",
    carroceria: str = "",
    limite: int = 50,
) -> list[sqlite3.Row]:
    """Fretes abertos que batem com os filtros, mais recentes primeiro."""
    where = ["f.status = 'aberto'"]
    params: list = []
    if origem_uf:
        where.append("f.origem_uf = ?")
        params.append(origem_uf)
    if origem_cidade:
        where.append("f.origem_busca LIKE ?")
        params.append(f"%{normalizar(origem_cidade)}%")
    if destino_uf:
        where.append("f.destino_uf = ?")
        params.append(destino_uf)
    if destino_cidade:
        where.append("f.destino_busca LIKE ?")
        params.append(f"%{normalizar(destino_cidade)}%")
    if veiculo:
        where.append("(',' || f.veiculos || ',') LIKE ?")
        params.append(f"%,{veiculo},%")
    if carroceria:
        where.append("(',' || f.carrocerias || ',') LIKE ?")
        params.append(f"%,{carroceria},%")
    sql = _FRETE_SELECT + " WHERE " + " AND ".join(where) + " ORDER BY f.criado_em DESC, f.id DESC LIMIT ?"
    params.append(limite)
    return conn.execute(sql, params).fetchall()


def fretes_do_embarcador(conn: sqlite3.Connection, embarcador_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT f.*, (SELECT COUNT(*) FROM candidaturas c WHERE c.frete_id = f.id) AS total_candidaturas
           FROM fretes f WHERE f.embarcador_id = ? ORDER BY f.criado_em DESC, f.id DESC""",
        (embarcador_id,),
    ).fetchall()


def cancelar_frete(conn: sqlite3.Connection, frete_id: int) -> None:
    conn.execute("UPDATE fretes SET status = 'cancelado' WHERE id = ? AND status = 'aberto'", (frete_id,))
    conn.execute("UPDATE candidaturas SET status = 'recusada' WHERE frete_id = ? AND status = 'pendente'", (frete_id,))


# --- candidaturas ---


def candidatar(conn: sqlite3.Connection, frete_id: int, motorista_id: int, mensagem: str) -> bool:
    """Registra o interesse do motorista. Retorna False se ele já tinha se candidatado."""
    try:
        conn.execute(
            "INSERT INTO candidaturas (frete_id, motorista_id, mensagem, criado_em) VALUES (?, ?, ?, ?)",
            (frete_id, motorista_id, mensagem or None, agora()),
        )
    except sqlite3.IntegrityError:
        return False
    return True


def candidatura_do_motorista(conn: sqlite3.Connection, frete_id: int, motorista_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM candidaturas WHERE frete_id = ? AND motorista_id = ?", (frete_id, motorista_id)
    ).fetchone()


def candidaturas_do_frete(conn: sqlite3.Connection, frete_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT c.*, u.nome AS motorista_nome, u.telefone AS motorista_telefone,
                  v.tipo_veiculo, v.carroceria, v.placa, v.rntrc,
                  (SELECT AVG(nota) FROM avaliacoes a WHERE a.avaliado_id = u.id) AS motorista_media
           FROM candidaturas c
           JOIN usuarios u ON u.id = c.motorista_id
           LEFT JOIN veiculos v ON v.motorista_id = u.id
           WHERE c.frete_id = ? ORDER BY c.criado_em""",
        (frete_id,),
    ).fetchall()


def candidaturas_do_motorista(conn: sqlite3.Connection, motorista_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT c.*, f.origem_cidade, f.origem_uf, f.destino_cidade, f.destino_uf, f.produto,
                  f.valor_centavos, f.tipo_valor, f.data_coleta, f.status AS frete_status
           FROM candidaturas c JOIN fretes f ON f.id = c.frete_id
           WHERE c.motorista_id = ? ORDER BY c.criado_em DESC""",
        (motorista_id,),
    ).fetchall()


def aceitar_candidatura(conn: sqlite3.Connection, frete_id: int, candidatura_id: int) -> bool:
    """Fecha o frete com o motorista da candidatura; as demais pendentes são recusadas."""
    cand = conn.execute(
        "SELECT * FROM candidaturas WHERE id = ? AND frete_id = ?", (candidatura_id, frete_id)
    ).fetchone()
    if cand is None:
        return False
    cur = conn.execute(
        "UPDATE fretes SET status = 'fechado', motorista_id = ? WHERE id = ? AND status = 'aberto'",
        (cand["motorista_id"], frete_id),
    )
    if cur.rowcount == 0:
        return False
    conn.execute("UPDATE candidaturas SET status = 'aceita' WHERE id = ?", (candidatura_id,))
    conn.execute(
        "UPDATE candidaturas SET status = 'recusada' WHERE frete_id = ? AND id != ? AND status = 'pendente'",
        (frete_id, candidatura_id),
    )
    return True


# --- avaliações ---


def avaliacao_do_autor(conn: sqlite3.Connection, frete_id: int, autor_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM avaliacoes WHERE frete_id = ? AND autor_id = ?", (frete_id, autor_id)
    ).fetchone()


def avaliar(conn: sqlite3.Connection, frete_id: int, autor_id: int, avaliado_id: int, nota: int, comentario: str) -> bool:
    try:
        conn.execute(
            """INSERT INTO avaliacoes (frete_id, autor_id, avaliado_id, nota, comentario, criado_em)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (frete_id, autor_id, avaliado_id, nota, comentario or None, agora()),
        )
    except sqlite3.IntegrityError:
        return False
    return True
