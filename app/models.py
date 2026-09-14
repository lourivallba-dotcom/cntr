"""Schemas Pydantic das respostas da API (também viram o schema OpenAPI usado pelo n8n)."""
from __future__ import annotations

from pydantic import BaseModel


class CodeOut(BaseModel):
    type: str
    data: str


class ProcessedImageOut(BaseModel):
    index: int
    filename: str
    role: str  # "label" | "container_door" | "internal"
    ocr_text: str
    codes: list[CodeOut]
    content_b64: str
    content_type: str


class ProcessResultOut(BaseModel):
    container_number: str | None
    container_number_check_digit_valid: bool | None
    flex_number: str | None
    flex_number_source: str | None  # "qr" | "barcode" | "ocr" | None
    label_image_index: int | None
    images: list[ProcessedImageOut]
    warnings: list[str]


class ExtractionPreviewOut(BaseModel):
    container_number: str | None
    container_number_check_digit_valid: bool | None
    flex_number: str | None
    flex_number_source: str | None
    label_image_index: int | None
    warnings: list[str]


class BatchStatusOut(BaseModel):
    chat_id: str
    count: int
    batch_size: int
    ready: bool
    # Preenchido quando ready=True: o serviço já processou as 5 fotos mas
    # está esperando a resposta de booking/cliente (obrigatória) antes de
    # gerar o PDF/e-mail — ver POST /chats/{chat_id}/answer.
    needs_answer: str | None = None  # "booking_cliente" | "replicar_confirmacao" | None
    extraction_preview: ExtractionPreviewOut | None = None
    previous_booking: str | None = None
    previous_cliente: str | None = None


class AnswerIn(BaseModel):
    text: str


class FinalizeImageOut(BaseModel):
    index: int
    filename: str
    role: str
    content_b64: str
    content_type: str


class FinalizeResultOut(BaseModel):
    container_number: str | None
    container_number_check_digit_valid: bool | None
    flex_number: str | None
    flex_number_source: str | None
    booking: str
    cliente: str
    flex_em_estoque: bool | None  # None = Supabase não configurado (não consultado)
    warnings: list[str]
    pdf_base64: str
    pdf_filename: str
    images: list[FinalizeImageOut]


class AnswerResultOut(BaseModel):
    accepted: bool
    # Preenchido quando accepted=False: pergunta a repetir no grupo (formato
    # não reconhecido, ou usuário respondeu "não" para a réplica de booking).
    retry_question: str | None = None
    finalize: FinalizeResultOut | None = None
