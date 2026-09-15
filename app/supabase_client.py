"""Integração com o Supabase:

1. Consulta/baixa na tabela de estoque de flex tank (importada do Google
   Sheets) — nomes de tabela/coluna configuráveis em app/config.py, porque
   esse serviço não é dono dessa tabela.
2. Grava 1 linha por contêiner processado numa tabela própria (`operacoes`) e
   sobe as fotos pro Storage — é isso que alimenta o dashboard do cliente.

Se SUPABASE_URL/SUPABASE_KEY não estiverem configurados, todas as funções
aqui viram no-op (retornam None/False) em vez de derrubar o serviço — assim
dá pra rodar e testar o resto do pipeline (extração + PDF) sem Supabase.
"""
from __future__ import annotations

from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

from app.config import get_settings, load_estoque_tables


@lru_cache
def _get_client():
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_key:
        return None
    from supabase import create_client  # import local: opcional, só se configurado

    return create_client(settings.supabase_url, settings.supabase_key)


def is_configured() -> bool:
    return _get_client() is not None


def find_flex_in_estoque(flex_number: str) -> tuple[dict[str, Any], str] | None:
    """Procura o número do flex tank em cada tabela/aba de estoque configurada
    (SUPABASE_ESTOQUE_TABLES), na ordem. Retorna (linha, nome_da_tabela) da
    primeira que encontrar, ou None se não configurado OU não encontrar em
    nenhuma (o chamador decide a mensagem certa usando is_configured())."""
    client = _get_client()
    if client is None:
        return None
    settings = get_settings()
    for table in load_estoque_tables():
        resp = (
            client.table(table)
            .select("*")
            .eq(settings.supabase_estoque_col_flex_number, flex_number)
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        if rows:
            return rows[0], table
    return None


def marcar_flex_baixado(flex_number: str, table: str) -> bool:
    """Atualiza o status do flex tank para 'baixado' na tabela/aba onde ele foi
    encontrado (`table`, devolvido por find_flex_in_estoque). Retorna True se
    conseguiu atualizar alguma linha."""
    client = _get_client()
    if client is None:
        return False
    settings = get_settings()
    resp = (
        client.table(table)
        .update({settings.supabase_estoque_col_status: settings.supabase_estoque_status_baixado})
        .eq(settings.supabase_estoque_col_flex_number, flex_number)
        .execute()
    )
    return bool(resp.data)


def upload_foto(*, path: str, content: bytes, content_type: str) -> str | None:
    """Sobe uma foto pro bucket de Storage e devolve a URL pública. None se o
    Supabase não estiver configurado."""
    client = _get_client()
    if client is None:
        return None
    settings = get_settings()
    bucket = client.storage.from_(settings.supabase_storage_bucket)
    bucket.upload(path, content, {"content-type": content_type, "upsert": "true"})
    return bucket.get_public_url(path)


def criar_registro_operacao(
    *,
    chat_id: str,
    booking: str,
    cliente: str,
    container_number: str | None,
    container_check_digit_valid: bool | None,
    flex_number: str | None,
    flex_number_source: str | None,
    flex_em_estoque: bool | None,
    fotos: list[dict[str, str]],
    warnings: list[str],
    flex_estoque_tabela: str | None = None,
) -> dict[str, Any] | None:
    """Insere 1 linha na tabela `operacoes` (dashboard do cliente). None se o
    Supabase não estiver configurado."""
    client = _get_client()
    if client is None:
        return None
    settings = get_settings()
    row = {
        "chat_id": chat_id,
        "booking": booking,
        "cliente": cliente,
        "container_number": container_number,
        "container_check_digit_valid": container_check_digit_valid,
        "flex_number": flex_number,
        "flex_number_source": flex_number_source,
        "flex_em_estoque": flex_em_estoque,
        "flex_estoque_tabela": flex_estoque_tabela,
        "fotos": fotos,  # jsonb: [{"role": "...", "url": "...", "filename": "..."}]
        "warnings": warnings,
        "criado_em": datetime.now(timezone.utc).isoformat(),
    }
    resp = client.table(settings.supabase_operacoes_table).insert(row).execute()
    rows = resp.data or []
    return rows[0] if rows else None
