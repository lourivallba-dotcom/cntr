"""API HTTP consumida pelo workflow do n8n.

Fluxo pensado para o n8n:
1. O n8n recebe cada mensagem de imagem do grupo (WhatsApp Cloud API trigger) e
   chama POST /batches/{chat_id}/images com o binário da foto, uma foto por vez.
2. Quando a 5ª foto chega, esta chamada já responde com `ready: true` e o
   resultado completo (`result`): número do contêiner, número do flex tank e as
   5 fotos (em base64, já identificadas por papel) prontas para: (a) enviar por
   e-mail como anexo e (b) montar a mensagem de resposta no grupo com @menção
   dos responsáveis (lista de números fica no próprio workflow do n8n).
3. Se o grupo enviar as 5 fotos de uma vez (ex: outro canal/BSP que agrupa
   mídias), dá para pular o acúmulo e chamar POST /process diretamente com as
   5 imagens na mesma requisição.

Um lote parado (grupo mandou só 3 fotos e não completou) expira sozinho depois
de BATCH_TTL_SECONDS de inatividade — ver app/config.py e app/store.py.
"""
from __future__ import annotations

from fastapi import FastAPI, File, HTTPException, UploadFile

from app.config import get_settings
from app.models import BatchStatusOut, ProcessResultOut
from app.pipeline import process_images
from app.store import BatchImage, get_store

app = FastAPI(
    title="cntr — extração de contêiner e flex tank",
    description="Serviço de visão computacional usado pelo workflow do n8n do grupo de WhatsApp.",
    version="1.0.0",
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


def _read_upload(file: UploadFile) -> BatchImage:
    content = file.file.read()
    if not content:
        raise HTTPException(status_code=400, detail=f"Arquivo vazio: {file.filename}")
    return BatchImage(
        filename=file.filename or "foto.jpg",
        content_type=file.content_type or "image/jpeg",
        content=content,
    )


@app.post("/batches/{chat_id}/images", response_model=BatchStatusOut)
def add_image_to_batch(chat_id: str, file: UploadFile = File(...)) -> BatchStatusOut:
    settings = get_settings()
    store = get_store()
    image = _read_upload(file)
    state = store.add_image(chat_id, image)
    count = len(state.images)
    ready = count >= settings.batch_size

    result_out = None
    if ready:
        result = process_images(state.images)
        store.reset(chat_id)
        result_out = ProcessResultOut.model_validate(result, from_attributes=True)

    return BatchStatusOut(
        chat_id=chat_id,
        count=count,
        batch_size=settings.batch_size,
        ready=ready,
        result=result_out,
    )


@app.get("/batches/{chat_id}", response_model=BatchStatusOut)
def get_batch_status(chat_id: str) -> BatchStatusOut:
    settings = get_settings()
    state = get_store().peek(chat_id)
    count = len(state.images) if state else 0
    return BatchStatusOut(chat_id=chat_id, count=count, batch_size=settings.batch_size, ready=False)


@app.post("/batches/{chat_id}/reset")
def reset_batch(chat_id: str) -> dict:
    get_store().reset(chat_id)
    return {"chat_id": chat_id, "reset": True}


@app.post("/process", response_model=ProcessResultOut)
def process_now(files: list[UploadFile] = File(...)) -> ProcessResultOut:
    if not files:
        raise HTTPException(status_code=400, detail="Envie ao menos 1 imagem no campo 'files'.")
    images = [_read_upload(f) for f in files]
    result = process_images(images)
    return ProcessResultOut.model_validate(result, from_attributes=True)
