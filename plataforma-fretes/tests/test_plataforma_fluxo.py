from datetime import date, timedelta

from fretes import db
from tests.conftest import cadastrar, cadastrar_veiculo, publicar_frete


def test_paginas_publicas(novo_cliente):
    c = novo_cliente()
    for url in ["/", "/fretes", "/cadastro", "/entrar", "/health"]:
        assert c.get(url).status_code == 200, url


def test_publicar_frete_exige_embarcador(novo_cliente):
    anonimo = novo_cliente()
    r = anonimo.get("/fretes/novo", follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"].startswith("/entrar?proximo=")

    motorista = novo_cliente()
    cadastrar(motorista, "motorista", "moto@ex.com")
    assert motorista.get("/fretes/novo").status_code == 403


def test_validacao_do_frete(novo_cliente):
    emb = novo_cliente()
    cadastrar(emb, "embarcador", "emb@ex.com")
    ontem = (date.today() - timedelta(days=1)).isoformat()
    r = emb.post(
        "/fretes/novo",
        data={"origem_cidade": "Santos", "origem_uf": "SP", "destino_uf": "XX", "peso_kg": "", "data_coleta": ontem},
    )
    assert r.status_code == 400
    assert "cidade de destino" in r.text
    assert "UF de destino" in r.text
    assert "peso" in r.text
    assert "veículo" in r.text
    assert "passado" in r.text
    assert 'value="Santos"' in r.text  # mantém o que já foi digitado


def test_cadastro_rejeita_email_duplicado(novo_cliente):
    cadastrar(novo_cliente(), "motorista", "dup@ex.com")
    r = novo_cliente().post(
        "/cadastro",
        data={"tipo": "motorista", "nome": "X", "email": "DUP@ex.com", "telefone": "11912345678",
              "documento": "12345678901", "senha": "12345678"},
    )
    assert r.status_code == 400
    assert "Já existe uma conta" in r.text


def test_login_e_redirecionamento_seguro(novo_cliente):
    cadastrar(novo_cliente(), "motorista", "login@ex.com")
    c = novo_cliente()
    r = c.post("/entrar", data={"email": "login@ex.com", "senha": "errada"})
    assert r.status_code == 400
    r = c.post("/entrar", data={"email": "login@ex.com", "senha": "senha-forte-123", "proximo": "//evil.com"},
               follow_redirects=False)
    assert r.headers["location"] == "/painel"
    r = c.post("/entrar", data={"email": "login@ex.com", "senha": "senha-forte-123", "proximo": "/fretes"},
               follow_redirects=False)
    assert r.headers["location"] == "/fretes"


def test_busca_com_filtros(novo_cliente, db_path):
    emb = novo_cliente()
    cadastrar(emb, "embarcador", "emb@ex.com")
    publicar_frete(emb)
    publicar_frete(emb, origem_cidade="São Paulo", destino_cidade="Curitiba", destino_uf="PR",
                   produto="Soja", especie="Granel", veiculos=["bitrem"], carrocerias=["graneleiro"], valor="")

    anonimo = novo_cliente()
    assert "Uberlândia" in anonimo.get("/fretes").text
    r = anonimo.get("/fretes", params={"origem_cidade": "sao paulo"})
    assert "Curitiba" in r.text and "Uberlândia" not in r.text
    r = anonimo.get("/fretes", params={"carroceria": "porta_container"})
    assert "Uberlândia" in r.text and "Curitiba" not in r.text
    r = anonimo.get("/fretes", params={"veiculo": "bitrem", "destino_uf": "PR"})
    assert "Curitiba" in r.text and "A combinar" in r.text

    api = anonimo.get("/api/fretes", params={"destino_uf": "MG"}).json()["fretes"]
    assert len(api) == 1
    assert api[0]["valor"] == 4800.0
    assert api[0]["peso_kg"] == 26000
    assert api[0]["carrocerias"] == ["porta_container"]
    assert "telefone" not in str(api[0])  # contato só para usuários logados


def test_contato_so_para_logados(novo_cliente):
    emb = novo_cliente()
    cadastrar(emb, "embarcador", "emb@ex.com")
    frete_id = publicar_frete(emb)

    anonimo = novo_cliente()
    r = anonimo.get(f"/fretes/{frete_id}")
    assert "wa.me" not in r.text
    assert "Entre para ver o contato" in r.text

    mot = novo_cliente()
    cadastrar(mot, "motorista", "mot@ex.com")
    assert "https://wa.me/5511912345678" in mot.get(f"/fretes/{frete_id}").text


def test_fluxo_completo_candidatura_fechamento_avaliacao(novo_cliente, db_path):
    emb = novo_cliente()
    cadastrar(emb, "embarcador", "emb@ex.com")
    frete_id = publicar_frete(emb)

    mot1 = novo_cliente()
    cadastrar(mot1, "motorista", "m1@ex.com", nome="Carlos Lima")
    # sem veículo, não consegue se candidatar
    r = mot1.post(f"/fretes/{frete_id}/candidatar", data={}, follow_redirects=False)
    assert r.headers["location"].startswith("/perfil/veiculo")
    cadastrar_veiculo(mot1)
    assert "Fretes para o seu veículo" in mot1.get("/painel").text
    r = mot1.post(f"/fretes/{frete_id}/candidatar", data={"mensagem": "Disponível amanhã"}, follow_redirects=True)
    assert "Interesse enviado" in r.text
    r = mot1.post(f"/fretes/{frete_id}/candidatar", data={}, follow_redirects=True)
    assert "já demonstrou interesse" in r.text

    mot2 = novo_cliente()
    cadastrar(mot2, "motorista", "m2@ex.com", nome="Pedro Alves")
    cadastrar_veiculo(mot2, "truck", "bau")
    mot2.post(f"/fretes/{frete_id}/candidatar", data={})

    pagina = emb.get(f"/fretes/{frete_id}").text
    assert "Carlos Lima" in pagina and "Pedro Alves" in pagina and "Disponível amanhã" in pagina
    assert "ABC1D23" in pagina

    conn = db.connect(db_path)
    cands = {c["motorista_nome"]: c["id"] for c in db.candidaturas_do_frete(conn, frete_id)}
    conn.close()

    # outro embarcador não pode fechar o frete
    intruso = novo_cliente()
    cadastrar(intruso, "embarcador", "intruso@ex.com")
    r = intruso.post(f"/fretes/{frete_id}/candidaturas/{cands['Carlos Lima']}/aceitar")
    assert r.status_code == 403

    r = emb.post(f"/fretes/{frete_id}/candidaturas/{cands['Carlos Lima']}/aceitar", follow_redirects=True)
    assert "Frete fechado" in r.text

    conn = db.connect(db_path)
    frete = db.frete_por_id(conn, frete_id)
    assert frete["status"] == "fechado"
    status = {c["motorista_nome"]: c["status"] for c in db.candidaturas_do_frete(conn, frete_id)}
    conn.close()
    assert status == {"Carlos Lima": "aceita", "Pedro Alves": "recusada"}

    # frete fechado some da busca
    assert "Uberlândia" not in novo_cliente().get("/fretes").text
    assert "foi contratado" in mot1.get(f"/fretes/{frete_id}").text

    # avaliações cruzadas; quem não participou não avalia
    assert mot2.post(f"/fretes/{frete_id}/avaliar", data={"nota": "5"}).status_code == 403
    r = emb.post(f"/fretes/{frete_id}/avaliar", data={"nota": "5", "comentario": "Pontual"}, follow_redirects=True)
    assert "Avaliação registrada" in r.text
    r = emb.post(f"/fretes/{frete_id}/avaliar", data={"nota": "4"}, follow_redirects=True)
    assert "já avaliou" in r.text
    mot1.post(f"/fretes/{frete_id}/avaliar", data={"nota": "4"})

    conn = db.connect(db_path)
    mot1_id = db.usuario_por_email(conn, "m1@ex.com")["id"]
    emb_id = db.usuario_por_email(conn, "emb@ex.com")["id"]
    assert db.reputacao(conn, mot1_id) == {"total": 1, "media": 5.0}
    assert db.reputacao(conn, emb_id) == {"total": 1, "media": 4.0}
    conn.close()
    assert "Pontual" in novo_cliente().get(f"/usuarios/{mot1_id}").text


def test_cancelar_frete(novo_cliente, db_path):
    emb = novo_cliente()
    cadastrar(emb, "embarcador", "emb@ex.com")
    frete_id = publicar_frete(emb)
    r = emb.post(f"/fretes/{frete_id}/cancelar", follow_redirects=True)
    assert "Frete cancelado" in r.text
    assert novo_cliente().get("/api/fretes").json() == {"fretes": []}
    assert novo_cliente().get(f"/api/fretes/{frete_id}").json()["status"] == "cancelado"
    assert novo_cliente().get("/api/fretes/9999").status_code == 404
