"""Funções de baixo nível de visão computacional: leitura de QR/código de barras e OCR."""
from __future__ import annotations

import io
from dataclasses import dataclass

import pytesseract
from PIL import Image, ImageOps
from pyzbar.pyzbar import decode as zbar_decode

from app.config import get_settings

_configured_tesseract = False


def _ensure_tesseract_configured() -> None:
    global _configured_tesseract
    if _configured_tesseract:
        return
    cmd = get_settings().tesseract_cmd
    if cmd:
        pytesseract.pytesseract.tesseract_cmd = cmd
    _configured_tesseract = True


@dataclass
class Code:
    type: str  # ex: "QRCODE", "CODE128", "EAN13"...
    data: str


def load_image(image_bytes: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(image_bytes))
    image = ImageOps.exif_transpose(image)  # corrige rotação de fotos de celular
    return image.convert("RGB")


def decode_codes(image: Image.Image) -> list[Code]:
    """Tenta ler QR codes e códigos de barra na imagem (pyzbar lê ambos)."""
    results = zbar_decode(image)
    codes = [Code(type=r.type, data=r.data.decode("utf-8", errors="replace")) for r in results]
    if codes:
        return codes
    # Etiquetas fotografadas em ângulo/baixo contraste às vezes só decodificam
    # depois de uma imagem maior (upscaling) e em escala de cinza.
    upscaled = image.convert("L").resize((image.width * 2, image.height * 2))
    results = zbar_decode(upscaled)
    return [Code(type=r.type, data=r.data.decode("utf-8", errors="replace")) for r in results]


# Fotos de celular comprimidas (ex: enviadas por WhatsApp) às vezes chegam bem
# menores do que a foto original tirada — texto de contêiner/etiqueta fica
# pequeno demais para o Tesseract reconhecer sem ampliar a imagem antes.
_MIN_OCR_DIMENSION = 1600

# Diferentes modos de segmentação de página do Tesseract enxergam texto
# "espalhado" (foto de porta de contêiner: logo, código, pesos em blocos
# separados) melhor do que o modo automático padrão. Roda mais de um modo e
# concatena o resultado — mais chance de achar o código, custo extra pequeno
# perto do tamanho de um lote (até 5 fotos).
_PSM_CONFIGS = ["", "--psm 6", "--psm 11"]


def _upscale_for_ocr(image: Image.Image) -> Image.Image:
    gray = image.convert("L")
    longest_side = max(gray.width, gray.height)
    if longest_side >= _MIN_OCR_DIMENSION:
        return gray
    scale = _MIN_OCR_DIMENSION / longest_side
    new_size = (round(gray.width * scale), round(gray.height * scale))
    return gray.resize(new_size, Image.LANCZOS)


def ocr_text(image: Image.Image) -> str:
    """Extrai texto da imagem via Tesseract OCR, tentando alguns modos de segmentação."""
    _ensure_tesseract_configured()
    settings = get_settings()
    prepared = _upscale_for_ocr(image)

    texts = []
    for config in _PSM_CONFIGS:
        try:
            texts.append(pytesseract.image_to_string(prepared, lang=settings.ocr_lang, config=config))
        except pytesseract.TesseractError:
            # fallback sem idioma custom, caso o pacote de idioma não esteja instalado no host
            texts.append(pytesseract.image_to_string(prepared, config=config))
    return "\n".join(texts)
