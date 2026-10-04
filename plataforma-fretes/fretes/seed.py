"""Popula o banco com dados de demonstração: `python -m fretes.seed`.

Cria um embarcador (demo@embarcador.com) e um motorista (demo@motorista.com),
ambos com a senha `demo12345`, e alguns fretes abertos.
"""
from __future__ import annotations

from datetime import date, timedelta

from fretes import db
from fretes.auth import hash_senha
from fretes.config import get_settings

SENHA = "demo12345"

FRETES = [
    ("Santos", "SP", "Uberlândia", "MG", "Contêiner 40' de café", "Contêiner", 26000, 480000, "total", "carreta,carreta_ls", "porta_container"),
    ("Sorriso", "MT", "Paranaguá", "PR", "Soja em grãos", "Granel", 37000, 28000, "tonelada", "bitrem,rodotrem", "graneleiro"),
    ("Joinville", "SC", "São Paulo", "SP", "Peças automotivas", "Paletizada", 12000, 520000, "total", "truck,carreta", "bau,sider"),
    ("Campinas", "SP", "Rio de Janeiro", "RJ", "Alimentos refrigerados", "Caixas", 8000, None, "total", "truck,toco", "bau_frigorifico"),
    ("Betim", "MG", "Salvador", "BA", "Bobinas de aço", "Outros", 30000, 950000, "total", "carreta,vanderleia", "grade_baixa,prancha"),
    ("Itajaí", "SC", "Curitiba", "PR", "Contêiner 20' vazio", "Contêiner", 2300, 150000, "total", "carreta,truck", "porta_container"),
]


def main() -> None:
    settings = get_settings()
    db.init_db(settings.db_path)
    conn = db.connect(settings.db_path)
    if db.usuario_por_email(conn, "demo@embarcador.com"):
        print("Dados de demonstração já existem.")
        return
    senha_hash = hash_senha(SENHA, settings.password_iterations)
    emb = db.criar_usuario(
        conn, tipo="embarcador", nome="Ana Souza", email="demo@embarcador.com", telefone="11912345678",
        documento="12345678000190", empresa="Logística Demo Ltda", cidade="Santos", uf="SP", senha_hash=senha_hash,
    )
    mot = db.criar_usuario(
        conn, tipo="motorista", nome="Carlos Lima", email="demo@motorista.com", telefone="11998765432",
        documento="12345678901", empresa=None, cidade="Cubatão", uf="SP", senha_hash=senha_hash,
    )
    db.salvar_veiculo(conn, mot, tipo_veiculo="carreta", carroceria="porta_container", placa="ABC1D23",
                      rntrc="012345678", capacidade_kg=30000)
    for i, (oc, ouf, dc, duf, produto, especie, peso, valor, tipo_valor, veiculos, carrocerias) in enumerate(FRETES):
        db.criar_frete(
            conn, emb, origem_cidade=oc, origem_uf=ouf, destino_cidade=dc, destino_uf=duf, produto=produto,
            especie=especie, peso_kg=peso, valor_centavos=valor, tipo_valor=tipo_valor, veiculos=veiculos,
            carrocerias=carrocerias, data_coleta=(date.today() + timedelta(days=i + 1)).isoformat(),
            rastreamento=i % 2, observacoes=None,
        )
    conn.commit()
    conn.close()
    print(f"Pronto: {len(FRETES)} fretes. Logins: demo@embarcador.com / demo@motorista.com (senha {SENHA})")


if __name__ == "__main__":
    main()
