from __future__ import annotations

import os
from datetime import date, timedelta

# Hash de senha rápido nos testes (antes de importar o app, que lê as settings).
os.environ.setdefault("FRETES_PASSWORD_ITERATIONS", "1000")
os.environ.setdefault("FRETES_SECRET_KEY", "chave-de-teste")

import pytest
from fastapi.testclient import TestClient

from fretes import db
from fretes.config import get_settings
from fretes.main import app


@pytest.fixture
def db_path(tmp_path, monkeypatch):
    path = str(tmp_path / "fretes.db")
    monkeypatch.setattr(get_settings(), "db_path", path)
    db.init_db(path)
    return path


@pytest.fixture
def novo_cliente(db_path):
    """Fábrica de clientes HTTP — cada um com seu próprio cookie de sessão."""
    return lambda: TestClient(app)


def cadastrar(client: TestClient, tipo: str, email: str, **extra) -> None:
    dados = {
        "tipo": tipo,
        "nome": "Fulano de Tal" if tipo == "motorista" else "Ana Souza",
        "email": email,
        "telefone": "(11) 91234-5678",
        "documento": "123.456.789-01" if tipo == "motorista" else "12.345.678/0001-90",
        "empresa": "" if tipo == "motorista" else "Transportes Exemplo Ltda",
        "cidade": "Santos",
        "uf": "SP",
        "senha": "senha-forte-123",
        **extra,
    }
    r = client.post("/cadastro", data=dados, follow_redirects=False)
    assert r.status_code == 303, r.text


def cadastrar_veiculo(client: TestClient, tipo_veiculo="carreta", carroceria="porta_container") -> None:
    r = client.post(
        "/perfil/veiculo",
        data={"tipo_veiculo": tipo_veiculo, "carroceria": carroceria, "placa": "abc-1d23", "rntrc": "012345678"},
        follow_redirects=False,
    )
    assert r.status_code == 303, r.text


def publicar_frete(client: TestClient, **extra) -> int:
    dados = {
        "origem_cidade": "Santos",
        "origem_uf": "SP",
        "destino_cidade": "Uberlândia",
        "destino_uf": "MG",
        "produto": "Contêiner 40' de café",
        "especie": "Contêiner",
        "peso_kg": "26.000",
        "valor": "4.800,00",
        "tipo_valor": "total",
        "veiculos": ["carreta", "carreta_ls"],
        "carrocerias": ["porta_container"],
        "data_coleta": (date.today() + timedelta(days=2)).isoformat(),
        "observacoes": "Coleta no terminal.",
        **extra,
    }
    r = client.post("/fretes/novo", data=dados, follow_redirects=False)
    assert r.status_code == 303, r.text
    return int(r.headers["location"].rsplit("/", 1)[1])
