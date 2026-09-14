from app import finalize as finalize_module
from app.pipeline import process_images
from app.store import BatchImage


def _pipeline_result(label_with_qr_bytes, door_bytes, internal_bytes):
    images = [
        BatchImage(filename="etiqueta.png", content_type="image/png", content=label_with_qr_bytes),
        BatchImage(filename="porta.png", content_type="image/png", content=door_bytes),
        BatchImage(filename="int1.png", content_type="image/png", content=internal_bytes),
        BatchImage(filename="int2.png", content_type="image/png", content=internal_bytes),
        BatchImage(filename="int3.png", content_type="image/png", content=internal_bytes),
    ]
    return process_images(images)


def test_finalize_without_supabase_configured(monkeypatch, label_with_qr_bytes, door_bytes, internal_bytes):
    monkeypatch.setattr(finalize_module.supabase_client, "is_configured", lambda: False)
    result = _pipeline_result(label_with_qr_bytes, door_bytes, internal_bytes)

    out = finalize_module.finalize_operation(
        chat_id="chat-1", extraction=result, booking="MSCUAB123456", cliente="Cargill"
    )

    assert out.flex_em_estoque is None  # não consultado
    assert out.booking == "MSCUAB123456"
    assert out.cliente == "Cargill"
    assert out.container_number == result.container_number
    assert out.pdf_base64  # gerou o PDF mesmo sem Supabase
    assert len(out.images) == 5
    assert "numero_do_flex_nao_consta_na_base_de_estoque" not in out.warnings


def test_finalize_flex_found_in_estoque_marks_baixado(monkeypatch, label_with_qr_bytes, door_bytes, internal_bytes):
    baixado_calls = []
    monkeypatch.setattr(finalize_module.supabase_client, "is_configured", lambda: True)
    monkeypatch.setattr(finalize_module.supabase_client, "find_flex_in_estoque", lambda flex: {"numero_flex": flex})
    monkeypatch.setattr(
        finalize_module.supabase_client, "marcar_flex_baixado", lambda flex: baixado_calls.append(flex) or True
    )
    monkeypatch.setattr(finalize_module.supabase_client, "upload_foto", lambda **kw: "https://example.com/foto.jpg")
    monkeypatch.setattr(finalize_module.supabase_client, "criar_registro_operacao", lambda **kw: {"id": 1})

    result = _pipeline_result(label_with_qr_bytes, door_bytes, internal_bytes)
    out = finalize_module.finalize_operation(
        chat_id="chat-2", extraction=result, booking="MSCUAB123456", cliente="Cargill"
    )

    assert out.flex_em_estoque is True
    assert baixado_calls == [result.flex_number]
    assert "numero_do_flex_nao_consta_na_base_de_estoque" not in out.warnings


def test_finalize_flex_not_found_in_estoque_warns(monkeypatch, label_with_qr_bytes, door_bytes, internal_bytes):
    monkeypatch.setattr(finalize_module.supabase_client, "is_configured", lambda: True)
    monkeypatch.setattr(finalize_module.supabase_client, "find_flex_in_estoque", lambda flex: None)
    baixado_calls = []
    monkeypatch.setattr(
        finalize_module.supabase_client, "marcar_flex_baixado", lambda flex: baixado_calls.append(flex) or True
    )
    monkeypatch.setattr(finalize_module.supabase_client, "upload_foto", lambda **kw: "https://example.com/foto.jpg")
    monkeypatch.setattr(finalize_module.supabase_client, "criar_registro_operacao", lambda **kw: {"id": 1})

    result = _pipeline_result(label_with_qr_bytes, door_bytes, internal_bytes)
    out = finalize_module.finalize_operation(
        chat_id="chat-3", extraction=result, booking="MSCUAB123456", cliente="Cargill"
    )

    assert out.flex_em_estoque is False
    assert baixado_calls == []  # não baixa o que não foi encontrado
    assert "numero_do_flex_nao_consta_na_base_de_estoque" in out.warnings


def test_finalize_supabase_dashboard_failure_does_not_break_response(
    monkeypatch, label_with_qr_bytes, door_bytes, internal_bytes
):
    monkeypatch.setattr(finalize_module.supabase_client, "is_configured", lambda: True)
    monkeypatch.setattr(finalize_module.supabase_client, "find_flex_in_estoque", lambda flex: None)
    monkeypatch.setattr(finalize_module.supabase_client, "marcar_flex_baixado", lambda flex: True)

    def _boom(**kw):
        raise RuntimeError("supabase indisponível")

    monkeypatch.setattr(finalize_module.supabase_client, "upload_foto", _boom)

    result = _pipeline_result(label_with_qr_bytes, door_bytes, internal_bytes)
    out = finalize_module.finalize_operation(
        chat_id="chat-4", extraction=result, booking="MSCUAB123456", cliente="Cargill"
    )

    # o PDF/e-mail é a parte crítica: uma falha ao gravar o dashboard não pode derrubar isso
    assert out.pdf_base64
    assert out.container_number == result.container_number
