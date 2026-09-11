"""Extração do número do contêiner (ISO 6346) e do número do flex tank / processo
administrativo (via QR code, código de barras ou OCR com padrões configuráveis)."""
from __future__ import annotations

import re
from dataclasses import dataclass

from app.config import load_flex_patterns
from app.vision import Code

_CONTAINER_RE = re.compile(r"[A-Z]{4}\d{7}")

# Tabela de valores ISO 6346 para o dígito verificador. Os múltiplos de 11
# (11, 22, 33) são propositalmente pulados pela norma.
_LETTER_VALUES = {
    letter: value
    for letter, value in zip(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        [10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 34, 35, 36, 37, 38],
    )
}


def normalize_ocr(text: str) -> str:
    """Maiúsculas e sem espaços/quebras de linha, para juntar códigos que o OCR lê partidos."""
    return re.sub(r"\s+", "", text.upper())


def container_check_digit(first_ten: str) -> int:
    total = 0
    for i, ch in enumerate(first_ten):
        value = _LETTER_VALUES[ch] if ch.isalpha() else int(ch)
        total += value * (2**i)
    remainder = total % 11
    return 0 if remainder == 10 else remainder


@dataclass
class ContainerResult:
    number: str | None
    check_digit_valid: bool | None
    source_index: int | None  # índice da imagem onde foi encontrado


def extract_container_number(ocr_texts: list[str]) -> ContainerResult:
    """Procura o padrão ISO 6346 (4 letras + 7 dígitos) em cada texto de OCR fornecido.

    Prioriza um candidato com dígito verificador válido; se nenhum for válido,
    ainda retorna o primeiro candidato encontrado (marcado como inválido) para
    permitir conferência manual, já que fotos de celular frequentemente têm
    erros de OCR em 1 caractere.
    """
    first_candidate: str | None = None
    first_candidate_idx: int | None = None
    for idx, text in enumerate(ocr_texts):
        normalized = normalize_ocr(text)
        for match in _CONTAINER_RE.finditer(normalized):
            candidate = match.group(0)
            if first_candidate is None:
                first_candidate, first_candidate_idx = candidate, idx
            check = container_check_digit(candidate[:10])
            if check == int(candidate[10]):
                return ContainerResult(number=candidate, check_digit_valid=True, source_index=idx)
    if first_candidate is not None:
        return ContainerResult(number=first_candidate, check_digit_valid=False, source_index=first_candidate_idx)
    return ContainerResult(number=None, check_digit_valid=None, source_index=None)


def looks_like_container_door(ocr_text: str) -> bool:
    """True se o texto do OCR contém um código de contêiner no padrão ISO 6346."""
    return bool(_CONTAINER_RE.search(normalize_ocr(ocr_text)))


@dataclass
class FlexResult:
    number: str | None
    source: str | None  # "qr" | "barcode" | "ocr" | None


def extract_flex_number(codes: list[Code], label_ocr_text: str) -> FlexResult:
    """Ordem de prioridade: QR code > código de barras > OCR com padrões configuráveis.

    A etiqueta branca do flex tank nem sempre traz QR code — às vezes traz só
    código de barras, e às vezes nem isso, apenas o número do processo
    administrativo impresso (formato mais comum começa com "DWH", mas outros
    prefixos/formatos são adicionados em config/patterns.yaml sem precisar
    alterar este código).
    """
    for code in codes:
        if code.type.upper() == "QRCODE" and code.data.strip():
            return FlexResult(number=code.data.strip(), source="qr")
    for code in codes:
        if code.data.strip():
            return FlexResult(number=code.data.strip(), source="barcode")

    for pattern in load_flex_patterns():
        for candidate in _ocr_line_candidates(label_ocr_text):
            match = re.search(pattern, candidate)
            if match:
                return FlexResult(number=match.group(0), source="ocr")
    return FlexResult(number=None, source=None)


def _ocr_line_candidates(text: str) -> list[str]:
    """Gera strings candidatas linha a linha (normalizadas) para casar os padrões.

    Cada linha impressa na etiqueta normalmente é um campo diferente (Lot No,
    Material, o código do processo, etc.). Casar padrão por linha evita que um
    padrão "guloso" (ex: sequência alfanumérica de 10+ caracteres) invada o
    texto do campo seguinte quando o OCR remove as quebras de linha. Também
    testamos pares de linhas adjacentes concatenadas, para o caso do próprio
    código ter sido quebrado ao meio pela quebra de linha impressa/OCR.
    """
    lines = [normalize_ocr(line) for line in text.splitlines() if line.strip()]
    candidates = list(lines)
    candidates.extend(lines[i] + lines[i + 1] for i in range(len(lines) - 1))
    return candidates
