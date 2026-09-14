import io
import time

from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.store import get_store

client = TestClient(app)


def _upload(name: str, content: bytes):
    return {"file": (name, io.BytesIO(content), "image/png")}


def _send_batch(chat_id: str, photos: list[bytes]) -> dict:
    responses = []
    for i, photo in enumerate(photos):
        r = client.post(f"/batches/{chat_id}/images", files=_upload(f"foto{i}.png", photo))
        assert r.status_code == 200
        responses.append(r.json())
    return responses[-1]


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_batch_accumulates_and_asks_booking_cliente_first_time(
    label_with_qr_bytes, door_bytes, internal_bytes, container_number, flex_admin_number
):
    chat_id = "grupo-abc"
    get_store().reset(chat_id)
    client.post(f"/batches/{chat_id}/reset")

    photos = [label_with_qr_bytes, door_bytes, internal_bytes, internal_bytes, internal_bytes]
    responses = []
    for i, photo in enumerate(photos):
        r = client.post(f"/batches/{chat_id}/images", files=_upload(f"foto{i}.png", photo))
        assert r.status_code == 200
        responses.append(r.json())

    for resp in responses[:-1]:
        assert resp["ready"] is False
        assert resp["needs_answer"] is None

    final = responses[-1]
    assert final["ready"] is True
    assert final["needs_answer"] == "awaiting_booking_cliente"
    assert final["extraction_preview"]["container_number"] == container_number
    assert final["extraction_preview"]["flex_number"] == flex_admin_number

    # o lote de fotos deve ter sido limpo depois de fechado (mesmo aguardando resposta)
    status = client.get(f"/batches/{chat_id}")
    assert status.json()["count"] == 0


def test_answer_with_booking_cliente_finalizes(
    label_with_qr_bytes, door_bytes, internal_bytes, container_number, flex_admin_number
):
    chat_id = "grupo-finaliza"
    client.post(f"/batches/{chat_id}/reset")
    photos = [label_with_qr_bytes, door_bytes, internal_bytes, internal_bytes, internal_bytes]
    ready = _send_batch(chat_id, photos)
    assert ready["needs_answer"] == "awaiting_booking_cliente"

    r = client.post(f"/chats/{chat_id}/answer", json={"text": "Booking MSCUAB123456, cliente Cargill Agrícola"})
    assert r.status_code == 200
    body = r.json()
    assert body["accepted"] is True
    finalize = body["finalize"]
    assert finalize["booking"] == "MSCUAB123456"
    assert finalize["cliente"] == "Cargill Agrícola"
    assert finalize["container_number"] == container_number
    assert finalize["flex_number"] == flex_admin_number
    assert finalize["flex_em_estoque"] is None  # Supabase não configurado no teste
    assert finalize["pdf_base64"]
    assert len(finalize["images"]) == 5


def test_answer_unparseable_text_asks_to_retry(label_with_qr_bytes, door_bytes, internal_bytes):
    chat_id = "grupo-retry"
    client.post(f"/batches/{chat_id}/reset")
    _send_batch(chat_id, [label_with_qr_bytes, door_bytes, internal_bytes, internal_bytes, internal_bytes])

    r = client.post(f"/chats/{chat_id}/answer", json={"text": "não sei o que responder"})
    assert r.status_code == 200
    body = r.json()
    assert body["accepted"] is False
    assert body["retry_question"]
    assert body["finalize"] is None

    # a pergunta continua pendente: uma resposta válida em seguida ainda finaliza
    r2 = client.post(f"/chats/{chat_id}/answer", json={"text": "Booking X1, cliente Y1"})
    assert r2.json()["accepted"] is True


def test_second_batch_asks_replicar_confirmacao_and_yes_reuses(
    label_with_qr_bytes, door_bytes, internal_bytes
):
    chat_id = "grupo-replica"
    client.post(f"/batches/{chat_id}/reset")
    photos = [label_with_qr_bytes, door_bytes, internal_bytes, internal_bytes, internal_bytes]

    _send_batch(chat_id, photos)
    r = client.post(f"/chats/{chat_id}/answer", json={"text": "Booking MSCUAB999, cliente ClienteA"})
    assert r.json()["accepted"] is True

    # segundo lote do mesmo chat: agora deve perguntar se quer replicar
    ready2 = _send_batch(chat_id, photos)
    assert ready2["needs_answer"] == "awaiting_replicar_confirmacao"
    assert ready2["previous_booking"] == "MSCUAB999"
    assert ready2["previous_cliente"] == "ClienteA"

    r2 = client.post(f"/chats/{chat_id}/answer", json={"text": "sim"})
    body2 = r2.json()
    assert body2["accepted"] is True
    assert body2["finalize"]["booking"] == "MSCUAB999"
    assert body2["finalize"]["cliente"] == "ClienteA"


def test_replicar_confirmacao_no_asks_new_booking_cliente(label_with_qr_bytes, door_bytes, internal_bytes):
    chat_id = "grupo-replica-nao"
    client.post(f"/batches/{chat_id}/reset")
    photos = [label_with_qr_bytes, door_bytes, internal_bytes, internal_bytes, internal_bytes]

    _send_batch(chat_id, photos)
    client.post(f"/chats/{chat_id}/answer", json={"text": "Booking B1, cliente C1"})

    ready2 = _send_batch(chat_id, photos)
    assert ready2["needs_answer"] == "awaiting_replicar_confirmacao"

    r = client.post(f"/chats/{chat_id}/answer", json={"text": "não"})
    body = r.json()
    assert body["accepted"] is False
    assert body["finalize"] is None

    # depois do "não", uma nova reserva/cliente deve finalizar normalmente
    r2 = client.post(f"/chats/{chat_id}/answer", json={"text": "Booking B2, cliente C2"})
    body2 = r2.json()
    assert body2["accepted"] is True
    assert body2["finalize"]["booking"] == "B2"
    assert body2["finalize"]["cliente"] == "C2"


def test_answer_without_pending_question_returns_404():
    r = client.post("/chats/grupo-sem-pendencia/answer", json={"text": "Booking X, cliente Y"})
    assert r.status_code == 404


def test_batch_reset_also_clears_pending_conversation(label_with_qr_bytes, door_bytes, internal_bytes):
    chat_id = "grupo-reset-conversa"
    client.post(f"/batches/{chat_id}/reset")
    _send_batch(chat_id, [label_with_qr_bytes, door_bytes, internal_bytes, internal_bytes, internal_bytes])

    r = client.post(f"/batches/{chat_id}/reset")
    assert r.status_code == 200

    r2 = client.post(f"/chats/{chat_id}/answer", json={"text": "Booking X, cliente Y"})
    assert r2.status_code == 404


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
