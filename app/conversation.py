"""Estado da conversa por chat/grupo: pergunta de booking/cliente obrigatória
após identificar um contêiner, e a pergunta de "usar a mesma reserva?" nos
lotes seguintes da mesma operação.

Guardado com a mesma política de TTL do lote de fotos (ver app/store.py):
uma pergunta pendente que ninguém responde expira sozinha.
"""
from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from app.config import get_settings

AWAITING_BOOKING_CLIENTE = "awaiting_booking_cliente"
AWAITING_REPLICAR_CONFIRMACAO = "awaiting_replicar_confirmacao"


@dataclass
class ConversationState:
    status: str  # AWAITING_BOOKING_CLIENTE | AWAITING_REPLICAR_CONFIRMACAO
    pending_extraction: Any  # ProcessResult (app.pipeline) da 5ª foto do lote
    last_activity: float = field(default_factory=time.time)


class ConversationStore:
    """Guarda o estado por chat_id. Mesmo desenho do BatchStore: em memória por
    padrão, um dicionário simples é suficiente aqui porque o volume é baixo
    (1 pergunta pendente por vez por chat) — não precisa de Redis mesmo em
    produção com múltiplos workers desde que o n8n não rode 2 réplicas do
    serviço ao mesmo tempo; se rodar, mova para Redis do mesmo jeito que o
    BatchStore."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._states: dict[str, ConversationState] = {}
        # último booking/cliente confirmado por chat, sobrevive mesmo depois
        # de uma pergunta ser respondida (para o "replicar?" do próximo lote)
        self._last_confirmed: dict[str, tuple[str, str]] = {}

    def _expire_if_needed(self, chat_id: str) -> None:
        ttl = get_settings().conversation_ttl_seconds
        state = self._states.get(chat_id)
        if state and time.time() - state.last_activity > ttl:
            del self._states[chat_id]

    def get_pending(self, chat_id: str) -> ConversationState | None:
        with self._lock:
            self._expire_if_needed(chat_id)
            return self._states.get(chat_id)

    def get_last_confirmed(self, chat_id: str) -> tuple[str, str] | None:
        with self._lock:
            return self._last_confirmed.get(chat_id)

    def set_pending(self, chat_id: str, status: str, pending_extraction: Any) -> None:
        with self._lock:
            self._states[chat_id] = ConversationState(status=status, pending_extraction=pending_extraction)

    def clear_pending(self, chat_id: str) -> None:
        with self._lock:
            self._states.pop(chat_id, None)

    def confirm_booking_cliente(self, chat_id: str, booking: str, cliente: str) -> None:
        with self._lock:
            self._last_confirmed[chat_id] = (booking, cliente)


_store_instance: ConversationStore | None = None


def get_conversation_store() -> ConversationStore:
    global _store_instance
    if _store_instance is None:
        _store_instance = ConversationStore()
    return _store_instance


# --- Parsing das respostas em texto livre do grupo ---

_BOOKING_KEYWORD_RE = re.compile(r"booking\s*[:\-]?\s*(.+?)(?:,|;|\n|$|\bcliente\b)", re.IGNORECASE)
_CLIENTE_KEYWORD_RE = re.compile(r"cliente\s*[:\-]?\s*(.+)", re.IGNORECASE)

_YES_WORDS = {"sim", "s", "ok", "sim.", "positivo", "isso", "correto", "confirmado", "confirmo", "yes"}
_NO_WORDS = {"nao", "não", "n", "negativo", "no"}


@dataclass
class BookingCliente:
    booking: str
    cliente: str


def parse_booking_cliente(text: str) -> BookingCliente | None:
    """Extrai booking e cliente de uma mensagem em texto livre.

    Aceita tanto "Booking MSCUAB123456, cliente Cargill Agrícola" (com as
    palavras-chave) quanto "MSCUAB123456, Cargill Agrícola" (separado por
    vírgula, na ordem booking depois cliente), para não travar a operação por
    causa de um formato de mensagem ligeiramente diferente.
    """
    text = text.strip()
    if not text:
        return None

    booking_match = _BOOKING_KEYWORD_RE.search(text)
    cliente_match = _CLIENTE_KEYWORD_RE.search(text)
    if booking_match and cliente_match:
        booking = booking_match.group(1).strip(" .;:-")
        cliente = cliente_match.group(1).strip(" .;:-")
        if booking and cliente:
            return BookingCliente(booking=booking, cliente=cliente)

    # Sem as palavras-chave: tenta "algo, algo" (booking, cliente nessa ordem).
    if "," in text and "booking" not in text.lower() and "cliente" not in text.lower():
        parts = [p.strip() for p in text.split(",", maxsplit=1)]
        if len(parts) == 2 and all(parts):
            return BookingCliente(booking=parts[0], cliente=parts[1])

    return None


def parse_yes_no(text: str) -> bool | None:
    """True = sim, False = não, None = não reconhecido (nem sim nem não)."""
    normalized = text.strip().lower().strip(".!")
    if normalized in _YES_WORDS:
        return True
    if normalized in _NO_WORDS:
        return False
    return None
