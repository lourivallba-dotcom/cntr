"""Armazena as fotos recebidas de cada grupo/chat do WhatsApp até completar o lote
(padrão 5 fotos) para então disparar o processamento.

Duas implementações:
- InMemoryBatchStore: padrão, zero dependências externas, funciona bem com o
  serviço rodando em 1 único processo/worker.
- RedisBatchStore: recomendado em produção (sobrevive a reinícios do serviço e
  funciona com múltiplos workers/réplicas). Ative com STORE_BACKEND=redis.

O lote de um chat expira (BATCH_TTL_SECONDS de inatividade) para não misturar
fotos de duas operações diferentes enviadas no mesmo grupo em momentos distintos.
"""
from __future__ import annotations

import base64
import json
import threading
import time
from dataclasses import dataclass, field

from app.config import get_settings


@dataclass
class BatchImage:
    filename: str
    content_type: str
    content: bytes


@dataclass
class BatchState:
    images: list[BatchImage] = field(default_factory=list)
    last_activity: float = field(default_factory=time.time)


class BatchStore:
    def add_image(self, chat_id: str, image: BatchImage) -> BatchState:
        raise NotImplementedError

    def peek(self, chat_id: str) -> BatchState | None:
        raise NotImplementedError

    def reset(self, chat_id: str) -> None:
        raise NotImplementedError


class InMemoryBatchStore(BatchStore):
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._batches: dict[str, BatchState] = {}

    def add_image(self, chat_id: str, image: BatchImage) -> BatchState:
        ttl = get_settings().batch_ttl_seconds
        now = time.time()
        with self._lock:
            state = self._batches.get(chat_id)
            if state is not None and now - state.last_activity > ttl:
                state = None
            if state is None:
                state = BatchState()
            state.images.append(image)
            state.last_activity = now
            self._batches[chat_id] = state
            return _copy_state(state)

    def peek(self, chat_id: str) -> BatchState | None:
        with self._lock:
            state = self._batches.get(chat_id)
            return _copy_state(state) if state else None

    def reset(self, chat_id: str) -> None:
        with self._lock:
            self._batches.pop(chat_id, None)


def _copy_state(state: BatchState) -> BatchState:
    return BatchState(images=list(state.images), last_activity=state.last_activity)


class RedisBatchStore(BatchStore):
    def __init__(self, url: str) -> None:
        import redis  # import local para não exigir o pacote quando não usado

        self._redis = redis.Redis.from_url(url)

    def _key(self, chat_id: str) -> str:
        return f"cntr:batch:{chat_id}"

    def add_image(self, chat_id: str, image: BatchImage) -> BatchState:
        ttl = get_settings().batch_ttl_seconds
        key = self._key(chat_id)
        raw = self._redis.get(key)
        state = _deserialize(raw) if raw else BatchState()
        state.images.append(image)
        state.last_activity = time.time()
        self._redis.set(key, _serialize(state), ex=ttl)
        return state

    def peek(self, chat_id: str) -> BatchState | None:
        raw = self._redis.get(self._key(chat_id))
        return _deserialize(raw) if raw else None

    def reset(self, chat_id: str) -> None:
        self._redis.delete(self._key(chat_id))


def _serialize(state: BatchState) -> bytes:
    payload = {
        "last_activity": state.last_activity,
        "images": [
            {
                "filename": img.filename,
                "content_type": img.content_type,
                "content_b64": base64.b64encode(img.content).decode("ascii"),
            }
            for img in state.images
        ],
    }
    return json.dumps(payload).encode("utf-8")


def _deserialize(raw: bytes) -> BatchState:
    payload = json.loads(raw)
    images = [
        BatchImage(
            filename=item["filename"],
            content_type=item["content_type"],
            content=base64.b64decode(item["content_b64"]),
        )
        for item in payload["images"]
    ]
    return BatchState(images=images, last_activity=payload["last_activity"])


_store_instance: BatchStore | None = None


def get_store() -> BatchStore:
    global _store_instance
    if _store_instance is None:
        settings = get_settings()
        if settings.store_backend == "redis":
            _store_instance = RedisBatchStore(settings.redis_url)
        else:
            _store_instance = InMemoryBatchStore()
    return _store_instance
