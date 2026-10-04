"""Plataforma de fretes: embarcadores publicam cargas, motoristas encontram e se candidatam.

Fluxo principal:

1. Embarcador (empresa) se cadastra e publica um frete: origem, destino,
   produto, peso, valor (ou "a combinar"), veículos e carrocerias aceitos.
2. Motorista se cadastra, informa o veículo (tipo + carroceria + placa/RNTRC)
   e busca fretes por origem/destino/veículo/carroceria.
3. Logado, o motorista vê o contato do embarcador (WhatsApp) e pode clicar em
   "Tenho interesse" — isso cria uma candidatura.
4. O embarcador vê os candidatos (com veículo e reputação) e aceita um: o
   frete fica "fechado" e as demais candidaturas são recusadas.
5. Depois de fechado, embarcador e motorista avaliam um ao outro (1 a 5).

Também há uma API JSON somente leitura (/api/fretes) para integrar com outros
sistemas (ex.: n8n postando fretes novos num grupo de WhatsApp).
"""
from __future__ import annotations

import sqlite3
import urllib.parse
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from fretes import db
from fretes.auth import hash_senha, verificar_senha
from fretes.catalog import (
    CARROCERIAS,
    ESPECIES,
    TIPOS_VALOR,
    UFS,
    VEICULOS,
    formatar_brl,
    parse_valor_brl,
    somente_digitos,
)
from fretes.config import get_settings

BASE_DIR = Path(__file__).resolve().parent


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db(get_settings().db_path)
    yield


