import pytest

from fretes.catalog import formatar_brl, normalizar, parse_valor_brl


@pytest.mark.parametrize(
    "texto, centavos",
    [
        ("", None),
        ("R$ 3.500,00", 350000),
        ("3500", 350000),
        ("3500.5", 350050),
        ("3.500", 350000),
        ("1.250.000", 125000000),
        ("85,90", 8590),
    ],
)
def test_parse_valor_brl(texto, centavos):
    assert parse_valor_brl(texto) == centavos


def test_parse_valor_invalido():
    with pytest.raises(ValueError):
        parse_valor_brl("abc")


def test_formatar_brl():
    assert formatar_brl(None) == "A combinar"
    assert formatar_brl(350000) == "R$ 3.500,00"
    assert formatar_brl(125000099) == "R$ 1.250.000,99"


def test_normalizar_remove_acentos():
    assert normalizar("  São   Paulo ") == "sao paulo"
    assert normalizar("Uberlândia") == "uberlandia"
