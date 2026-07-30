# -*- coding: utf-8 -*-
"""Converte os shapefiles de camadas/ e os KMZ/KML de pontos fixos para dados/."""
import json
import re
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

import geopandas as gpd

BASE = Path(__file__).parent
CAMADAS = BASE / "camadas"
DADOS = BASE / "dados"
DADOS.mkdir(exist_ok=True)

regioes = []
for shp in sorted(CAMADAS.glob("*.shp")):
    m = re.match(r"R(\d+)_", shp.stem)
    if not m:
        continue  # só os R<num>_REGIÃO são regiões; outros shapefiles têm uso próprio
    num = int(m.group(1))
    gdf = gpd.read_file(shp).to_crs(epsg=4326)
    gdf["REGIAO"] = num
    regioes.append(gdf)
    print(f"{shp.name}: {len(gdf)} feicoes, colunas: {list(gdf.columns)}")

todas = gpd.pd.concat(regioes, ignore_index=True)
todas = todas.sort_values("REGIAO").reset_index(drop=True)

out = DADOS / "regioes.geojson"
todas.to_file(out, driver="GeoJSON")
print(f"\nGerado {out} com {len(todas)} feicoes")
print("Regioes:", sorted(todas["REGIAO"].unique().tolist()))

# versao .js para o mapa abrir direto do disco (file://), sem servidor
geo = json.loads(out.read_text(encoding="utf-8"))
js = DADOS / "regioes.js"
js.write_text("const DADOS_REGIOES = " + json.dumps(geo, ensure_ascii=False) + ";\n",
              encoding="utf-8")
print(f"Gerado {js}")

# bounds gerais para centrar o mapa
b = todas.total_bounds
print("Bounds (WGS84):", json.dumps([round(v, 5) for v in b.tolist()]))

# ---------------------------------------------------------------------------
# Pontos fixos e rotas: qualquer .kmz/.kml em qualquer subpasta (menos dados/).
# - LineString -> rota fixa (nome = pasta do KML, ex.: "LOTE 11")
# - Point -> ponto fixo; categoria pelo NOME do placemark (PEDREIRA, AREIAL,
#   CANTEIRO, CIMENTO/CAL...) ou, se não der, pelo nome do arquivo.
#   Pontos sem categoria (ex.: instruções "Siga em direção a...") são ignorados.
# - Pontos a menos de 250 m de outro da mesma categoria são descartados.
# ---------------------------------------------------------------------------
import math

NS = {"k": "http://www.opengis.net/kml/2.2"}
# regex com fronteira de palavra: "CAL" isolada é cimento/cal, mas não pega
# PHISICAL/NATICAL; "PEDR" cobre PEDREIRA e abreviações como "PEDR."
CATEGORIAS_CHAVE = [
    (r"\bPEDR", "pedreira"), (r"\bCIMENTO", "cimento"), (r"\bCAL\b", "cimento"),
    (r"\bCANTEIRO", "canteiro"), (r"\bJAZIDA", "jazida"), (r"\bUSINA", "usina"),
    (r"\bAPOIO\b", "apoio"), (r"\bAREI?AL\b", "areial"),
]

def sem_acento(txt):
    return unicodedata.normalize("NFKD", txt).encode("ascii", "ignore").decode()

def categoria_de(texto):
    chave = sem_acento(texto).upper()
    for padrao, cat in CATEGORIAS_CHAVE:
        if re.search(padrao, chave):
            return cat
    return None

def dist_m(a, b):
    r = 6371000.0
    la1, lo1, la2, lo2 = map(math.radians, [a["lat"], a["lng"], b["lat"], b["lng"]])
    h = (math.sin((la2 - la1) / 2) ** 2
         + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(h))

# linhas dos KMZ (ex.: rota do Google Maps no LOTE 11) NÃO entram no mapa;
# mude para True se um dia quiser importá-las de novo
IMPORTAR_ROTAS = False

fixos, rotas = [], []
descartados = 0
# arquivos de categoria (PEDREIRAS.kmz etc.) primeiro: têm os nomes melhores,
# então em caso de duplicata é o ponto genérico do lote que sai
origens = sorted((p for p in BASE.rglob("*.km[lz]") if "dados" not in p.parts),
                 key=lambda p: (categoria_de(p.stem) is None, str(p).lower()))
