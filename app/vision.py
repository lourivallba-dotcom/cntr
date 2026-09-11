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


def ocr_text(image: Image.Image) -> str:
    """Extrai texto da imagem via Tesseract OCR."""
    _ensure_tesseract_configured()
    settings = get_settings()
    try:
        return pytesseract.image_to_string(image, lang=settings.ocr_lang)
    except pytesseract.TesseractError:
        # fallback sem idioma custom, caso o pacote de idioma não esteja instalado no host
        return pytesseract.image_to_string(image)
