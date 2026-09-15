from app import supabase_client


class _FakeResponse:
    def __init__(self, data):
        self.data = data


class _FakeQuery:
    def __init__(self, rows):
        self._rows = rows

    def select(self, *_a, **_kw):
        return self

    def eq(self, *_a, **_kw):
        return self

    def limit(self, *_a, **_kw):
        return self

    def update(self, *_a, **_kw):
        return self

    def execute(self):
        return _FakeResponse(self._rows)


class _FakeClient:
    """Simula o client do supabase-py: cada tabela tem suas próprias linhas."""

    def __init__(self, rows_by_table: dict[str, list[dict]]):
        self._rows_by_table = rows_by_table
        self.updated_tables: list[str] = []

    def table(self, name: str):
        rows = self._rows_by_table.get(name, [])
        query = _FakeQuery(rows)
        # marca qual tabela recebeu o update, pra test_marcar_flex_baixado_updates_correct_table conferir
        original_update = query.update

        def update(*a, **kw):
            self.updated_tables.append(name)
            return original_update(*a, **kw)

        query.update = update
        return query


def test_find_flex_in_estoque_searches_tables_in_order(monkeypatch):
    monkeypatch.setenv("SUPABASE_ESTOQUE_TABLES", "estoque_20000l,estoque_24000l")
    from app.config import get_settings

    get_settings.cache_clear()
    supabase_client._get_client.cache_clear()

    fake = _FakeClient({"estoque_24000l": [{"numero_flex": "DWH999"}]})
    monkeypatch.setattr(supabase_client, "_get_client", lambda: fake)

    result = supabase_client.find_flex_in_estoque("DWH999")
    assert result is not None
    row, table = result
    assert row == {"numero_flex": "DWH999"}
    assert table == "estoque_24000l"

    get_settings.cache_clear()


def test_find_flex_in_estoque_not_found_in_any_table(monkeypatch):
    monkeypatch.setenv("SUPABASE_ESTOQUE_TABLES", "estoque_20000l,estoque_24000l")
    from app.config import get_settings

    get_settings.cache_clear()

    fake = _FakeClient({})
    monkeypatch.setattr(supabase_client, "_get_client", lambda: fake)

    assert supabase_client.find_flex_in_estoque("DWH000") is None

    get_settings.cache_clear()


def test_marcar_flex_baixado_updates_correct_table(monkeypatch):
    fake = _FakeClient({"estoque_24000l": [{"numero_flex": "DWH999"}]})
    monkeypatch.setattr(supabase_client, "_get_client", lambda: fake)

    ok = supabase_client.marcar_flex_baixado("DWH999", "estoque_24000l")
    assert ok is True
    assert fake.updated_tables == ["estoque_24000l"]
