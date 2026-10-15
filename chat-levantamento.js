/* Assistente de conversa do Geoportal — carregado depois do script principal (index.html),
   usa as funções e variáveis globais dele (map, camadasDesenho, registrarDesenho, ...).
   O modelo roda em /api/chat; as ferramentas abaixo executam AQUI, no mapa. */
"use strict";
(function(){

/* ================= Validação de coordenada ================= */
/* caixa do Tocantins com folga — fora dela a coordenada é recusada e a pessoa é consultada,
   em vez de plotar em silêncio um ponto no lugar errado */
const TO = {latMin:-13.6, latMax:-5.0, lngMin:-50.9, lngMax:-45.5};
const dentroTO = (lat, lng) => lat >= TO.latMin && lat <= TO.latMax && lng >= TO.lngMin && lng <= TO.lngMax;
const num = v => typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));

function resolverCoord(p){
  const temGeo = p.lat != null && p.lng != null;
  const temUtm = p.este != null && p.norte != null;
  if (temGeo){
    const lat = num(p.lat), lng = num(p.lng);
    if (isNaN(lat) || isNaN(lng)) throw new Error("lat/lng não numéricos");
    if (dentroTO(lat, lng)) return {lat, lng};
    if (dentroTO(lng, lat)) throw new Error(`lat e lng parecem trocadas (${p.lat}, ${p.lng}) — confirme com a pessoa`);
    if (dentroTO(-Math.abs(lat), -Math.abs(lng)) && (lat > 0 || lng > 0))
      throw new Error(`faltou o sinal negativo (${p.lat}, ${p.lng}) — no Tocantins lat e lng são negativas; confirme com a pessoa`);
    throw new Error(`(${p.lat}, ${p.lng}) está fora do Tocantins — confirme com a pessoa`);
  }
  if (temUtm){
    const e = num(p.este), n = num(p.norte);
    if (isNaN(e) || isNaN(n)) throw new Error("este/norte não numéricos");
    if (e > 2000000 && n < 2000000) throw new Error("este e norte parecem trocados — confirme com a pessoa");
    const zonas = p.zona ? [String(p.zona)] : ["22", "23"];
    const ok = [];
    zonas.forEach(z => {
      if (z !== "22" && z !== "23") return;
      const [lng, lat] = proj4("UTM" + z + "S", "WGS84", [e, n]);
      if (dentroTO(lat, lng)) ok.push({lat, lng, zona:z});
    });
    if (ok.length === 1) return ok[0];
    if (!ok.length) throw new Error(`UTM ${p.este} / ${p.norte}${p.zona ? " zona " + p.zona : ""} cai fora do Tocantins — confirme zona e valores com a pessoa`);
    throw new Error("UTM serve para as duas zonas — pergunte a zona (22 ou 23)");
  }
  throw new Error("faltam coordenadas (lat/lng ou este/norte)");
}

/* ================= Busca de pontos por nome ================= */
const norm = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function todosPontos(){
  const lista = [];
  Object.values(camadasDesenho).forEach(l => {
    if (l instanceof L.Marker){
      const p = l.getLatLng();
      lista.push({nome:l._nomeRTA || "(sem nome)", lat:p.lat, lng:p.lng, origem:"desenhado", id:l._idRTA});
    }
  });
  pontosFixos.forEach(p => lista.push({nome:p.nome, lat:p.lat, lng:p.lng, origem:"fixo manual", categoria:p.categoria}));
  fixosArquivo.forEach(p => lista.push({nome:p.nome, lat:p.lat, lng:p.lng, origem:"fixo", categoria:p.categoria}));
  return lista;
}
function buscarPontos(texto){
  const alvo = norm(texto);
  if (!alvo) return [];
  const todos = todosPontos();
  const exatos = todos.filter(p => norm(p.nome) === alvo);
  if (exatos.length) return exatos;
  const termos = alvo.split(/\s+/);
  return todos.filter(p => { const n = norm(p.nome); return termos.every(t => n.includes(t)); });
}
/* o mesmo lugar pode estar como ponto desenhado e como fixo: se tudo cabe em 100 m, é um só */
function distintos(lista){
  const out = [];
  lista.forEach(p => { if (!out.some(q => map.distance([p.lat, p.lng], [q.lat, q.lng]) < 100)) out.push(p); });
  return out;
}
function resolverReferencia(ref){
  if (ref && typeof ref === "object" && ref.lat == null && ref.este == null && ref.nome) ref = String(ref.nome);
  if (typeof ref === "string"){
    const achados = distintos(buscarPontos(ref));
    if (!achados.length) throw new Error(`nenhum ponto chamado “${ref}” — use buscar_ponto ou passe coordenadas`);
    if (achados.length > 1)
      throw new Error(`“${ref}” casa com vários pontos: ${achados.slice(0, 6).map(p => p.nome).join("; ")} — pergunte qual`);
    return {lat:achados[0].lat, lng:achados[0].lng, nome:achados[0].nome};
  }
  return resolverCoord(ref);
}
const corValida = c => /^#[0-9a-f]{6}$/i.test(String(c || "")) ? c : undefined;
const kmTxt = (m, casas = 2) => (m / 1000).toLocaleString("pt-BR", {minimumFractionDigits:casas, maximumFractionDigits:casas});

