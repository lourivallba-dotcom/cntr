import io
import time

from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.store import get_store

client = TestClient(app)


def _upload(name: str, content: bytes):
    return {"file": (name, io.BytesIO(content), "image/png")}


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_batch_accumulates_until_ready(label_with_qr_bytes, door_bytes, internal_bytes, container_number, flex_admin_number):
    chat_id = "grupo-abc"
    get_store().reset(chat_id)

    photos = [label_with_qr_bytes, door_bytes, internal_bytes, internal_bytes, internal_bytes]
    responses = []
    for i, photo in enumerate(photos):
        r = client.post(f"/batches/{chat_id}/images", files=_upload(f"foto{i}.png", photo))
        assert r.status_code == 200
        responses.append(r.json())

    for resp in responses[:-1]:
        assert resp["ready"] is False
        assert resp["result"] is None

    final = responses[-1]
    assert final["ready"] is True
    assert final["result"]["container_number"] == container_number
    assert final["result"]["flex_number"] == flex_admin_number
    assert len(final["result"]["images"]) == 5

    # o lote deve ter sido limpo depois de fechado
    status = client.get(f"/batches/{chat_id}")
    assert status.json()["count"] == 0


def test_batch_reset(internal_bytes):
    chat_id = "grupo-reset"
    get_store().reset(chat_id)
    client.post(f"/batches/{chat_id}/images", files=_upload("a.png", internal_bytes))
    assert client.get(f"/batches/{chat_id}").json()["count"] == 1

    r = client.post(f"/batches/{chat_id}/reset")
    assert r.status_code == 200
    assert client.get(f"/batches/{chat_id}").json()["count"] == 0


def test_batch_expires_after_ttl(internal_bytes, monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("BATCH_TTL_SECONDS", "0")
    get_settings.cache_clear()
    chat_id = "grupo-ttl"
    get_store().reset(chat_id)

    client.post(f"/batches/{chat_id}/images", files=_upload("a.png", internal_bytes))
    time.sleep(0.05)
    r = client.post(f"/batches/{chat_id}/images", files=_upload("b.png", internal_bytes))
    # como o TTL é 0, a segunda foto deve iniciar um lote novo em vez de acumular
    assert r.json()["count"] == 1

    get_settings.cache_clear()


def test_process_endpoint_one_shot(label_with_qr_bytes, door_bytes, internal_bytes, container_number, flex_admin_number):
    files = [
        ("files", ("etiqueta.png", io.BytesIO(label_with_qr_bytes), "image/png")),
        ("files", ("porta.png", io.BytesIO(door_bytes), "image/png")),
        ("files", ("interna.png", io.BytesIO(internal_bytes), "image/png")),
    ]
    r = client.post("/process", files=files)
    assert r.status_code == 200
    body = r.json()
    assert body["container_number"] == container_number
    assert body["flex_number"] == flex_admin_number
