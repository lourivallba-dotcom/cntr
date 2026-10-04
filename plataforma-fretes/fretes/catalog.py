"""Listas fixas usadas nos formulários e filtros (UFs, veículos, carrocerias)."""
from __future__ import annotations

import re
import unicodedata

UFS = [
    "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
    "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]

# Agrupados como na prática do mercado: leves, médios e pesados.
VEICULOS = {
    "vuc": "VUC",
    "3_4": "3/4",
    "toco": "Toco",
    "truck": "Truck",
    "bitruck": "Bitruck",
    "carreta": "Carreta",
    "carreta_ls": "Carreta LS",
    "vanderleia": "Vanderléia",
    "bitrem": "Bitrem",
    "rodotrem": "Rodotrem",
}

CARROCERIAS = {
    "bau": "Baú",
    "bau_frigorifico": "Baú frigorífico",
    "sider": "Sider",
    "graneleiro": "Graneleiro",
    "grade_baixa": "Grade baixa",
    "cacamba": "Caçamba",
    "prancha": "Prancha",
    "porta_container": "Porta-contêiner",
    "tanque": "Tanque",
    "cegonha": "Cegonha",
    "gaiola": "Gaiola",
}

ESPECIES = ["Paletizada", "Granel", "Big bag", "Caixas", "Contêiner", "Fardos", "Tambores", "Outros"]

TIPOS_VALOR = {"total": "valor total", "tonelada": "por tonelada"}


def normalizar(texto: str) -> str:
    """Minúsculas, sem acento e com espaços colapsados — usado para a busca por cidade."""
    sem_acento = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", sem_acento).strip().lower()


def parse_valor_brl(texto: str) -> int | None:
    """Converte '3.500,00', 'R$ 3500' ou '3500.50' em centavos. Vazio = a combinar (None)."""
    limpo = texto.replace("R$", "").replace(" ", "").strip()
    if not limpo:
        return None
    if "," in limpo:
        limpo = limpo.replace(".", "").replace(",", ".")
    elif limpo.count(".") == 1 and len(limpo.split(".")[1]) <= 2:
        pass  # ponto decimal: 3500.5 / 3500.50
    else:
        limpo = limpo.replace(".", "")  # pontos de milhar: 3.500 / 1.250.000
    valor = float(limpo)
    if valor < 0:
        raise ValueError("valor negativo")
    return round(valor * 100)


def formatar_brl(centavos: int | None) -> str:
    if centavos is None:
        return "A combinar"
    reais = f"{centavos / 100:,.2f}"
    return "R$ " + reais.replace(",", "X").replace(".", ",").replace("X", ".")


def somente_digitos(texto: str) -> str:
    return re.sub(r"\D", "", texto or "")