for arq in origens:
    if arq.suffix.lower() == ".kmz":
        with zipfile.ZipFile(arq) as z:
            kml_interno = next(n for n in z.namelist() if n.lower().endswith(".kml"))
            texto = z.read(kml_interno).decode("utf-8")
    else:
        texto = arq.read_text(encoding="utf-8")
    root = ET.fromstring(texto)
    pasta_kml = (root.findtext(".//k:Folder/k:name", "", NS) or "").strip()
    rotulo = pasta_kml or arq.stem
    cat_arquivo = categoria_de(arq.stem)
    n_pts = n_rotas = 0
    for pm in root.findall(".//k:Placemark", NS):
        nome_pm = (pm.findtext("k:name", "", NS) or "Sem nome").strip()
        ponto = pm.find(".//k:Point/k:coordinates", NS)
        linha = pm.find(".//k:LineString/k:coordinates", NS)
        if linha is not None and (linha.text or "").strip():
            if not IMPORTAR_ROTAS:
                continue
            latlngs = []
            for par in linha.text.strip().split():
                lng, lat = [float(v) for v in par.split(",")[:2]]
                latlngs.append([round(lat, 6), round(lng, 6)])
            if len(latlngs) >= 2:
                nome_rota = rotulo if n_rotas == 0 else f"{rotulo} ({n_rotas + 1})"
                rotas.append({"nome": nome_rota, "latlngs": latlngs, "arquivo": arq.name})
                n_rotas += 1
        elif ponto is not None and (ponto.text or "").strip():
            cat_nome = categoria_de(nome_pm)
            cat = cat_nome or cat_arquivo
            if cat is None:
                descartados += 1
                continue
            lng, lat = [float(v) for v in ponto.text.strip().split(",")[:2]]
            nome = f"{nome_pm} ({rotulo})" if (cat_nome and not cat_arquivo) else nome_pm
            fixos.append({
                "nome": nome, "categoria": cat,
                "descricao": (pm.findtext("k:description", "", NS) or "").strip(),
                "lat": round(lat, 6), "lng": round(lng, 6),
                "arquivo": arq.name,
            })
            n_pts += 1
    print(f"{arq.name}: {n_pts} ponto(s), {n_rotas} rota(s)")

# remove duplicatas ENTRE arquivos (mesma categoria a menos de 250 m);
# dentro de um mesmo arquivo tudo é preservado
unicos = []
for p in fixos:
    dup = next((u for u in unicos if u["categoria"] == p["categoria"]
                and u["arquivo"] != p["arquivo"] and dist_m(u, p) < 250), None)
    if dup:
        print(f"  duplicado descartado: {p['nome']} ({p['arquivo']}) ~ {dup['nome']}")
    else:
        unicos.append(p)
fixos = unicos

# cidades da base IBGE (BCLocalidadePonto250), se o shapefile estiver na pasta
shp_cid = CAMADAS / "BCLocalidadePonto250_GCS.shp"
if shp_cid.exists():
    cid = gpd.read_file(shp_cid).to_crs(epsg=4326)
    cid = cid[cid["TIP_LOCALI"].isin([6, 8])]  # 6 = capital, 8 = cidade
    n_cid = 0
    for _, r in cid.iterrows():
        nome = str(r["NM_IDENTIF"]).strip()
        if not nome or nome.lower() == "nan":
            continue
        uf = str(r.get("NM_UF") or "").strip()
        if uf and uf != "TO":
            nome = f"{nome} ({uf})"
        fixos.append({
            "nome": nome, "categoria": "cidade", "descricao": "",
            "lat": round(r.geometry.y, 6), "lng": round(r.geometry.x, 6),
            "arquivo": shp_cid.name,
        })
        n_cid += 1
    print(f"{shp_cid.name}: {n_cid} cidade(s)")

(DADOS / "pontos_fixos.js").write_text(
    "const DADOS_PONTOS_FIXOS = " + json.dumps(fixos, ensure_ascii=False) + ";\n",
    encoding="utf-8")
(DADOS / "rotas.js").write_text(
    "const DADOS_ROTAS = " + json.dumps(rotas, ensure_ascii=False) + ";\n",
    encoding="utf-8")
print(f"Gerado pontos_fixos.js ({len(fixos)} pontos, {descartados} sem categoria ignorados)")
print(f"Gerado rotas.js ({len(rotas)} rotas)")