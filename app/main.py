"""API HTTP consumida pelo workflow do n8n.

Fluxo pensado para o n8n, por operação (1 contêiner = 5 fotos):

1. O n8n recebe cada mensagem de imagem do grupo e chama
   POST /batches/{chat_id}/images com o binário da foto, uma foto por vez.
2. Ao chegar a 5ª foto, o serviço já identifica contêiner/flex tank e
   responde `ready: true` + `needs_answer`:
     - "booking_cliente": primeira operação da conversa — o n8n deve
       perguntar no grupo qual é a reserva (booking) e o cliente.
     - "replicar_confirmacao": já existe um booking/cliente confirmado nesse
       chat — o n8n deve perguntar se quer reaproveitar (`previous_booking`/
       `previous_cliente`) ou informar um novo.
   Em ambos os casos `extraction_preview` já traz o número do contêiner e do
   flex tank identificados, para a pergunta poder citá-los.
3. Quando a pessoa responde no grupo (texto), o n8n chama
   POST /chats/{chat_id}/answer com esse texto. A resposta:
     - `accepted: false` → `retry_question` tem o que reenviar ao grupo
       (formato não reconhecido, ou confirmação de reinício do booking).
     - `accepted: true` → `finalize` traz tudo pronto: número do contêiner,
       número do flex tank, se ele foi encontrado/baixado no estoque
       (Supabase), o PDF do relatório em base64 e as 5 fotos — para o n8n
       enviar por e-mail e/ou por DM aos contatos parametrizados.

Booking e cliente são obrigatórios: o PDF só é gerado depois dessa resposta.

Se o grupo enviar as 5 fotos de uma vez (outro canal/BSP que agrupa mídias),
dá para pular o acúmulo e chamar POST /process diretamente — mas nesse caso
não passa pelo fluxo de booking/cliente/Supabase, só faz a extração.

Um lote parado (grupo mandou só 3 fotos e não completou) expira sozinho depois
de BATCH_TTL_SECONDS de inatividade (app/store.py). Uma pergunta pendente sem
resposta expira depois de CONVERSATION_TTL_SECONDS (app/conversation.py).
"""
from __future__ import annotations

from fastapi import FastAPI, File, HTTPException, UploadFile

from app.config import get_settings
from app.conversation import (
    AWAITING_BOOKING_CLIENTE,
    AWAITING_REPLICAR_CONFIRMACAO,
    get_conversation_store,
    parse_booking_cliente,
    parse_yes_no,
)
from app.finalize import finalize_operation
from app.models import (
    AnswerIn,
    AnswerResultOut,
    BatchStatusOut,
    ExtractionPreviewOut,
    FinalizeResultOut,
    ProcessResultOut,
)
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


def _finalize_out(finalize) -> FinalizeResultOut:
    return FinalizeResultOut.model_validate(finalize, from_attributes=True)


def _extraction_preview(result) -> ExtractionPreviewOut:
    return ExtractionPreviewOut(
        container_number=result.container_number,
        container_number_check_digit_valid=result.container_number_check_digit_valid,
        flex_number=result.flex_number,
        flex_number_source=result.flex_number_source,
        label_image_index=result.label_image_index,
        warnings=result.warnings,
    )


