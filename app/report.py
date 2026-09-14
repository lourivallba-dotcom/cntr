"""Gera o PDF de uma operação (1 contêiner): dados da operação + as fotos, todas
recortadas para o mesmo padrão visual (mesma proporção largura:altura,
independente de a foto original ser retrato ou paisagem)."""
from __future__ import annotations

import io
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import Image as RLImage
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.classify import ROLE_CONTAINER_DOOR, ROLE_INTERNAL, ROLE_LABEL
from app.config import get_settings

_LOGO_PATH = Path(__file__).resolve().parent / "assets" / "logo_jw.png"
_FOOTER_TEXT = "Desenvolvido por Lourival®"

_ROLE_LABEL_PT = {
    ROLE_CONTAINER_DOOR: "Porta do contêiner",
    ROLE_LABEL: "Etiqueta do flex tank",
    ROLE_INTERNAL: "Parte interna",
}
_ROLE_ORDER = {ROLE_CONTAINER_DOOR: 0, ROLE_LABEL: 1, ROLE_INTERNAL: 2}

# Resolução alvo (pixels) das fotos dentro do PDF, já na proporção configurada
# (report_photo_aspect_ratio). Fixa para todas as fotos ficarem com o mesmo
# "peso" visual no relatório.
_TARGET_LONG_SIDE = 1000


@dataclass
class ReportPhoto:
    role: str  # "container_door" | "label" | "internal"
    filename: str
    content: bytes


def _cover_crop(image: PILImage.Image, aspect_ratio: float) -> PILImage.Image:
    """Recorte central tipo CSS "object-fit: cover": preenche a proporção alvo
    sem distorcer, cortando o excesso das bordas."""
    width, height = image.size
    current_ratio = width / height
    if current_ratio > aspect_ratio:
        new_width = round(height * aspect_ratio)
        left = (width - new_width) // 2
        image = image.crop((left, 0, left + new_width, height))
    else:
        new_height = round(width / aspect_ratio)
        top = (height - new_height) // 2
        image = image.crop((0, top, width, top + new_height))
    return image


def _standardize_photo(content: bytes, aspect_ratio: float) -> io.BytesIO:
    image = PILImage.open(io.BytesIO(content)).convert("RGB")
    image = _cover_crop(image, aspect_ratio)

    if aspect_ratio >= 1:
        target_size = (_TARGET_LONG_SIDE, round(_TARGET_LONG_SIDE / aspect_ratio))
    else:
        target_size = (round(_TARGET_LONG_SIDE * aspect_ratio), _TARGET_LONG_SIDE)
    image = image.resize(target_size, PILImage.LANCZOS)

    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=82)
    buf.seek(0)
    return buf


def _ordered_photos(photos: list[ReportPhoto]) -> list[ReportPhoto]:
    return sorted(photos, key=lambda p: _ROLE_ORDER.get(p.role, 9))


def build_container_pdf(
    *,
    container_number: str | None,
    container_check_digit_valid: bool | None,
    flex_number: str | None,
    flex_number_source: str | None,
    booking: str,
    cliente: str,
    flex_em_estoque: bool | None,
    warnings: list[str],
    photos: list[ReportPhoto],
) -> bytes:
    """Monta o PDF de uma operação (1 contêiner) e devolve os bytes prontos
    para anexar no e-mail."""
    settings = get_settings()
    aspect_ratio = settings.report_photo_aspect_ratio

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("TitleX", parent=styles["Title"], fontSize=18, spaceAfter=4)
    h2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=13, textColor=colors.HexColor("#0B3D91"))
    caption_style = ParagraphStyle("Caption", parent=styles["Normal"], fontSize=8, textColor=colors.grey, alignment=1)
    warn_style = ParagraphStyle("Warn", parent=styles["Normal"], textColor=colors.HexColor("#B00000"), fontSize=9)

    story = []

    if _LOGO_PATH.exists():
        logo_h = 2.0 * cm
        logo_w = logo_h * (487 / 506)
        header = Table(
            [[RLImage(str(_LOGO_PATH), width=logo_w, height=logo_h), Paragraph("Relatório de Montagem", title_style)]],
            colWidths=[logo_w + 0.4 * cm, None],
        )
        header.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ALIGN", (0, 0), (0, 0), "LEFT"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ]))
        story.append(header)
    else:
        story.append(Paragraph("Relatório de Montagem", title_style))
    story.append(Spacer(1, 8))

    if flex_em_estoque is None:
        estoque_txt = "não consultado"
    elif flex_em_estoque:
        estoque_txt = "encontrado na base de estoque — baixado"
    else:
        estoque_txt = "NÃO CONSTA na base de estoque"

    info_rows = [
        ["Booking", booking],
        ["Cliente", cliente],
        ["Nº do contêiner", container_number or "NÃO IDENTIFICADO"],
        [
            "Nº do flex tank",
            f"{flex_number or 'NÃO IDENTIFICADO'}" + (f"  (fonte: {flex_number_source})" if flex_number_source else ""),
        ],
        ["Situação no estoque", estoque_txt],
        ["Data de emissão", datetime.now().strftime("%d/%m/%Y %H:%M")],
    ]
    info_table = Table(info_rows, colWidths=[4.5 * cm, 10.5 * cm])
    info_table.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#CCCCCC")),
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#F0F3FA")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(info_table)
    story.append(Spacer(1, 10))

    if container_number and container_check_digit_valid is False:
        warnings = [*warnings, "digito_verificador_do_conteiner_invalido_conferir_manualmente"]
    if warnings:
        story.append(Paragraph("⚠️ Conferir manualmente: " + ", ".join(warnings), warn_style))
        story.append(Spacer(1, 8))

    story.append(Paragraph("Registro fotográfico", h2))
    story.append(Spacer(1, 6))

    ordered = _ordered_photos(photos)
    cell_width = 8.2 * cm
    cell_height = cell_width / aspect_ratio

    cells, captions = [], []
    for pos, photo in enumerate(ordered, start=1):
        buf = _standardize_photo(photo.content, aspect_ratio)
        cells.append(RLImage(buf, width=cell_width, height=cell_height))
        role_pt = _ROLE_LABEL_PT.get(photo.role, photo.role)
        captions.append(Paragraph(f"Foto {pos} — {role_pt}", caption_style))

    rows = []
    for i in range(0, len(cells), 2):
        pair_imgs = cells[i:i + 2]
        pair_caps = captions[i:i + 2]
        rows.append(pair_imgs if len(pair_imgs) == 2 else pair_imgs + [""])
        rows.append(pair_caps if len(pair_caps) == 2 else pair_caps + [""])

    grid = Table(rows, colWidths=[cell_width + 0.3 * cm, cell_width + 0.3 * cm])
    grid.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(grid)

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        leftMargin=1.6 * cm, rightMargin=1.6 * cm, topMargin=1.6 * cm, bottomMargin=1.6 * cm,
        title=f"Relatorio {container_number or booking}",
    )
    doc.build(story, onFirstPage=_draw_footer, onLaterPages=_draw_footer)
    return buffer.getvalue()


def _draw_footer(canvas, doc) -> None:
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.grey)
    canvas.drawCentredString(doc.pagesize[0] / 2, 1.0 * cm, _FOOTER_TEXT)
    canvas.restoreState()
