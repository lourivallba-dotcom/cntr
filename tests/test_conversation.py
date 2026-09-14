from app.conversation import parse_booking_cliente, parse_yes_no


def test_parse_booking_cliente_with_keywords():
    result = parse_booking_cliente("Booking MSCUAB123456, cliente Cargill Agrícola")
    assert result is not None
    assert result.booking == "MSCUAB123456"
    assert result.cliente == "Cargill Agrícola"


def test_parse_booking_cliente_keywords_any_order_or_case():
    result = parse_booking_cliente("cliente: Cargill\nbooking: MSCUAB999")
    assert result is not None
    assert result.cliente == "Cargill"
    assert result.booking == "MSCUAB999"


def test_parse_booking_cliente_plain_comma_fallback():
    result = parse_booking_cliente("MSCUAB123456, Cargill Agrícola S.A.")
    assert result is not None
    assert result.booking == "MSCUAB123456"
    assert result.cliente == "Cargill Agrícola S.A."


def test_parse_booking_cliente_unparseable_returns_none():
    assert parse_booking_cliente("não sei") is None
    assert parse_booking_cliente("") is None
    assert parse_booking_cliente("só um texto sem virgula nem palavra chave") is None


def test_parse_yes_no():
    assert parse_yes_no("sim") is True
    assert parse_yes_no("Sim!") is True
    assert parse_yes_no("ok") is True
    assert parse_yes_no("não") is False
    assert parse_yes_no("nao") is False
    assert parse_yes_no("talvez") is None
