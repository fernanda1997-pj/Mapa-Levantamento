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
    num = int(m.group(1)) if m else 0
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
# Pontos fixos: qualquer .kmz/.kml na pasta base ou em "pontos fixos/".
# A categoria é deduzida do nome do arquivo (PEDREIRAS.kmz -> pedreira).
# ---------------------------------------------------------------------------
NS = {"k": "http://www.opengis.net/kml/2.2"}
CATEGORIA_POR_ARQUIVO = [
    ("PEDREIRA", "pedreira"), ("CIMENTO", "cimento"), ("CANTEIRO", "canteiro"),
    ("JAZIDA", "jazida"), ("USINA", "usina"), ("APOIO", "apoio"),
]

def sem_acento(txt):
    return unicodedata.normalize("NFKD", txt).encode("ascii", "ignore").decode()

def categoria_do_arquivo(nome):
    chave = sem_acento(nome).upper()
    for trecho, cat in CATEGORIA_POR_ARQUIVO:
        if trecho in chave:
            return cat
    return "outro"

def ler_kml(texto, categoria, arquivo):
    pontos = []
    root = ET.fromstring(texto)
    for pm in root.findall(".//k:Placemark", NS):
        coords = pm.find(".//k:Point/k:coordinates", NS)
        if coords is None or not (coords.text or "").strip():
            continue
        lng, lat = [float(v) for v in coords.text.strip().split(",")[:2]]
        pontos.append({
            "nome": (pm.findtext("k:name", "", NS) or "Sem nome").strip(),
            "categoria": categoria,
            "descricao": (pm.findtext("k:description", "", NS) or "").strip(),
            "lat": round(lat, 6), "lng": round(lng, 6),
            "arquivo": arquivo,
        })
    return pontos

fixos = []
origens = sorted(set(BASE.glob("*.km[lz]")) | set((BASE / "pontos fixos").glob("*.km[lz]")))
for arq in origens:
    if arq.suffix.lower() == ".kmz":
        with zipfile.ZipFile(arq) as z:
            kml_interno = next(n for n in z.namelist() if n.lower().endswith(".kml"))
            texto = z.read(kml_interno).decode("utf-8")
    else:
        texto = arq.read_text(encoding="utf-8")
    cat = categoria_do_arquivo(arq.stem)
    novos = ler_kml(texto, cat, arq.name)
    fixos.extend(novos)
    print(f"{arq.name}: {len(novos)} ponto(s) fixo(s) [{cat}]")

(DADOS / "pontos_fixos.js").write_text(
    "const DADOS_PONTOS_FIXOS = " + json.dumps(fixos, ensure_ascii=False) + ";\n",
    encoding="utf-8")
print(f"Gerado {DADOS / 'pontos_fixos.js'} com {len(fixos)} ponto(s)")