@app.post("/batches/{chat_id}/images", response_model=BatchStatusOut)
def add_image_to_batch(chat_id: str, file: UploadFile = File(...)) -> BatchStatusOut:
    settings = get_settings()
    store = get_store()
    image = _read_upload(file)
    state = store.add_image(chat_id, image)
    count = len(state.images)
    ready = count >= settings.batch_size

    if not ready:
        return BatchStatusOut(chat_id=chat_id, count=count, batch_size=settings.batch_size, ready=False)

    result = process_images(state.images)
    store.reset(chat_id)

    conversation_store = get_conversation_store()
    previous = conversation_store.get_last_confirmed(chat_id)
    if previous is None:
        conversation_store.set_pending(chat_id, AWAITING_BOOKING_CLIENTE, result)
        return BatchStatusOut(
            chat_id=chat_id,
            count=count,
            batch_size=settings.batch_size,
            ready=True,
            needs_answer=AWAITING_BOOKING_CLIENTE,
            extraction_preview=_extraction_preview(result),
        )

    conversation_store.set_pending(chat_id, AWAITING_REPLICAR_CONFIRMACAO, result)
    previous_booking, previous_cliente = previous
    return BatchStatusOut(
        chat_id=chat_id,
        count=count,
        batch_size=settings.batch_size,
        ready=True,
        needs_answer=AWAITING_REPLICAR_CONFIRMACAO,
        extraction_preview=_extraction_preview(result),
        previous_booking=previous_booking,
        previous_cliente=previous_cliente,
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
    get_conversation_store().clear_pending(chat_id)
    return {"chat_id": chat_id, "reset": True}


@app.post("/chats/{chat_id}/answer", response_model=AnswerResultOut)
def answer_chat(chat_id: str, body: AnswerIn) -> AnswerResultOut:
    conversation_store = get_conversation_store()
    pending = conversation_store.get_pending(chat_id)
    if pending is None:
        raise HTTPException(status_code=404, detail="Não há pergunta pendente para esse chat_id.")

    if pending.status == AWAITING_BOOKING_CLIENTE:
        parsed = parse_booking_cliente(body.text)
        if parsed is None:
            return AnswerResultOut(
                accepted=False,
                retry_question=(
                    "Não consegui identificar a reserva e o cliente. Responda no formato: "
                    "\"Booking XXXXX, cliente YYYYY\"."
                ),
            )
        conversation_store.confirm_booking_cliente(chat_id, parsed.booking, parsed.cliente)
        conversation_store.clear_pending(chat_id)
        finalize = finalize_operation(
            chat_id=chat_id, extraction=pending.pending_extraction, booking=parsed.booking, cliente=parsed.cliente
        )
        return AnswerResultOut(accepted=True, finalize=_finalize_out(finalize))

    # AWAITING_REPLICAR_CONFIRMACAO
    parsed = parse_booking_cliente(body.text)
    if parsed is not None:
        conversation_store.confirm_booking_cliente(chat_id, parsed.booking, parsed.cliente)
        conversation_store.clear_pending(chat_id)
        finalize = finalize_operation(
            chat_id=chat_id, extraction=pending.pending_extraction, booking=parsed.booking, cliente=parsed.cliente
        )
        return AnswerResultOut(accepted=True, finalize=_finalize_out(finalize))

    yes_no = parse_yes_no(body.text)
    if yes_no is True:
        previous = conversation_store.get_last_confirmed(chat_id)
        if previous is None:
            # não deveria acontecer (só chega em replicar_confirmacao se já existe um
            # anterior), mas evita derrubar a conversa se o estado for perdido
            conversation_store.set_pending(chat_id, AWAITING_BOOKING_CLIENTE, pending.pending_extraction)
            return AnswerResultOut(
                accepted=False,
                retry_question="Não encontrei a reserva anterior. Qual é a reserva (booking) e o cliente dessa operação?",
            )
        booking, cliente = previous
        conversation_store.clear_pending(chat_id)
        finalize = finalize_operation(chat_id=chat_id, extraction=pending.pending_extraction, booking=booking, cliente=cliente)
        return AnswerResultOut(accepted=True, finalize=_finalize_out(finalize))

    if yes_no is False:
        conversation_store.set_pending(chat_id, AWAITING_BOOKING_CLIENTE, pending.pending_extraction)
        return AnswerResultOut(
            accepted=False,
            retry_question="Ok! Qual é a nova reserva (booking) e o cliente dessa operação?",
        )

    return AnswerResultOut(
        accepted=False,
        retry_question=(
            "Não entendi. Responda \"sim\" para usar a mesma reserva/cliente da operação anterior, "
            "ou informe a nova reserva no formato \"Booking XXXXX, cliente YYYYY\"."
        ),
    )


@app.post("/process", response_model=ProcessResultOut)
def process_now(files: list[UploadFile] = File(...)) -> ProcessResultOut:
    if not files:
        raise HTTPException(status_code=400, detail="Envie ao menos 1 imagem no campo 'files'.")
    images = [_read_upload(f) for f in files]
    result = process_images(images)
    return ProcessResultOut.model_validate(result, from_attributes=True)