function acharDesenho(nome, soRota){
  const alvo = norm(nome);
  const cand = Object.values(camadasDesenho).filter(l => norm(l._nomeRTA) === alvo
    && (!soRota || (l instanceof L.Polyline && !(l instanceof L.Polygon))));
  if (!cand.length) throw new Error(`não achei ${soRota ? "rota" : "item"} chamado “${nome}” — use listar_levantamento`);
  if (cand.length > 1) throw new Error(`há ${cand.length} itens chamados “${nome}” — peça um nome mais específico`);
  return cand[0];
}
function extensaoRotaM(l){
  if (l._medidaManualRTA) return l._medidaManualRTA;
  if (l._legsRTA && l._legsRTA.length) return l._legsRTA.reduce((a, b) => a + b, 0);
  const lls = l.getLatLngs();
  return distanciaMetros(Array.isArray(lls[0]) ? lls.flat() : lls);
}

/* ================= Ferramentas ================= */
const ferramentas = {
  plotar_pontos(entrada){
    const plotados = [], erros = [], novos = [];
    (entrada.pontos || []).forEach((p, i) => {
      const nome = String(p.nome || "").trim() || "Ponto " + (Object.keys(camadasDesenho).length + 1);
      try {
        const c = resolverCoord(p);
        const layer = L.marker([c.lat, c.lng]);
        layer._corRTA = corValida(p.cor) || CORES_DESENHO[Object.keys(camadasDesenho).length % CORES_DESENHO.length];
        if (p.icone) layer._iconeRTA = String(p.icone).slice(0, 4);
        registrarDesenho(layer, nome);
        novos.push(layer);
        const u = paraUTM(c.lat, c.lng);
        plotados.push({nome, lat:+c.lat.toFixed(6), lng:+c.lng.toFixed(6),
                       utm:`${u.e.toFixed(0)} E / ${u.n.toFixed(0)} N (zona ${u.zona}S)`, digitado:p.texto_original});
      } catch (e){
        erros.push({nome, digitado:p.texto_original, erro:e.message});
      }
    });
    if (novos.length){
      salvarDesenhos();
      const b = L.latLngBounds(novos.map(l => l.getLatLng()));
      map.fitBounds(b, {padding:[70, 70], maxZoom:15});
    }
    return {plotados, nao_plotados:erros};
  },

  async tracar_rota(entrada){
    const pts = (entrada.pontos || []).map((r, i) => {
      try { return resolverReferencia(r); }
      catch (e){ throw new Error(`ponto ${i + 1}: ${e.message}`); }
    });
    if (pts.length < 2) throw new Error("a rota precisa de pelo menos 2 pontos");
    if (pts.length > 25) throw new Error("máximo de 25 pontos por rota");
    const coords = pts.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
    const resp = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`);
    const j = await resp.json();
    if (j.code !== "Ok" || !j.routes || !j.routes.length) throw new Error("o OSRM não achou caminho pela estrada entre esses pontos");
    const linha = L.geoJSON(j.routes[0].geometry).getLayers()[0];
    linha._legsRTA = (j.routes[0].legs || []).map(lg => lg.distance);
    linha._waypointsRTA = pts.map(p => [+p.lat.toFixed(6), +p.lng.toFixed(6)]);
    const cor = corValida(entrada.cor);
    if (cor) linha._corRTA = cor;
    const nome = String(entrada.nome || "").trim() || "Rota " + (Object.keys(camadasDesenho).length + 1);
    registrarDesenho(linha, nome);
    salvarDesenhos();
    map.fitBounds(linha.getBounds(), {padding:[70, 70], maxZoom:15});
    // asfalto x chão (Valhalla): espera até 25 s, depois segue em segundo plano
    const analise = analisarPavimento(linha).catch(() => null);
    await Promise.race([analise, new Promise(r => setTimeout(r, 25000))]);
    const total = extensaoRotaM(linha);
    const pav = pavEfetivo(linha);
    return {
      nome, extensao_km:kmTxt(total), media_km:kmTxt(total / 2),
      pavimentado_km: pav ? kmTxt(pav.pav) : "análise ainda em andamento",
      estrada_de_chao_km: pav ? kmTxt(pav.chao) : "análise ainda em andamento",
      aviso: "distância pelo OSRM (estrada do OpenStreetMap), igual à do botão 🛣️ Rota pela estrada",
    };
  },

  async distancia_estrada(entrada){
    const a = resolverReferencia(entrada.de), b = resolverReferencia(entrada.ate);
    const resp = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng.toFixed(6)},${a.lat.toFixed(6)};${b.lng.toFixed(6)},${b.lat.toFixed(6)}?overview=false`);
    const j = await resp.json();
    if (j.code !== "Ok" || !j.routes || !j.routes.length) throw new Error("o OSRM não achou caminho pela estrada entre esses pontos");
    const m = j.routes[0].distance;
    return {de:a.nome || "ponto A", ate:b.nome || "ponto B", km:kmTxt(m), media_km:kmTxt(m / 2)};
  },

  renomear_item(entrada){
    const l = acharDesenho(entrada.nome, false);
    const novo = String(entrada.novo_nome || "").trim();
    if (!novo) throw new Error("falta o novo nome");
    l._nomeRTA = novo;
    if (l instanceof L.Marker) aplicarRotulo(l, novo, l._iconeRTA ? [13, -18] : [10, 0]);
    salvarDesenhos();
    return {antes:entrada.nome, depois:novo};
  },

  alterar_estilo(entrada){
    const l = acharDesenho(entrada.nome, false);
    const cor = corValida(entrada.cor);
    if (entrada.cor && !cor) throw new Error("cor inválida — use #RRGGBB");
    if (cor) l._corRTA = cor;
    if (l instanceof L.Marker){
      if (entrada.icone) l._iconeRTA = String(entrada.icone).slice(0, 4);
      l.setIcon(iconeDesenho(l._corRTA, l._iconeRTA));
      aplicarRotulo(l, l._nomeRTA, l._iconeRTA ? [13, -18] : [10, 0]);
    } else if (cor && l.setStyle){
      l.setStyle({color:cor});
    }
    salvarDesenhos();
    return {ok:true, nome:l._nomeRTA, cor:l._corRTA, icone:l._iconeRTA || null};
  },

  buscar_ponto(entrada){
    const achados = distintos(buscarPontos(entrada.texto)).slice(0, 12);
    return {total:achados.length, pontos:achados.map(p => ({
      nome:p.nome, categoria:p.categoria || null, origem:p.origem, lat:+p.lat.toFixed(6), lng:+p.lng.toFixed(6)}))};
  },

  listar_levantamento(){
    const pontos = [], rotas = [], areas = [];
    Object.values(camadasDesenho).forEach(l => {
      const nome = l._nomeRTA || "(sem nome)";
      if (l instanceof L.Marker){
        const p = l.getLatLng();
        pontos.push({nome, lat:+p.lat.toFixed(6), lng:+p.lng.toFixed(6)});
      } else if (l instanceof L.Polygon){
        areas.push({nome});
      } else if (l instanceof L.Polyline){
        const t = extensaoRotaM(l), pav = pavEfetivo(l);
        rotas.push({nome, extensao_km:kmTxt(t), media_km:kmTxt(t / 2),
          chao_km: pav ? kmTxt(pav.chao) : null});
      }
    });
    return {pontos, rotas, areas};
  },

  media_rota(entrada){
    const l = acharDesenho(entrada.nome, true);
    let totalM, casas = 2;
    if (l._medidaManualRTA){ totalM = l._medidaManualRTA; casas = casasDecimais(l._medidaManualTxtRTA); }
    else if (l._pavManualRTA){
      totalM = l._pavManualRTA.pav + l._pavManualRTA.chao;
      casas = Math.max(casasDecimais(l._pavManualTxtRTA?.pav), casasDecimais(l._pavManualTxtRTA?.chao));
    } else totalM = extensaoRotaM(l);
    if (!totalM) throw new Error("a rota não tem extensão");
    const linhas = [`${(l._nomeRTA || "ROTA").toUpperCase()}: ${kmTxt(totalM, casas)}/2 = ${kmTxt(totalM / 2, casas)} KM`];
    const pav = pavEfetivo(l);
    if (pav && pav.chao > 30)
      linhas.push(`(sendo ${kmTxt(pav.chao, casasDecimais(l._pavManualTxtRTA?.chao))} km em estrada de chão e ${kmTxt(pav.pav, casasDecimais(l._pavManualTxtRTA?.pav))} km pavimentado)`);
    if (entrada.anexar_memoria){
      const atual = carregar("rta_geoportal_memoria", "");
      const novo = (atual.trim() ? atual.trimEnd() + "\n" : "") + linhas.join("\n");
      salvar("rta_geoportal_memoria", novo);
      const ta = document.getElementById("pr-memoria");
      if (ta) ta.value = novo;
    }
    return {linhas, anexado_a_memoria_de_calculo: !!entrada.anexar_memoria};
  },

  remover_item(entrada){
    const l = acharDesenho(entrada.nome, false);
    const id = l._idRTA;
    grupoDesenhos.removeLayer(l);
    delete camadasDesenho[id];
    removerChao(id);
    removerLimitesChao(l);
    if (ocultosDesenho.delete(id)) salvarOcultosDesenho();
    salvarDesenhos();
    return {removido:l._nomeRTA};
  },

  enquadrar_mapa(entrada){
    if (entrada.nome){
      const l = acharDesenho(entrada.nome, false);
      if (l.getBounds) map.fitBounds(l.getBounds(), {padding:[70, 70], maxZoom:16});
      else map.setView(l.getLatLng(), 15);
      return {ok:true};
    }
    const lim = limitesLevantamento();
    if (!lim) throw new Error("nada desenhado ainda");
    map.fitBounds(lim, {padding:[70, 70], maxZoom:16});
    return {ok:true};
  },
};

