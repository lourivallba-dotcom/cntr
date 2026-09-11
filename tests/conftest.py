from __future__ import annotations

import io

import barcode
import pytest
import qrcode
from barcode.writer import ImageWriter
from PIL import Image, ImageDraw, ImageFont

_FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
_FONT = ImageFont.truetype(_FONT_PATH, 28)


def _png_bytes(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def container_number() -> str:
    return "MRKU8068654"  # dígito verificador válido (conferido manualmente)


@pytest.fixture
def flex_admin_number() -> str:
    return "DWH2604055A-626DT0883"


@pytest.fixture
def label_with_qr_bytes(flex_admin_number) -> bytes:
    qr_img = qrcode.make(flex_admin_number).convert("RGB")
    label = Image.new("RGB", (500, 700), "white")
    label.paste(qr_img.resize((300, 300)), (100, 50))
    d = ImageDraw.Draw(label)
    d.text((20, 400), "Certification\nPRO NAME: Flexitank\nLot No: A4/20260425/A", fill="black", font=_FONT, spacing=12)
    return _png_bytes(label)


@pytest.fixture
def label_with_barcode_bytes(flex_admin_number) -> bytes:
    code = barcode.get("code128", flex_admin_number.replace("-", ""), writer=ImageWriter())
    buf = io.BytesIO()
    code.write(buf)
    barcode_img = Image.open(buf).convert("RGB")
    label = Image.new("RGB", (600, 800), "white")
    label.paste(barcode_img.resize((500, 200)), (50, 50))
    d = ImageDraw.Draw(label)
    d.text((20, 300), "Certification\nPRO NAME: Flexitank", fill="black", font=_FONT, spacing=12)
    return _png_bytes(label)


@pytest.fixture
def label_ocr_only_bytes() -> bytes:
    """Etiqueta sem QR e sem barcode: só o texto do processo administrativo (DWH...)."""
    label = Image.new("RGB", (800, 300), "white")
    d = ImageDraw.Draw(label)
    d.text((20, 100), "Certification\nProcesso: DWH2604055A-626DT0883", fill="black", font=_FONT, spacing=12)
    return _png_bytes(label)


@pytest.fixture
def door_bytes(container_number) -> bytes:
    door = Image.new("RGB", (600, 400), "white")
    d = ImageDraw.Draw(door)
    formatted = f"{container_number[:4]} {container_number[4:7]} {container_number[7:10]} {container_number[10]}"
    d.text((50, 50), f"MAERSK\n{formatted}", fill="black", font=_FONT, spacing=12)
    return _png_bytes(door)


@pytest.fixture
def internal_bytes() -> bytes:
    return _png_bytes(Image.new("RGB", (600, 400), (120, 90, 60)))
