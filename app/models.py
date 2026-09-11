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


class BatchStatusOut(BaseModel):
    chat_id: str
    count: int
    batch_size: int
    ready: bool
    result: ProcessResultOut | None = None
