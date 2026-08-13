# Geoportal RTA-MSI — Levantamento de Trechos Rodoviários

WebGIS de página única (Leaflet) para levantamentos de serviço de rodovias no Tocantins.
Usuária: Fernanda (RTA Engenheiros Consultores). Responder sempre em português.

- **Site**: https://mapa-levantamento.vercel.app (deploy automático: push na `main` → Vercel)
- **Repo**: https://github.com/fernanda1997-pj/Mapa-Levantamento.git
- **Tutorial**: /tutorial.html (slides interativos) + `Tutorial - Geoportal RTA-MSI.docx/.pdf` (fora do git)

## Arquitetura

| Arquivo | Papel |
|---|---|
| `index.html` | O app inteiro (HTML+CSS+JS, sem build). CDN: Leaflet 1.9.4, Geoman 2.18.3, proj4, html-to-image e JSZip sob demanda |
| `converter_camadas.py` | Regenera `dados/` a partir de `camadas/` (shapefiles) e dos KMZ/KML de `fontes/` (geopandas) |
| `dados/regioes.js` | 6 regiões (R1,R2,R3,R11,R12,R13) — só shapefiles `R<num>_REGIÃO` entram |
| `dados/pontos_fixos.js` | Pontos fixos de arquivo: pedreiras/areais/canteiros/cimento + 150 cidades IBGE (BC250, TIP_LOCALI 6 e 8) |
| `dados/trechos.js` | Trechos de rodovia (fontes/TRECHOS/R\<num>_TRECHOS.shp), agrupados por "Id" — aparecem em 📌 Pontos fixos, logo depois de Cidades |
| `fontes/` | KMZ/KML brutos de pontos fixos (PEDREIRAS, lotes por região), shapefiles de TRECHOS e o `.mxd` de origem — não vai ao ar (`fontes/` inteira no `.vercelignore`) |
| `manual/` | Tutorial em `.docx`/`.pdf` (fora do git, uso local) |
| `tutorial.html` + `tutorial-img/` | Slides interativos com prints reais (gerados por scripts no scratchpad da sessão original) |
| `.vercelignore` | Só o site vai ao ar; shapefiles/KMZ/scripts ficam fora |

## Convenções que a usuária definiu (NÃO mudar sem pedir)

- **"Média" de uma rota = extensão ÷ 2** (DMT ao meio). Formato exato na memória de cálculo: `NOME-DA-ROTA: 34,94/2 = 17,47 KM` (maiúsculas, vírgula decimal, 2 casas)
- Formato de coordenadas: `NOME (-12.035742°, -48.545167°) - KM 12,26`
- Ícones: areial 🚜, canteiro ⛺ (escolhidos por ela); pedreira 🪨, cimento 🏭, usina 🛢️, cidade 🏙️
- Rotas de LineString dos KMZ da pasta NÃO viram camada fixa (`IMPORTAR_ROTAS=False` no converter)
- Downloads do levantamento em **KML** (equipe guarda na pasta pessoal e reabre depois)

## Decisões técnicas importantes (aprendidas a duro custo)

- **Geoman em modo opt-in** (`L.PM.setOptIn(true)` logo após criar o map): só desenhos ≤400 vértices ganham `pm` (via `reInitLayer` no `registrarDesenho`). Sem isso, o modo de edição criava ~17k marcadores (regiões + rotas OSRM densas) e congelava o Chrome
- **Nada de `prompt()/confirm()/alert()`** — usar `dialogoNome/dialogoConfirmar/aviso` (diálogos próprios)
- Roteamento: OSRM público (`router.project-osrm.org`) — `/route` para rotas, `/table?annotations=distance` para os KM da prancha. Pavimento (asfalto × chão): Valhalla `trace_attributes` (`valhalla1.openstreetmap.de`); chão = compacted/dirt/gravel/path/impassable; trechos de chão viram overlay tracejado marrom `#7C4A03`
- Rotas pela estrada salvam pernas (`_legsRTA`), waypoints clicados (`_waypointsRTA`) e pavimento (`_pavRTA {pav, chao, segs}`) — persistidos nas properties do GeoJSON/localStorage e no KML exportado (ExtendedData `Data name="geoportal"` com JSON)
- Dados do usuário ficam em localStorage (chaves `rta_geoportal_*`); camadas de arquivo vêm dos `dados/*.js` (funciona em file:// e via HTTP)
- UTM: SIRGAS 2000, zona 22S se lng < -48, senão 23S
- Encoding dos shapefiles: UTF-8 (o console do Windows mostra mojibake, mas os dados estão certos)

## Fluxos de trabalho

- **Dados novos** (KMZ de pontos em `fontes/`, shapefile em `camadas/`): colocar na pasta → `python converter_camadas.py` → commit + push. Categoria dos pontos deduzida por regex no nome do placemark (`\bPEDR`, `\bCIMENTO`, `\bCAL\b`, `\bCANTEIRO`, `\bAREI?AL\b`, `\bUSINA`, `\bAPOIO\b`, `\bJAZIDA`), com fallback no nome do arquivo; sem categoria = ignorado; duplicatas entre arquivos (<250 m, mesma categoria) descartadas
- **Trechos** (`fontes/TRECHOS/R<num>_TRECHOS.shp`): requer `dbfread` (`pip install dbfread`) além do geopandas — os nomes de coluna (TRECHO/TRECHOS, EXTENSÃO/EXT_REAL/...) mudam de região pra região, por isso o converter busca por prefixo. Encoding do .dbf é UTF-8 mesmo — ler geometria com geopandas e atributos (nomes) com `dbfread` **separadamente**; lendo os dois juntos pelo geopandas/pyogrio, os acentos saem embananados (ex.: "AUGUSTINÓPOLIS" virava "AUGUSTINÃ“POLIS") mesmo especificando o encoding certo — bug de alguma camada do GDAL/pyogrio, não do arquivo
- **Testar local**: servidor `python -m http.server 8765 --directory .` (há config "geoportal" no `.claude/launch.json` do projeto `web` vizinho)
- **Deploy**: `git add -A && git commit && git push` — conferir com `curl https://mapa-levantamento.vercel.app/ | grep <marcador>`
- A usuária confirma cada mudança visual; testar no preview antes de publicar

## Relação com outros projetos

- `C:\1. Projetos\RTA\web` = OUTRO projeto (mapa Folium das rodovias, repo RTS-MSI_RODOVIAS, site rta-msi-rodovias.vercel.app). A usuária NÃO quis o geoportal dentro dele
- Este projeto nasceu da pasta `web - Mapas`; manuais (.docx/.pdf) ficam na pasta mas fora do git (.gitignore)
