"""Fecha uma operação depois que booking/cliente foram confirmados: consulta e
baixa o flex tank no estoque (Supabase), gera o PDF e grava o registro do
dashboard do cliente (Supabase, com upload das fotos)."""
from __future__ import annotations

import base64
import logging
from dataclasses import dataclass, field

from app import supabase_client
from app.pipeline import ProcessResult
from app.report import ReportPhoto, build_container_pdf

logger = logging.getLogger(__name__)


@dataclass
class FinalizeResult:
    container_number: str | None
    container_number_check_digit_valid: bool | None
    flex_number: str | None
    flex_number_source: str | None
    booking: str
    cliente: str
    flex_em_estoque: bool | None  # None = não consultado (Supabase não configurado)
    flex_estoque_tabela: str | None  # aba/tabela onde foi encontrado, se encontrado
    warnings: list[str]
    pdf_base64: str
    pdf_filename: str
    images: list[dict] = field(default_factory=list)


def finalize_operation(*, chat_id: str, extraction: ProcessResult, booking: str, cliente: str) -> FinalizeResult:
    flex_em_estoque: bool | None = None
    flex_estoque_tabela: str | None = None
    if extraction.flex_number and supabase_client.is_configured():
        found = supabase_client.find_flex_in_estoque(extraction.flex_number)
        flex_em_estoque = found is not None
        if found is not None:
            _, flex_estoque_tabela = found
            supabase_client.marcar_flex_baixado(extraction.flex_number, flex_estoque_tabela)

    warnings = list(extraction.warnings)
    if flex_em_estoque is False:
        warnings.append("numero_do_flex_nao_consta_na_base_de_estoque")

    report_photos = [
        ReportPhoto(role=img.role, filename=img.filename, content=base64.b64decode(img.content_b64))
        for img in extraction.images
    ]
    pdf_bytes = build_container_pdf(
        container_number=extraction.container_number,
        container_check_digit_valid=extraction.container_number_check_digit_valid,
        flex_number=extraction.flex_number,
        flex_number_source=extraction.flex_number_source,
        booking=booking,
        cliente=cliente,
        flex_em_estoque=flex_em_estoque,
        flex_estoque_tabela=flex_estoque_tabela,
        warnings=extraction.warnings,
        photos=report_photos,
    )
    pdf_filename = f"Relatorio_{extraction.container_number or chat_id}.pdf"

    _save_dashboard_record(
        chat_id=chat_id,
        booking=booking,
        cliente=cliente,
        extraction=extraction,
        flex_em_estoque=flex_em_estoque,
        flex_estoque_tabela=flex_estoque_tabela,
        report_photos=report_photos,
    )

    return FinalizeResult(
        container_number=extraction.container_number,
        container_number_check_digit_valid=extraction.container_number_check_digit_valid,
        flex_number=extraction.flex_number,
        flex_number_source=extraction.flex_number_source,
        booking=booking,
        cliente=cliente,
        flex_em_estoque=flex_em_estoque,
        flex_estoque_tabela=flex_estoque_tabela,
        warnings=warnings,
        pdf_base64=base64.b64encode(pdf_bytes).decode("ascii"),
        pdf_filename=pdf_filename,
        images=[
            {
                "index": img.index,
                "filename": img.filename,
                "role": img.role,
                "content_b64": img.content_b64,
                "content_type": img.content_type,
            }
            for img in extraction.images
        ],
    )


def _save_dashboard_record(
    *,
    chat_id: str,
    booking: str,
    cliente: str,
    extraction: ProcessResult,
    flex_em_estoque: bool | None,
    flex_estoque_tabela: str | None,
    report_photos: list[ReportPhoto],
) -> None:
    """Sobe as fotos e grava a operação no Supabase — best effort: se o
    Supabase não estiver configurado ou a chamada falhar, a operação segue
    normalmente (o e-mail/PDF já foram gerados de qualquer forma)."""
    if not supabase_client.is_configured():
        return
    try:
        container_slug = extraction.container_number or chat_id
        fotos_meta = []
        for photo in report_photos:
            path = f"{container_slug}/{photo.filename}"
            url = supabase_client.upload_foto(path=path, content=photo.content, content_type="image/jpeg")
            fotos_meta.append({"role": photo.role, "filename": photo.filename, "url": url})

        supabase_client.criar_registro_operacao(
            chat_id=chat_id,
            booking=booking,
            cliente=cliente,
            container_number=extraction.container_number,
            container_check_digit_valid=extraction.container_number_check_digit_valid,
            flex_number=extraction.flex_number,
            flex_number_source=extraction.flex_number_source,
            flex_em_estoque=flex_em_estoque,
            flex_estoque_tabela=flex_estoque_tabela,
            fotos=fotos_meta,
            warnings=extraction.warnings,
        )
    except Exception:
        # Nunca deixa um problema no Supabase derrubar a resposta ao n8n —
        # o e-mail com o PDF é a parte crítica e já foi gerada. Só registra
        # no log do serviço para a operação poder ser conferida manualmente.
        logger.exception("Falha ao gravar operação/fotos no Supabase (chat_id=%s)", chat_id)
