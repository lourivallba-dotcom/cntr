"""Configuração da plataforma de fretes via variáveis de ambiente."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", env_prefix="FRETES_", extra="ignore")

    # Arquivo do banco SQLite (criado automaticamente na primeira execução).
    db_path: str = str(Path(__file__).resolve().parent.parent / "data" / "fretes.db")

    # Chave usada para assinar o cookie de sessão. TROQUE em produção.
    secret_key: str = "troque-esta-chave-em-producao"

    # Cookie de sessão só por HTTPS (ligue em produção, atrás de TLS).
    https_only: bool = False

    # Iterações do PBKDF2 para o hash de senha.
    password_iterations: int = 200_000


@lru_cache
def get_settings() -> Settings:
    return Settings()