/* resumo curto de cada ação para mostrar na conversa */
function resumoAcao(nome, entrada, resultado){
  if (resultado.erro) return `⚠️ ${nome.replace(/_/g, " ")}: ${resultado.erro}`;
  switch (nome){
    case "plotar_pontos": {
      const ok = resultado.plotados.map(p => `📍 ${p.nome} (${p.lat}, ${p.lng})`);
      const ruim = resultado.nao_plotados.map(p => `⚠️ ${p.nome}: ${p.erro}`);
      return [...ok, ...ruim].join("\n");
    }
    case "tracar_rota": return `🛣️ ${resultado.nome}: ${resultado.extensao_km} km · média ${resultado.media_km} km`;
    case "media_rota": return "🧮 " + resultado.linhas.join("\n");
    case "distancia_estrada": return `📏 ${resultado.de} → ${resultado.ate}: ${resultado.km} km pela estrada`;
    case "renomear_item": return `✏️ ${resultado.antes} → ${resultado.depois}`;
    case "alterar_estilo": return `🎨 ${resultado.nome}: estilo alterado`;
    case "remover_item": return `🗑️ removido: ${resultado.removido}`;
    case "buscar_ponto": return `🔎 ${resultado.total} ponto(s) encontrado(s)`;
    case "listar_levantamento": return `📋 ${resultado.pontos.length} ponto(s), ${resultado.rotas.length} rota(s)`;
    case "enquadrar_mapa": return "🎯 mapa enquadrado";
  }
  return nome;
}

