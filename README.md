# Geoportal RTA — Levantamento de Trechos Rodoviários

WebGIS interativo para apoiar o levantamento de trechos rodoviários no Tocantins.
Abra o **`index.html`** com duplo clique (precisa de internet para os mapas de fundo).

## O que ele faz

- **Regiões de trabalho** (R1, R2, R3, R11, R12, R13) carregadas dos shapefiles,
  com liga/desliga e zoom por região.
- **Pontos fixos de arquivo** — as **59 pedreiras** do `PEDREIRAS.kmz` já vêm
  carregadas (🪨), com liga/desliga e lista alfabética que voa até o ponto.
- **Pontos fixos manuais** (cimento, canteiro de obras, jazida, usina, apoio…):
  cadastre pelo botão *➕ Adicionar ponto fixo* — clicando no mapa, ou digitando
  coordenadas em **Lat/Lon** ou **UTM SIRGAS 2000** (zonas 22S/23S).
  Dá para arrastar o marcador para ajustar a posição.
- **Levantamento**: barra de ferramentas no canto esquerdo do mapa para desenhar
  **pontos**, **rotas** (com extensão em km) e **áreas** (com hectares).
  Ferramentas de edição, arrastar e apagar na mesma barra.
- **Mapas de fundo**: Padrão (OSM) · Satélite (Esri) · Escuro (Carto).
- **GPS** (🛰️): centraliza na sua posição — útil em campo no celular.
- Coordenadas do cursor em Lat/Lon + UTM no canto inferior direito.

## Salvamento e troca de dados

Tudo o que você cria é **salvo automaticamente no navegador** (localStorage).
Para levar para outro computador ou para o ArcGIS/QGIS/Google Earth:

- **Exportar GeoJSON** — reabre no ArcGIS/QGIS e pode ser **reimportado** aqui.
- **Exportar KML** — abre no Google Earth.
- **Importar** — lê um GeoJSON exportado por este geoportal (WGS84).

> ⚠️ Os dados ficam no navegador usado. Se limpar o histórico/cache do navegador,
> eles somem — exporte um GeoJSON de backup de vez em quando.

## Estrutura

| Caminho | Descrição |
|---|---|
| `index.html` | O geoportal (página única, abre direto do disco) |
| `tutorial.html` + `tutorial-img/` | Tutorial interativo em slides |
| `camadas/` | Shapefiles de origem das regiões e cidades |
| `dados/` | `regioes.js`/`.geojson`, `pontos_fixos.js`, `rotas.js` — gerados, não editar à mão |
| `converter_camadas.py` | Regenera `dados/` a partir de `camadas/` e dos KMZ/KML de `fontes/` |
| `fontes/` | KMZ/KML brutos de pontos fixos e o `.mxd` de origem — fora do site (`.vercelignore`) |
| `logo/` | Logos RTA e MSI |
| `manual/` | Tutorial em `.docx`/`.pdf` (fora do git, uso local) |

## Atualizar as regiões ou os pontos fixos de arquivo

Coloque novos `.kmz`/`.kml` de pontos fixos em `fontes/` (qualquer subpasta) e rode:

```bash
python converter_camadas.py
```

A categoria é deduzida do nome do arquivo: `PEDREIRA*` → pedreira,
`CIMENTO*` → cimento, `CANTEIRO*` → canteiro, `JAZIDA*`, `USINA*`, `APOIO*`.
O mesmo comando também reconverte os shapefiles de `camadas/`.
Requisitos: Python com `geopandas` (o mesmo ambiente do projeto `web`).
