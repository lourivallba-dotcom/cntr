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


def load_label_keywords() -> list[str]:
    settings = get_settings()
    path = Path(settings.patterns_file)
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    keywords = data.get("label_keywords", [])
    return [k.lower() for k in keywords if isinstance(k, str) and k.strip()]
