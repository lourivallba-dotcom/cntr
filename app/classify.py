"""Identifica qual foto do lote é a ETIQUETA (para rodar a extração do flex/processo)
e qual é a foto da PORTA do contêiner (para conferência do número do contêiner).

As demais fotos ficam marcadas como "internal" e seguem para o e-mail sem
processamento extra — o pedido original só precisa que a etiqueta seja
encontrada com confiança, o resto é anexo.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.config import load_label_keywords
from app.extract import looks_like_container_door
from app.vision import Code

ROLE_LABEL = "label"
ROLE_CONTAINER_DOOR = "container_door"
ROLE_INTERNAL = "internal"


@dataclass
class ImageInfo:
    index: int
    filename: str
    ocr_text: str
    codes: list[Code]


def _label_keyword_score(ocr_text: str) -> int:
    text_lower = ocr_text.lower()
    return sum(1 for kw in load_label_keywords() if kw in text_lower)


def classify_images(images: list[ImageInfo]) -> list[str]:
    roles = [ROLE_INTERNAL] * len(images)

    # 1) Etiqueta: prioriza a foto com QR code ou código de barras detectado.
    label_idx = next((img.index for img in images if img.codes), None)

    # 2) Sem QR/barcode em nenhuma foto: usa a foto com mais palavras-chave de etiqueta.
    if label_idx is None:
        scored = [(img.index, _label_keyword_score(img.ocr_text)) for img in images]
        scored = [(idx, score) for idx, score in scored if score > 0]
        if scored:
            scored.sort(key=lambda item: item[1], reverse=True)
            label_idx = scored[0][0]

    if label_idx is not None:
        roles[label_idx] = ROLE_LABEL

    # 3) Porta do contêiner: primeira foto (que não seja a etiqueta) com um
    # código no padrão ISO 6346 legível no OCR.
    for img in images:
        if img.index == label_idx:
            continue
        if looks_like_container_door(img.ocr_text):
            roles[img.index] = ROLE_CONTAINER_DOOR
            break

    return roles