/* ================= Modo texto (sem IA, sem custo) =================
   Lê linhas digitadas/coladas e chama as mesmas ferramentas. Nada sai do navegador. */

/* um número com possível separador de milhar brasileiro: 789.012,5 -> 789012.5 */
function numeroBR(t){
  t = t.trim();
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)){
    // "789.012" é milhar só se der um valor de UTM (>= 100 mil); "-12.035" é grau decimal
    const v = parseFloat(t.replace(/\./g, "").replace(",", "."));
    if (Math.abs(v) >= 100000) return v;
  }
  return parseFloat(t.replace(",", "."));
}
const reDMS = /\d+\s*°\s*\d+\s*['′]\s*\d+(?:[.,]\d+)?\s*(?:"|″|''|”)?\s*[NSEOWL]?/gi;

/* acha a coordenada dentro de um texto: devolve {ini, fim, coord} ou null.
   coord = {lat,lng} | {este,norte,zona?}; lança Error se estiver incompleta/confusa */
function acharCoordenada(texto){
  const dms = [...texto.matchAll(reDMS)];
  if (dms.length >= 2){
    const [a, b] = dms.slice(-2);
    let la = a[0].replace(/L\s*$/i, "E"), lb = b[0].replace(/L\s*$/i, "E");
    let lat = parseCoordDMS(la), lng = parseCoordDMS(lb);
    if (/[EOLW]\s*$/i.test(a[0]) && /[NS]\s*$/i.test(b[0])) [lat, lng] = [lng, lat]; // veio "lng, lat"
    return {ini:a.index, fim:b.index + b[0].length, coord:{lat, lng}};
  }
  let zona;
  let t = texto;
  const mz = t.match(/(?:zona\s*)?\b(22|23)\s*[Ss]\b/i);
  if (mz){ zona = mz[1]; t = t.slice(0, mz.index) + " ".repeat(mz[0].length) + t.slice(mz.index + mz[0].length); }
  const nums = [...t.matchAll(/-?\d{1,3}(?:\.\d{3})+(?:,\d+)?(?!\d)|-?\d+(?:[.,]\d+)?/g)];
  if (nums.length < 2) return null;
  const [a, b] = nums.slice(-2);
  const va = numeroBR(a[0]), vb = numeroBR(b[0]);
  const ini = a.index, fim = b.index + b[0].length;
  if (Math.abs(va) >= 100000 || Math.abs(vb) >= 100000)
    return {ini, fim, coord:{este:va, norte:vb, ...(zona ? {zona} : {})}};
  return {ini, fim, coord:{lat:va, lng:vb}};
}
function nomeAntesDaCoordenada(texto, ini){
  return texto.slice(0, ini).replace(/\b(?:lat(?:itude)?|lon(?:gitude)?|coord(?:enadas?)?)\b\s*[:=]?\s*$/i, "")
              .replace(/[\s\-–—:;,|=(]+$/g, "").trim();
}
const ICONES_POR_PALAVRA = ["canteiro", "pedreira", "areial", "jazida", "usina", "cimento", "apoio"];
function iconeDoNome(nome){
  const n = norm(nome);
  const k = ICONES_POR_PALAVRA.find(p => n.includes(p));
  return k ? {icone:CATEGORIAS[k].icone, cor:CATEGORIAS[k].cor} : {};
}

const AJUDA_TEXTO =
`Escreva um ponto por linha (pode colar uma lista):
  CANTEIRO  -12,0357 -48,5452
  PEDREIRA  789012 8667000
  AREIAL  12°02'08.5"S 48°32'42.7"W

Comandos:
  rota CANTEIRO > PEDREIRA
  rota NOME DA ROTA: CANTEIRO > PEDREIRA > AREIAL
  media NOME DA ROTA   (acrescente "memoria" no fim para anexar à prancha)
  buscar TEXTO         (acha pedreiras, canteiros, cidades já cadastrados)
  listar · enquadrar · apagar NOME · ajuda

Em UTM, se souber a zona escreva 22S ou 23S. Latitude e longitude no Tocantins são negativas.`;

async function executarLinha(linha){
  const l = linha.trim();
  if (!l) return null;
  const cmd = l.match(/^(rota|media|média|buscar|listar|enquadrar|apagar|remover|ajuda)\b\s*(.*)$/i);
  if (cmd){
    const c = norm(cmd[1]), resto = cmd[2].trim();
    if (c === "ajuda") return {tipo:"ia", texto:AJUDA_TEXTO};
    if (c === "listar"){
      const r = ferramentas.listar_levantamento();
      const linhas = [
        ...r.pontos.map(p => `📍 ${p.nome} (${p.lat}, ${p.lng})`),
        ...r.rotas.map(p => `🛣️ ${p.nome}: ${p.extensao_km} km · média ${p.media_km} km` + (p.chao_km && p.chao_km !== "0,00" ? ` · chão ${p.chao_km} km` : "")),
      ];
      return {tipo:"acao", texto:linhas.length ? linhas.join("\n") : "Nada desenhado ainda."};
    }
    if (c === "enquadrar"){ ferramentas.enquadrar_mapa(resto ? {nome:resto} : {}); return {tipo:"acao", texto:"🎯 mapa enquadrado"}; }
    if (c === "apagar" || c === "remover"){
      if (!resto) throw new Error("diga o nome: apagar NOME");
      return {tipo:"acao", texto:"🗑️ removido: " + ferramentas.remover_item({nome:resto}).removido};
    }
    if (c === "buscar"){
      const r = ferramentas.buscar_ponto({texto:resto});
      return {tipo:"acao", texto: r.total
        ? r.pontos.map(p => `🔎 ${p.nome} (${p.lat}, ${p.lng})`).join("\n")
        : `Nenhum ponto com “${resto}”.`};
    }
    if (c === "media"){
      const anexar = /\bmemoria\s*$/i.test(norm(resto));
      const nome = anexar ? resto.replace(/\s*mem[oó]ria\s*$/i, "") : resto;
      const r = ferramentas.media_rota({nome, anexar_memoria:anexar});
      return {tipo:"acao", texto:"🧮 " + r.linhas.join("\n") + (anexar ? "\n(anexado à memória de cálculo da prancha)" : "")};
    }
    if (c === "rota"){
      let nome = "", lista = resto;
      const dp = resto.indexOf(":");
      if (dp > 0 && !/\d\s*:\s*\d/.test(resto)){ nome = resto.slice(0, dp).trim(); lista = resto.slice(dp + 1); }
      const itens = lista.split(/\s*(?:->|→|>|;)\s*/).map(s => s.trim()).filter(Boolean);
      if (itens.length < 2) throw new Error("use: rota A > B (ou rota NOME: A > B > C)");
      const pontos = itens.map(it => {
        const ac = acharCoordenada(it);
        return ac && nomeAntesDaCoordenada(it, ac.ini) === "" ? ac.coord : it;
      });
      if (!nome) nome = itens.length === 2 ? `${itens[0]} - ${itens[1]}` : `Rota ${Object.keys(camadasDesenho).length + 1}`;
      const r = await ferramentas.tracar_rota({nome, pontos});
      return {tipo:"acao", texto:`🛣️ ${r.nome}: ${r.extensao_km} km · média ${r.media_km} km\n` +
        `pavimentado ${r.pavimentado_km} km · chão ${r.estrada_de_chao_km} km`};
    }
  }
  // senão: linha de ponto "NOME coordenada"
  const ac = acharCoordenada(l);
  if (!ac) throw new Error(`não entendi “${l.slice(0, 60)}”. Digite “ajuda” para ver os formatos.`);
  const nome = nomeAntesDaCoordenada(l, ac.ini) || "";
  const r = ferramentas.plotar_pontos({pontos:[{nome, ...ac.coord, ...iconeDoNome(nome), texto_original:l}]});
  if (r.nao_plotados.length) throw new Error(`${nome || "ponto"}: ${r.nao_plotados[0].erro.replace(" — confirme com a pessoa", "")} — corrija e envie de novo`);
  const p = r.plotados[0];
  return {tipo:"acao", texto:`📍 ${p.nome} (${p.lat}, ${p.lng}) · ${p.utm}`};
}
async function turnoLocal(texto){
  for (const linha of texto.split(/\r?\n/)){
    try {
      const r = await executarLinha(linha);
      if (r) adicionar(r.tipo, r.texto);
    } catch (e){ adicionar("erro", "⚠️ " + e.message); }
  }
}

/* ================= Conversa ================= */
const CHAVE_CODIGO = "rta_chat_codigo";
let historico = [];     // formato Gemini: {role:"user"|"model", parts:[...]}
let modoIA = carregar("rta_chat_modo", "ia") !== "texto";
let ocupado = false;

const css = document.createElement("style");
css.textContent = `
.chat-m.dica{white-space:pre-wrap; font-family:Consolas,monospace;}
#chat-btn{position:fixed; right:16px; bottom:34px; z-index:1500; border:none; border-radius:28px;
  background:#1E3A72; color:#fff; font:600 14px 'Segoe UI',system-ui,sans-serif; padding:12px 18px;
  cursor:pointer; box-shadow:0 3px 12px rgba(0,0,0,.35);}
#chat-btn:hover{background:#2a4f99;}
#chat-painel{position:fixed; right:16px; bottom:34px; z-index:1600; width:min(390px, calc(100vw - 24px));
  height:min(560px, calc(100vh - 80px)); background:#fff; border-radius:12px; display:none; flex-direction:column;
  box-shadow:0 6px 24px rgba(0,0,0,.4); font:13px 'Segoe UI',system-ui,sans-serif; color:#0f172a; overflow:hidden;}
#chat-painel.aberto{display:flex;}
#chat-topo{background:#1E3A72; color:#fff; padding:10px 12px; display:flex; align-items:center; gap:8px; font-weight:600;}
#chat-topo span{flex:1;}
#chat-topo button{background:none; border:none; color:#fff; cursor:pointer; font-size:13px; padding:2px 6px; opacity:.85;}
#chat-topo button:hover{opacity:1;}
#chat-msgs{flex:1; overflow-y:auto; padding:10px; display:flex; flex-direction:column; gap:8px; background:#f1f5f9;}
.chat-m{max-width:88%; padding:8px 11px; border-radius:10px; line-height:1.45; white-space:pre-wrap; word-wrap:break-word;}
.chat-m.eu{align-self:flex-end; background:#1E3A72; color:#fff; border-bottom-right-radius:3px;}
.chat-m.ia{align-self:flex-start; background:#fff; border:1px solid #e2e8f0; border-bottom-left-radius:3px;}
.chat-m.acao{align-self:flex-start; background:#e0f2fe; border:1px solid #bae6fd; font-size:12px; max-width:96%;}
.chat-m.erro{align-self:center; background:#fee2e2; border:1px solid #fecaca; color:#7f1d1d; font-size:12px;}
.chat-m.dica{align-self:stretch; background:transparent; color:#475569; font-size:12px; padding:2px;}
#chat-form{display:flex; gap:6px; padding:8px; border-top:1px solid #e2e8f0; background:#fff;}
#chat-entrada{flex:1; resize:none; border:1px solid #cbd5e1; border-radius:8px; padding:8px; font:inherit; max-height:110px;}
#chat-enviar{border:none; background:#1E3A72; color:#fff; border-radius:8px; padding:0 14px; cursor:pointer; font-weight:600;}
#chat-enviar:disabled{opacity:.5; cursor:wait;}
`;
document.head.appendChild(css);

const btn = document.createElement("button");
btn.id = "chat-btn"; btn.textContent = "💬 Montar por conversa";
btn.title = "Digitar ou colar coordenadas e comandos para montar o mapa (pontos, rotas, média)";
const painel = document.createElement("div");
painel.id = "chat-painel";
painel.innerHTML = `
  <div id="chat-topo"><span>💬 Montar o mapa</span>
    <button id="chat-modo" title="Alternar entre conversa livre (IA) e comandos de texto"></button>
    <button id="chat-novo" title="Começar uma conversa nova">🗑️ Nova</button>
    <button id="chat-fechar" title="Fechar">✖</button></div>
  <div id="chat-msgs"></div>
  <form id="chat-form"><textarea id="chat-entrada" rows="2" placeholder="CANTEIRO  -12,0357 -48,5452&#10;rota CANTEIRO > PEDREIRA   (ou: ajuda)"></textarea>
    <button id="chat-enviar" type="submit">Enviar</button></form>`;
document.body.appendChild(btn);
document.body.appendChild(painel);
L.DomEvent.disableClickPropagation(painel);
L.DomEvent.disableScrollPropagation(painel);
const msgs = painel.querySelector("#chat-msgs");
const entrada = painel.querySelector("#chat-entrada");
const enviar = painel.querySelector("#chat-enviar");

function adicionar(classe, texto){
  const d = document.createElement("div");
  d.className = "chat-m " + classe;
  d.textContent = texto;
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
  return d;
}
function recomecar(){
  historico = [];
  msgs.innerHTML = "";
  painel.querySelector("#chat-modo").textContent = modoIA ? "🤖 IA" : "⌨️ Texto";
  adicionar("dica", modoIA
    ? "Converse normalmente: diga os pontos (graus decimais, graus/min/seg ou UTM) e peça rotas, médias, nomes, cores...\n" +
      "Ex.: marca o canteiro em -12,0357 / -48,5452 e traça a rota até a pedreira de Porto Nacional.\n\n" +
      "Se a IA falhar, uso o modo texto (digite “ajuda” no ⌨️ Texto)."
    : AJUDA_TEXTO);
}
function abrir(){ painel.classList.add("aberto"); btn.style.display = "none"; entrada.focus(); }
function fechar(){ painel.classList.remove("aberto"); btn.style.display = ""; }
btn.addEventListener("click", abrir);
painel.querySelector("#chat-fechar").addEventListener("click", fechar);
painel.querySelector("#chat-novo").addEventListener("click", () => { if (!ocupado) recomecar(); });
painel.querySelector("#chat-modo").addEventListener("click", () => {
  if (ocupado) return;
  modoIA = !modoIA;
  salvar("rta_chat_modo", modoIA ? "ia" : "texto");
  recomecar();
});
entrada.addEventListener("keydown", ev => {
  if (ev.key === "Enter" && !ev.shiftKey){ ev.preventDefault(); painel.querySelector("#chat-form").requestSubmit(); }
});

async function chamarServidor(){
  const cod = carregar(CHAVE_CODIGO, "");
  const r = await fetch("/api/chat", {
    method:"POST",
    headers:{"content-type":"application/json", ...(cod ? {"x-chat-codigo":cod} : {})},
    body:JSON.stringify({contents:historico}),
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (r.status === 401) { const e = new Error("codigo"); e.codigo = true; throw e; }
  if (!r.ok) throw new Error(j.erro || "Erro " + r.status);
  return j;
}

/* pede o código de acesso na própria conversa (sem prompt() nativo) */
function pedirCodigo(){
  return new Promise(resolve => {
    adicionar("erro", "Digite o código de acesso do assistente e envie.");
    const antigo = entrada.placeholder;
    entrada.placeholder = "código de acesso";
    const ouvir = ev => {
      ev.preventDefault();
      const v = entrada.value.trim();
      if (!v) return;
      salvar(CHAVE_CODIGO, v);
      entrada.value = ""; entrada.placeholder = antigo;
      painel.querySelector("#chat-form").removeEventListener("submit", ouvir, true);
      resolve();
    };
    painel.querySelector("#chat-form").addEventListener("submit", ouvir, true);
  });
}

async function turno(texto){
  const inicio = historico.length;
  historico.push({role:"user", parts:[{text:texto}]});
  for (let volta = 0; volta < 8; volta++){
    let resp;
    try { resp = await chamarServidor(); }
    catch (e){
      if (e.codigo){ await pedirCodigo(); volta--; continue; }
      historico.length = inicio; // descarta o turno incompleto (functionCall sem resposta invalidaria a próxima chamada)
      adicionar("erro", e.message);
      if (volta === 0){ // nada foi executado ainda: dá para tentar o modo texto sem duplicar nada
        adicionar("dica", "Tentando entender como comando de texto…");
        await turnoLocal(texto);
      }
      return;
    }
    historico.push({role:"model", parts:resp.parts});
    // "thought" são pensamentos internos do modelo: não mostrar
    resp.parts.filter(p => p.text && !p.thought && p.text.trim()).forEach(p => adicionar("ia", p.text.trim()));
    const usos = resp.parts.filter(p => p.functionCall);
    if (!usos.length){
      if (!resp.parts.some(p => p.text && !p.thought && p.text.trim())) adicionar("ia", "(sem resposta — reformule)");
      return;
    }
    const respostas = [];
    for (const u of usos){
      const {name, args} = u.functionCall;
      let saida, ehErro = false;
      try {
        const f = ferramentas[name];
        if (!f) throw new Error("ferramenta desconhecida");
        saida = await f(args || {});
      } catch (e){ saida = {erro:e.message}; ehErro = true; }
      adicionar(ehErro ? "erro" : "acao", resumoAcao(name, args, saida));
      respostas.push({functionResponse:{name, response:saida}});
    }
    historico.push({role:"user", parts:respostas});
  }
  adicionar("erro", "Parei por segurança depois de muitas etapas seguidas. Diga o que falta.");
}

painel.querySelector("#chat-form").addEventListener("submit", async ev => {
  ev.preventDefault();
  if (ocupado) return;
  const texto = entrada.value.trim();
  if (!texto) return;
  entrada.value = "";
  ocupado = true; enviar.disabled = true;
  adicionar("eu", texto);
  const pensando = adicionar("dica", "…");
  try { await (modoIA ? turno(texto) : turnoLocal(texto)); }
  finally {
    pensando.remove();
    ocupado = false; enviar.disabled = false; entrada.focus();
    if (historico.length > 50){ adicionar("dica", "Conversa longa: clique em 🗑️ Nova para recomeçar (o mapa continua como está)."); }
  }
});

recomecar();
window.__chatFerramentas = ferramentas; // para teste no console
})();
