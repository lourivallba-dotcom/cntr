from app.extract import (
    container_check_digit,
    extract_container_number,
    extract_flex_number,
    looks_like_container_door,
    normalize_ocr,
)
from app.vision import Code


def test_normalize_ocr_removes_whitespace_and_uppercases():
    assert normalize_ocr("mrku\n806 865\t4") == "MRKU8068654"


def test_container_check_digit_known_value():
    # MRKU8068654 é um número real de contêiner Maersk com dígito verificador válido.
    assert container_check_digit("MRKU806865") == 4


def test_extract_container_number_from_broken_ocr_lines():
    ocr_texts = ["MAERSK", "MRKU\n806 865\n4", "MAX.GROSS 30,480 KG"]
    result = extract_container_number(ocr_texts)
    assert result.number == "MRKU8068654"
    assert result.check_digit_valid is True


def test_extract_container_number_invalid_check_digit_still_returned():
    # último dígito alterado propositalmente -> checksum não bate
    ocr_texts = ["MRKU8068659"]
    result = extract_container_number(ocr_texts)
    assert result.number == "MRKU8068659"
    assert result.check_digit_valid is False


def test_extract_container_number_not_found():
    result = extract_container_number(["nenhum código aqui", "so texto qualquer"])
    assert result.number is None
    assert result.check_digit_valid is None


def test_looks_like_container_door():
    assert looks_like_container_door("MRKU 806 865 4")
    assert not looks_like_container_door("Certification\nFlexitank")


def test_extract_flex_number_prefers_qr_over_ocr():
    codes = [Code(type="QRCODE", data="DWH2604055A-626DT0883")]
    result = extract_flex_number(codes, "texto irrelevante DWHOUTRO123456")
    assert result.number == "DWH2604055A-626DT0883"
    assert result.source == "qr"


def test_extract_flex_number_falls_back_to_barcode():
    codes = [Code(type="CODE128", data="DWH2604055A626DT0883")]
    result = extract_flex_number(codes, "")
    assert result.number == "DWH2604055A626DT0883"
    assert result.source == "barcode"


def test_extract_flex_number_falls_back_to_ocr_dwh_pattern():
    text = "Certification\nProcesso: DWH2604055A-626DT0883\nMaterial PP+PE"
    result = extract_flex_number([], text)
    assert result.number == "DWH2604055A-626DT0883"
    assert result.source == "ocr"


def test_extract_flex_number_ocr_lot_format_when_no_dwh_prefix():
    # Etiqueta sem QR/barcode e sem prefixo DWH -> cai no padrão genérico de lote.
    text = "PRO SPEC: 20000 liters\nLot No: A4/20260425/A"
    result = extract_flex_number([], text)
    assert result.number == "A4/20260425/A"
    assert result.source == "ocr"


def test_extract_flex_number_not_found():
    result = extract_flex_number([], "abc")
    assert result.number is None
    assert result.source is None