app = FastAPI(
    title="Plataforma de Fretes",
    description="Conecta embarcadores e caminhoneiros: publicação, busca e contratação de fretes.",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(
    SessionMiddleware,
    secret_key=get_settings().secret_key,
    same_site="lax",
    https_only=get_settings().https_only,
    max_age=60 * 60 * 24 * 30,
)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

templates = Jinja2Templates(directory=BASE_DIR / "templates")
templates.env.filters["brl"] = formatar_brl
templates.env.filters["veiculo"] = lambda codigo: VEICULOS.get(codigo, codigo)
templates.env.filters["carroceria"] = lambda codigo: CARROCERIAS.get(codigo, codigo)
templates.env.filters["lista"] = lambda csv: [c for c in (csv or "").split(",") if c]
templates.env.filters["kg"] = lambda kg: f"{kg:,}".replace(",", ".") + " kg"


def _whatsapp_link(telefone: str, texto: str) -> str:
    numero = somente_digitos(telefone)
    if len(numero) <= 11:
        numero = "55" + numero
    return f"https://wa.me/{numero}?text={urllib.parse.quote(texto)}"


templates.env.globals["whatsapp_link"] = _whatsapp_link


# --- infraestrutura de request ---


def get_db():
    conn = db.connect(get_settings().db_path)
    try:
        yield conn
    finally:
        conn.close()


class PrecisaLogin(Exception):
    def __init__(self, proximo: str):
        self.proximo = proximo


@app.exception_handler(PrecisaLogin)
async def _redireciona_login(_request: Request, exc: PrecisaLogin):
    return RedirectResponse(f"/entrar?proximo={urllib.parse.quote(exc.proximo)}", status_code=303)


def usuario_atual(request: Request, conn: sqlite3.Connection) -> sqlite3.Row | None:
    uid = request.session.get("uid")
    if uid is None:
        return None
    usuario = db.usuario_por_id(conn, uid)
    if usuario is None:
        request.session.clear()
    return usuario


def exigir_usuario(request: Request, conn: sqlite3.Connection, tipo: str | None = None) -> sqlite3.Row:
    usuario = usuario_atual(request, conn)
    if usuario is None:
        raise PrecisaLogin(request.url.path)
    if tipo is not None and usuario["tipo"] != tipo:
        raise HTTPException(status_code=403, detail=f"Disponível apenas para {tipo}es.")
    return usuario


def flash(request: Request, mensagem: str, nivel: str = "ok") -> None:
    request.session.setdefault("flash", []).append({"mensagem": mensagem, "nivel": nivel})


def render(request: Request, conn: sqlite3.Connection, nome: str, status_code: int = 200, **ctx):
    contexto = {
        "usuario": usuario_atual(request, conn),
        "mensagens": request.session.pop("flash", []),
        "UFS": UFS,
        "VEICULOS": VEICULOS,
        "CARROCERIAS": CARROCERIAS,
        "ESPECIES": ESPECIES,
        "TIPOS_VALOR": TIPOS_VALOR,
        **ctx,
    }
    return templates.TemplateResponse(request, nome, contexto, status_code=status_code)


def redirect(url: str) -> RedirectResponse:
    return RedirectResponse(url, status_code=303)


def _proximo_seguro(proximo: str | None) -> str:
    if proximo and proximo.startswith("/") and not proximo.startswith("//"):
        return proximo
    return "/painel"


def _filtros_busca(request: Request) -> dict:
    q = request.query_params
    filtros = {
        "origem_uf": q.get("origem_uf", ""),
        "origem_cidade": q.get("origem_cidade", "").strip(),
        "destino_uf": q.get("destino_uf", ""),
        "destino_cidade": q.get("destino_cidade", "").strip(),
        "veiculo": q.get("veiculo", ""),
        "carroceria": q.get("carroceria", ""),
    }
    # Ignora valores fora do catálogo em vez de quebrar a busca.
    if filtros["origem_uf"] not in UFS:
        filtros["origem_uf"] = ""
    if filtros["destino_uf"] not in UFS:
        filtros["destino_uf"] = ""
    if filtros["veiculo"] not in VEICULOS:
        filtros["veiculo"] = ""
    if filtros["carroceria"] not in CARROCERIAS:
        filtros["carroceria"] = ""
    return filtros


# --- páginas públicas ---


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/")
def inicio(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    recentes = db.buscar_fretes(conn, limite=10)
    return render(request, conn, "inicio.html", fretes=recentes, filtros=_filtros_busca(request))


@app.get("/fretes")
def lista_fretes(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    filtros = _filtros_busca(request)
    fretes = db.buscar_fretes(conn, **filtros)
    return render(request, conn, "fretes.html", fretes=fretes, filtros=filtros)


@app.get("/fretes/novo")
def novo_frete_form(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    exigir_usuario(request, conn, "embarcador")
    return render(request, conn, "frete_form.html", dados={"tipo_valor": "total"}, erros=[])


@app.post("/fretes/novo")
async def novo_frete(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    usuario = exigir_usuario(request, conn, "embarcador")
    form = await request.form()
    dados = {k: str(v).strip() for k, v in form.items() if k not in ("veiculos", "carrocerias")}
    dados["veiculos"] = [v for v in form.getlist("veiculos") if v in VEICULOS]
    dados["carrocerias"] = [c for c in form.getlist("carrocerias") if c in CARROCERIAS]

    erros: list[str] = []
    for campo, rotulo in [
        ("origem_cidade", "cidade de origem"),
        ("destino_cidade", "cidade de destino"),
        ("produto", "produto"),
        ("data_coleta", "data de coleta"),
    ]:
        if not dados.get(campo):
            erros.append(f"Informe a {rotulo}.")
    if dados.get("origem_uf") not in UFS:
        erros.append("Selecione a UF de origem.")
    if dados.get("destino_uf") not in UFS:
        erros.append("Selecione a UF de destino.")
    if dados.get("especie") not in ESPECIES:
        erros.append("Selecione a espécie da carga.")
    if dados.get("tipo_valor") not in TIPOS_VALOR:
        dados["tipo_valor"] = "total"
    if not dados["veiculos"]:
        erros.append("Marque pelo menos um tipo de veículo.")
    if not dados["carrocerias"]:
        erros.append("Marque pelo menos um tipo de carroceria.")
    try:
        peso_kg = int(somente_digitos(dados.get("peso_kg", "")) or 0)
        if peso_kg <= 0:
            raise ValueError
    except ValueError:
        peso_kg = 0
        erros.append("Informe o peso da carga em kg.")
    try:
        valor_centavos = parse_valor_brl(dados.get("valor", ""))
    except ValueError:
        valor_centavos = None
        erros.append("Valor do frete inválido (ex.: 3.500,00). Deixe em branco para 'a combinar'.")
    if dados.get("data_coleta"):
        try:
            if date.fromisoformat(dados["data_coleta"]) < date.today():
                erros.append("A data de coleta não pode estar no passado.")
        except ValueError:
            erros.append("Data de coleta inválida.")

    if erros:
        return render(request, conn, "frete_form.html", status_code=400, dados=dados, erros=erros)

    frete_id = db.criar_frete(
        conn,
        usuario["id"],
        origem_cidade=dados["origem_cidade"],
        origem_uf=dados["origem_uf"],
        destino_cidade=dados["destino_cidade"],
        destino_uf=dados["destino_uf"],
        produto=dados["produto"],
        especie=dados["especie"],
        peso_kg=peso_kg,
        valor_centavos=valor_centavos,
        tipo_valor=dados["tipo_valor"],
        veiculos=",".join(dados["veiculos"]),
        carrocerias=",".join(dados["carrocerias"]),
        data_coleta=dados["data_coleta"],
        rastreamento=1 if dados.get("rastreamento") else 0,
        observacoes=dados.get("observacoes") or None,
    )
    conn.commit()
    flash(request, "Frete publicado! Os motoristas já podem encontrá-lo na busca.")
    return redirect(f"/fretes/{frete_id}")


def _frete_ou_404(conn: sqlite3.Connection, frete_id: int) -> sqlite3.Row:
    frete = db.frete_por_id(conn, frete_id)
    if frete is None:
        raise HTTPException(status_code=404, detail="Frete não encontrado.")
    return frete


@app.get("/fretes/{frete_id}")
def detalhe_frete(frete_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    frete = _frete_ou_404(conn, frete_id)
    usuario = usuario_atual(request, conn)
    ctx: dict = {"frete": frete, "reputacao_embarcador": db.reputacao(conn, frete["embarcador_id"])}
    if usuario is not None:
        eh_dono = usuario["id"] == frete["embarcador_id"]
        eh_contratado = usuario["id"] == frete["motorista_id"]
        ctx["eh_dono"] = eh_dono
        ctx["eh_contratado"] = eh_contratado
        if eh_dono:
            ctx["candidaturas"] = db.candidaturas_do_frete(conn, frete_id)
            if frete["motorista_id"]:
                ctx["motorista_contratado"] = db.usuario_por_id(conn, frete["motorista_id"])
        if usuario["tipo"] == "motorista":
            ctx["minha_candidatura"] = db.candidatura_do_motorista(conn, frete_id, usuario["id"])
            ctx["meu_veiculo"] = db.veiculo_do_motorista(conn, usuario["id"])
        if frete["status"] == "fechado" and (eh_dono or eh_contratado):
            ctx["pode_avaliar"] = db.avaliacao_do_autor(conn, frete_id, usuario["id"]) is None
    return render(request, conn, "frete_detalhe.html", **ctx)


@app.post("/fretes/{frete_id}/candidatar")
async def candidatar(frete_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    usuario = exigir_usuario(request, conn, "motorista")
    frete = _frete_ou_404(conn, frete_id)
    if frete["status"] != "aberto":
        flash(request, "Este frete não está mais disponível.", "erro")
        return redirect(f"/fretes/{frete_id}")
    if db.veiculo_do_motorista(conn, usuario["id"]) is None:
        flash(request, "Cadastre seu veículo antes de se candidatar a fretes.", "erro")
        return redirect(f"/perfil/veiculo?proximo=/fretes/{frete_id}")
    form = await request.form()
    mensagem = str(form.get("mensagem", "")).strip()[:500]
    if db.candidatar(conn, frete_id, usuario["id"], mensagem):
        conn.commit()
        flash(request, "Interesse enviado! O embarcador vai ver seu perfil e veículo.")
    else:
        flash(request, "Você já demonstrou interesse neste frete.", "erro")
    return redirect(f"/fretes/{frete_id}")


@app.post("/fretes/{frete_id}/candidaturas/{candidatura_id}/aceitar")
def aceitar(frete_id: int, candidatura_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    usuario = exigir_usuario(request, conn, "embarcador")
    frete = _frete_ou_404(conn, frete_id)
    if frete["embarcador_id"] != usuario["id"]:
        raise HTTPException(status_code=403, detail="Este frete não é seu.")
    if db.aceitar_candidatura(conn, frete_id, candidatura_id):
        conn.commit()
        flash(request, "Frete fechado! Combine os detalhes da coleta com o motorista.")
    else:
        flash(request, "Não foi possível fechar o frete (já fechado ou candidatura inválida).", "erro")
    return redirect(f"/fretes/{frete_id}")


@app.post("/fretes/{frete_id}/cancelar")
def cancelar(frete_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    usuario = exigir_usuario(request, conn, "embarcador")
    frete = _frete_ou_404(conn, frete_id)
    if frete["embarcador_id"] != usuario["id"]:
        raise HTTPException(status_code=403, detail="Este frete não é seu.")
    db.cancelar_frete(conn, frete_id)
    conn.commit()
    flash(request, "Frete cancelado.")
    return redirect("/painel")


@app.post("/fretes/{frete_id}/avaliar")
async def avaliar(frete_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    usuario = exigir_usuario(request, conn)
    frete = _frete_ou_404(conn, frete_id)
    if frete["status"] != "fechado" or usuario["id"] not in (frete["embarcador_id"], frete["motorista_id"]):
        raise HTTPException(status_code=403, detail="Só quem participou do frete pode avaliar.")
    avaliado_id = frete["motorista_id"] if usuario["id"] == frete["embarcador_id"] else frete["embarcador_id"]
    form = await request.form()
    try:
        nota = int(str(form.get("nota", "")))
        if not 1 <= nota <= 5:
            raise ValueError
    except ValueError:
        flash(request, "Escolha uma nota de 1 a 5.", "erro")
        return redirect(f"/fretes/{frete_id}")
    comentario = str(form.get("comentario", "")).strip()[:500]
    if db.avaliar(conn, frete_id, usuario["id"], avaliado_id, nota, comentario):
        conn.commit()
        flash(request, "Avaliação registrada. Obrigado!")
    else:
        flash(request, "Você já avaliou este frete.", "erro")
    return redirect(f"/fretes/{frete_id}")


@app.get("/usuarios/{usuario_id}")
def perfil_publico(usuario_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    perfil = db.usuario_por_id(conn, usuario_id)
    if perfil is None:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")
    return render(
        request,
        conn,
        "usuario.html",
        perfil=perfil,
        reputacao=db.reputacao(conn, usuario_id),
        avaliacoes=db.avaliacoes_recebidas(conn, usuario_id),
        veiculo=db.veiculo_do_motorista(conn, usuario_id) if perfil["tipo"] == "motorista" else None,
    )


# --- conta ---


@app.get("/cadastro")
def cadastro_form(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    tipo = request.query_params.get("tipo", "motorista")
    return render(request, conn, "cadastro.html", dados={"tipo": tipo}, erros=[])


@app.post("/cadastro")
async def cadastro(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    form = await request.form()
    dados = {k: str(v).strip() for k, v in form.items()}
    dados["email"] = dados.get("email", "").lower()
    erros: list[str] = []
    if dados.get("tipo") not in ("embarcador", "motorista"):
        erros.append("Escolha se você é embarcador ou motorista.")
    if not dados.get("nome"):
        erros.append("Informe seu nome.")
    if "@" not in dados.get("email", ""):
        erros.append("Informe um e-mail válido.")
    elif db.usuario_por_email(conn, dados["email"]):
        erros.append("Já existe uma conta com este e-mail.")
    if len(somente_digitos(dados.get("telefone", ""))) < 10:
        erros.append("Informe um telefone/WhatsApp com DDD.")
    documento = somente_digitos(dados.get("documento", ""))
    if dados.get("tipo") == "embarcador":
        if len(documento) not in (11, 14):
            erros.append("Informe o CNPJ da empresa (ou CPF, se pessoa física).")
        if not dados.get("empresa"):
            erros.append("Informe o nome da empresa.")
    elif len(documento) != 11:
        erros.append("Informe seu CPF (11 dígitos).")
    if len(dados.get("senha", "")) < 8:
        erros.append("A senha precisa ter pelo menos 8 caracteres.")
    if dados.get("uf") and dados["uf"] not in UFS:
        dados["uf"] = ""

    if erros:
        dados.pop("senha", None)
        return render(request, conn, "cadastro.html", status_code=400, dados=dados, erros=erros)

    uid = db.criar_usuario(
        conn,
        tipo=dados["tipo"],
        nome=dados["nome"],
        email=dados["email"],
        telefone=somente_digitos(dados["telefone"]),
        documento=documento,
        empresa=dados.get("empresa") or None,
        cidade=dados.get("cidade") or None,
        uf=dados.get("uf") or None,
        senha_hash=hash_senha(dados["senha"], get_settings().password_iterations),
    )
    conn.commit()
    request.session.clear()
    request.session["uid"] = uid
    if dados["tipo"] == "motorista":
        flash(request, "Conta criada! Agora cadastre seu veículo para ver fretes compatíveis.")
        return redirect("/perfil/veiculo")
    flash(request, "Conta criada! Publique seu primeiro frete.")
    return redirect("/fretes/novo")


@app.get("/entrar")
def entrar_form(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    return render(request, conn, "entrar.html", proximo=request.query_params.get("proximo", ""), erro=None)


@app.post("/entrar")
async def entrar(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    form = await request.form()
    email = str(form.get("email", "")).strip().lower()
    senha = str(form.get("senha", ""))
    proximo = str(form.get("proximo", ""))
    usuario = db.usuario_por_email(conn, email)
    if usuario is None or not verificar_senha(senha, usuario["senha_hash"]):
        return render(request, conn, "entrar.html", status_code=400, proximo=proximo, erro="E-mail ou senha incorretos.")
    request.session.clear()
    request.session["uid"] = usuario["id"]
    return redirect(_proximo_seguro(proximo))


@app.post("/sair")
def sair(request: Request):
    request.session.clear()
    return redirect("/")


@app.get("/painel")
def painel(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    usuario = exigir_usuario(request, conn)
    reputacao = db.reputacao(conn, usuario["id"])
    if usuario["tipo"] == "embarcador":
        return render(
            request, conn, "painel_embarcador.html", fretes=db.fretes_do_embarcador(conn, usuario["id"]), reputacao=reputacao
        )
    veiculo = db.veiculo_do_motorista(conn, usuario["id"])
    compativeis = (
        db.buscar_fretes(conn, veiculo=veiculo["tipo_veiculo"], carroceria=veiculo["carroceria"], limite=10)
        if veiculo
        else []
    )
    return render(
        request,
        conn,
        "painel_motorista.html",
        veiculo=veiculo,
        candidaturas=db.candidaturas_do_motorista(conn, usuario["id"]),
        compativeis=compativeis,
        reputacao=reputacao,
    )


@app.get("/perfil/veiculo")
def veiculo_form(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    usuario = exigir_usuario(request, conn, "motorista")
    veiculo = db.veiculo_do_motorista(conn, usuario["id"])
    return render(
        request,
        conn,
        "veiculo_form.html",
        dados=dict(veiculo) if veiculo else {},
        erros=[],
        proximo=request.query_params.get("proximo", ""),
    )


@app.post("/perfil/veiculo")
async def salvar_veiculo(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    usuario = exigir_usuario(request, conn, "motorista")
    form = await request.form()
    dados = {k: str(v).strip() for k, v in form.items()}
    dados["placa"] = dados.get("placa", "").upper().replace("-", "").replace(" ", "")
    erros: list[str] = []
    if dados.get("tipo_veiculo") not in VEICULOS:
        erros.append("Selecione o tipo de veículo.")
    if dados.get("carroceria") not in CARROCERIAS:
        erros.append("Selecione a carroceria.")
    if len(dados["placa"]) != 7:
        erros.append("Placa inválida (ex.: ABC1D23).")
    capacidade = somente_digitos(dados.get("capacidade_kg", ""))
    if erros:
        return render(
            request, conn, "veiculo_form.html", status_code=400, dados=dados, erros=erros, proximo=dados.get("proximo", "")
        )
    db.salvar_veiculo(
        conn,
        usuario["id"],
        tipo_veiculo=dados["tipo_veiculo"],
        carroceria=dados["carroceria"],
        placa=dados["placa"],
        rntrc=somente_digitos(dados.get("rntrc", "")) or None,
        capacidade_kg=int(capacidade) if capacidade else None,
    )
    conn.commit()
    flash(request, "Veículo salvo.")
    return redirect(_proximo_seguro(dados.get("proximo")))


# --- API JSON (somente leitura) ---


def _frete_json(frete: sqlite3.Row) -> dict:
    return {
        "id": frete["id"],
        "origem": {"cidade": frete["origem_cidade"], "uf": frete["origem_uf"]},
        "destino": {"cidade": frete["destino_cidade"], "uf": frete["destino_uf"]},
        "produto": frete["produto"],
        "especie": frete["especie"],
        "peso_kg": frete["peso_kg"],
        "valor": frete["valor_centavos"] / 100 if frete["valor_centavos"] is not None else None,
        "tipo_valor": frete["tipo_valor"],
        "veiculos": [v for v in frete["veiculos"].split(",") if v],
        "carrocerias": [c for c in frete["carrocerias"].split(",") if c],
        "data_coleta": frete["data_coleta"],
        "rastreamento": bool(frete["rastreamento"]),
        "status": frete["status"],
        "embarcador": frete["embarcador_empresa"] or frete["embarcador_nome"],
        "criado_em": frete["criado_em"],
    }


@app.get("/api/fretes")
def api_lista_fretes(request: Request, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    fretes = db.buscar_fretes(conn, **_filtros_busca(request))
    return {"fretes": [_frete_json(f) for f in fretes]}


@app.get("/api/fretes/{frete_id}")
def api_detalhe_frete(frete_id: int, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    return _frete_json(_frete_ou_404(conn, frete_id))
