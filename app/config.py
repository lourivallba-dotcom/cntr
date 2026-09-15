"""Configuração do serviço via variáveis de ambiente e arquivo de padrões (regex)."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import yaml
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Tamanho do lote de fotos esperado por operação (padrão: 5, conforme o fluxo do grupo).
    batch_size: int = 5

    # Tempo (segundos) que um lote incompleto fica "aberto" aguardando mais fotos
    # antes de ser descartado e reiniciado do zero (evita misturar fotos de operações diferentes).
    batch_ttl_seconds: int = 900  # 15 minutos

    # Backend de armazenamento do lote: "memory" (padrão, single-process) ou "redis".
    store_backend: str = "memory"
    redis_url: str = "redis://localhost:6379/0"

    # Idioma(s) do Tesseract OCR.
    ocr_lang: str = "por+eng"

    # Caminho para o binário do tesseract, caso não esteja no PATH.
    tesseract_cmd: str | None = None

    # Arquivo YAML com os padrões (regex) usados para reconhecer o número
    # administrativo/flex tank quando não há QR code nem código de barras na etiqueta.
    patterns_file: str = str(Path(__file__).resolve().parent.parent / "config" / "patterns.yaml")

    # --- Conversa (booking/cliente por operação) ---

    # Tempo (segundos) que o serviço espera a resposta de booking/cliente (ou a
    # confirmação de "usar a mesma reserva?") antes de descartar a pergunta
    # pendente daquele chat.
    conversation_ttl_seconds: int = 1800  # 30 minutos

    # --- Layout do PDF ---

    # Todas as fotos do relatório são recortadas (tipo "cover", sem distorcer)
    # para essa mesma proporção largura:altura, para o PDF ficar com um padrão
    # visual único independente de a foto original ser retrato ou paisagem.
    report_photo_aspect_ratio: float = 4 / 3  # largura / altura

    # --- Supabase (estoque de flex tank importado do Google Sheets + dashboard) ---

    supabase_url: str | None = None
    supabase_key: str | None = None

    # Tabela(s)/colunas do estoque de flex tank (planilha do Google Sheets
    # importada pro Supabase). A planilha tem várias abas — se cada aba virou
    # uma tabela separada no Supabase, liste todas aqui separadas por vírgula
    # (ex: "estoque_20000l,estoque_24000l,estoque_reservado"); o serviço
    # procura o número do flex em cada uma, na ordem, até achar. Nomes
    # configuráveis porque o serviço não é dono dessas tabelas.
    supabase_estoque_tables: str = "estoque_flex"
    supabase_estoque_col_flex_number: str = "numero_flex"
    supabase_estoque_col_status: str = "status"
    supabase_estoque_status_em_estoque: str = "em_estoque"
    supabase_estoque_status_baixado: str = "baixado"

    # Tabela (de propriedade deste serviço) que alimenta o dashboard do
    # cliente: 1 linha por contêiner processado, com as fotos anexadas.
    supabase_operacoes_table: str = "operacoes"
    supabase_storage_bucket: str = "fotos-operacoes"


@lru_cache
def get_settings() -> Settings:
    return Settings()


def load_flex_patterns() -> list[str]:
    """Carrega a lista de padrões regex (em ordem de prioridade) do arquivo de configuração.

    Recarrega do disco a cada chamada de propósito: permite que a equipe de operações
    adicione um novo formato de etiqueta (ex: processos que não começam com DWH) sem
    precisar reiniciar/reimplantar o serviço.
    """
    settings = get_settings()
    path = Path(settings.patterns_file)
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    patterns = data.get("flex_number_patterns", [])
    return [p for p in patterns if isinstance(p, str) and p.strip()]


def load_estoque_tables() -> list[str]:
    """Lista de tabelas/abas do estoque a consultar, na ordem configurada."""
    settings = get_settings()
    return [t.strip() for t in settings.supabase_estoque_tables.split(",") if t.strip()]


def load_label_keywords() -> list[str]:
    settings = get_settings()
    path = Path(settings.patterns_file)
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    keywords = data.get("label_keywords", [])
    return [k.lower() for k in keywords if isinstance(k, str) and k.strip()]
