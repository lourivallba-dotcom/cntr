from app.classify import ROLE_CONTAINER_DOOR, ROLE_INTERNAL, ROLE_LABEL
from app.pipeline import process_images
from app.store import BatchImage


def _batch(label_bytes, door_bytes, internal_bytes, n_internal=3):
    images = [BatchImage(filename="etiqueta.jpg", content_type="image/png", content=label_bytes)]
    images.append(BatchImage(filename="porta.jpg", content_type="image/png", content=door_bytes))
    for i in range(n_internal):
        images.append(BatchImage(filename=f"interna{i}.jpg", content_type="image/png", content=internal_bytes))
    return images


def test_pipeline_with_qr_label(label_with_qr_bytes, door_bytes, internal_bytes, container_number, flex_admin_number):
    images = _batch(label_with_qr_bytes, door_bytes, internal_bytes)
    result = process_images(images)

    assert result.container_number == container_number
    assert result.container_number_check_digit_valid is True
    assert result.flex_number == flex_admin_number
    assert result.flex_number_source == "qr"
    assert result.label_image_index == 0
    assert result.images[0].role == ROLE_LABEL
    assert result.images[1].role == ROLE_CONTAINER_DOOR
    assert all(img.role == ROLE_INTERNAL for img in result.images[2:])
    assert result.warnings == []
    # as 5 fotos precisam vir com o conteúdo em base64 para o e-mail/anexo no n8n
    assert all(img.content_b64 for img in result.images)


def test_pipeline_with_barcode_label(label_with_barcode_bytes, door_bytes, internal_bytes, container_number):
    images = _batch(label_with_barcode_bytes, door_bytes, internal_bytes)
    result = process_images(images)

    assert result.container_number == container_number
    assert result.flex_number_source == "barcode"
    assert result.label_image_index == 0


def test_pipeline_label_without_qr_or_barcode_uses_ocr(
    label_ocr_only_bytes, door_bytes, internal_bytes, container_number, flex_admin_number
):
    images = _batch(label_ocr_only_bytes, door_bytes, internal_bytes)
    result = process_images(images)

    assert result.container_number == container_number
    assert result.flex_number == flex_admin_number
    assert result.flex_number_source == "ocr"
    assert result.label_image_index == 0


def test_pipeline_reports_warnings_when_nothing_found(internal_bytes):
    images = [BatchImage(filename=f"i{i}.jpg", content_type="image/png", content=internal_bytes) for i in range(5)]
    result = process_images(images)

    assert result.container_number is None
    assert result.flex_number is None
    assert result.label_image_index is None
    assert "numero_do_conteiner_nao_encontrado" in result.warnings
    assert "numero_do_flex_tank_nao_encontrado" in result.warnings
    assert "foto_da_etiqueta_nao_identificada_com_confianca" in result.warnings
