"""Hash de senha (PBKDF2, só biblioteca padrão)."""
from __future__ import annotations

import hashlib
import hmac
import secrets


def hash_senha(senha: str, iteracoes: int) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", senha.encode(), bytes.fromhex(salt), iteracoes).hex()
    return f"pbkdf2_sha256${iteracoes}${salt}${digest}"


def verificar_senha(senha: str, armazenado: str) -> bool:
    try:
        _, iteracoes, salt, digest = armazenado.split("$")
    except ValueError:
        return False
    calculado = hashlib.pbkdf2_hmac("sha256", senha.encode(), bytes.fromhex(salt), int(iteracoes)).hex()
    return hmac.compare_digest(calculado, digest)
