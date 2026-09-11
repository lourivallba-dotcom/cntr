"""Orquestra visão computacional + extração + classificação para um lote de fotos."""
from __future__ import annotations

import base64
from dataclasses import dataclass, field

from app.classify import ImageInfo, ROLE_LABEL, classify_images
from app.extract import ContainerResult, FlexResult, extract_container_number, extract_flex_number
from app.store import BatchImage
from app.vision import decode_codes, load_image, ocr_text


@dataclass
class ProcessedImage:
    index: int
    filename: str
    role: str
    ocr_text: str
    codes: list[dict]
    content_b64: str
    content_type: str


@dataclass
class ProcessResult:
    container_number: str | None
    container_number_check_digit_valid: bool | None
    flex_number: str | None
    flex_number_source: str | None
    label_image_index: int | None
    images: list[ProcessedImage]
    warnings: list[str] = field(default_factory=list)


def process_images(images: list[BatchImage]) -> ProcessResult:
    infos: list[ImageInfo] = []
    decoded_cache = []
    for idx, img in enumerate(images):
        pil_image = load_image(img.content)
        codes = decode_codes(pil_image)
        text = ocr_text(pil_image)
        infos.append(ImageInfo(index=idx, filename=img.filename, ocr_text=text, codes=codes))
        decoded_cache.append((pil_image, codes, text))

    roles = classify_images(infos)
    label_idx = next((i for i, role in enumerate(roles) if role == ROLE_LABEL), None)

    container: ContainerResult = extract_container_number([info.ocr_text for info in infos])

    if label_idx is not None:
        flex_codes = infos[label_idx].codes
        flex_text = infos[label_idx].ocr_text
    else:
        flex_codes = [c for info in infos for c in info.codes]
        flex_text = "\n".join(info.ocr_text for info in infos)
    flex: FlexResult = extract_flex_number(flex_codes, flex_text)

    processed_images = [
        ProcessedImage(
            index=idx,
            filename=images[idx].filename,
            role=roles[idx],
            ocr_text=infos[idx].ocr_text,
            codes=[{"type": c.type, "data": c.data} for c in infos[idx].codes],
            content_b64=base64.b64encode(images[idx].content).decode("ascii"),
            content_type=images[idx].content_type,
        )
        for idx in range(len(images))
    ]

    warnings: list[str] = []
    if container.number is None:
        warnings.append("numero_do_conteiner_nao_encontrado")
    elif container.check_digit_valid is False:
        warnings.append("digito_verificador_do_conteiner_invalido_conferir_manualmente")
    if flex.number is None:
        warnings.append("numero_do_flex_tank_nao_encontrado")
    if label_idx is None:
        warnings.append("foto_da_etiqueta_nao_identificada_com_confianca")

    return ProcessResult(
        container_number=container.number,
        container_number_check_digit_valid=container.check_digit_valid,
        flex_number=flex.number,
        flex_number_source=flex.source,
        label_image_index=label_idx,
        images=processed_images,
        warnings=warnings,
    )
