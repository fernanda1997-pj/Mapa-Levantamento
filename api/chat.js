/* Assistente do Geoportal — função serverless do Vercel (Google Gemini, plano gratuito).
   O navegador manda a conversa; aqui ela é repassada ao Gemini junto com as ferramentas
   do mapa. As ferramentas NÃO rodam aqui: o modelo só pede (functionCall) e o navegador
   executa no mapa, devolvendo o resultado (functionResponse) na rodada seguinte.

   Variáveis de ambiente (Vercel > Settings > Environment Variables):
     GEMINI_API_KEY  (obrigatória) chave grátis de https://aistudio.google.com/apikey
     CHAT_CODIGO     (recomendada) código de acesso da equipe, para ninguém de fora gastar a cota
     CHAT_MODEL      (opcional) padrão gemini-flash-latest (alias do Flash mais recente) */

const MODELO = process.env.CHAT_MODEL || "gemini-flash-latest";
const MAX_MENSAGENS = 60;
const MAX_BYTES = 80 * 1024;

const SISTEMA = `Você é o assistente do Geoportal RTA-MSI (levantamento de trechos rodoviários no Tocantins). \
A pessoa conversa com você e o mapa é montado pelas suas ferramentas. Responda sempre em português do Brasil, curto e direto.

REGRAS DE COORDENADA (o mapa vai para relatório e orçamento; ponto no lugar errado custa caro):
- Nunca invente nem "arredonde" coordenada. Passe os números exatamente como a pessoa escreveu (vírgula decimal vira ponto).
- Graus decimais: lat e lng com sinal (Tocantins: lat entre -13,5 e -5,1; lng entre -50,8 e -45,6). \
Se a pessoa escreveu graus/minutos/segundos, converta com cuidado (sul e oeste = negativo) e mostre a conversão.
- UTM (SIRGAS 2000): passe este e norte; informe a zona (22 ou 23) só se a pessoa disse; senão deixe em branco que o mapa descobre.
- Se a ferramenta devolver erro de coordenada (fora do Tocantins, sinal faltando, lat/lng trocadas), NÃO tente corrigir sozinho: \
explique o que parece errado e pergunte.
- Se a coordenada estiver ambígua (ex.: só dois números sem dizer se é lat/lng ou UTM), pergunte antes de plotar.
- Preencha texto_original com o trecho exato que a pessoa digitou para aquele ponto.

COMO TRABALHAR:
- Plote vários pontos de uma vez (plotar_pontos). Dê nome curto e claro; se a pessoa não deu nome, use "Ponto N".
- Para rota: tracar_rota com os nomes de pontos que já existem (desenhados ou fixos, como canteiro/pedreira/cidade) ou coordenadas. \
A rota segue a estrada pelo OSRM. Se um nome casar com vários pontos, pergunte qual.
- "Média" da rota = extensão ÷ 2 (DMT ao meio). Use media_rota; não calcule de cabeça.
- Distância entre dois pontos sem desenhar rota: distancia_estrada.
- Antes de afirmar distância, KM ou o que existe no mapa, consulte as ferramentas (listar_levantamento, buscar_ponto). Não chute.
- Depois de montar algo, diga em uma ou duas linhas o que foi feito (nome, coordenada plotada, extensão). Sem enrolação.
- Você NÃO gera a prancha PNG nem baixa KML: se pedirem, diga qual botão usar (📐 Prancha / ⬇️ Baixar levantamento).
- Se não souber ou a ferramenta falhar, diga isso. Não invente resultado.`;

const PONTO_REF = {
  type: "OBJECT",
  description: "Um ponto: informe só o nome de um ponto já existente (desenhado ou fixo) OU lat e lng.",
  properties: {
    nome: { type: "STRING", description: "nome de ponto existente" },
    lat: { type: "NUMBER" },
    lng: { type: "NUMBER" },
  },
};

const FERRAMENTAS = [{
  functionDeclarations: [
    {
      name: "plotar_pontos",
      description: "Cria um ou mais pontos no levantamento a partir de coordenadas. Cada ponto usa lat/lng (graus decimais) OU este/norte (UTM).",
      parameters: {
        type: "OBJECT",
        properties: {
          pontos: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                nome: { type: "STRING" },
                lat: { type: "NUMBER", description: "graus decimais, negativo no Tocantins" },
                lng: { type: "NUMBER", description: "graus decimais, negativo no Tocantins" },
                este: { type: "NUMBER", description: "UTM leste (m)" },
                norte: { type: "NUMBER", description: "UTM norte (m)" },
                zona: { type: "STRING", description: "22 ou 23, só se a pessoa informou" },
                icone: { type: "STRING", description: "emoji opcional (⛺ canteiro, 🪨 pedreira, 🚜 areial, 🚧 obra)" },
                cor: { type: "STRING", description: "cor #RRGGBB opcional" },
                texto_original: { type: "STRING", description: "como a pessoa escreveu a coordenada" },
              },
              required: ["nome", "texto_original"],
            },
          },
        },
        required: ["pontos"],
      },
    },
    {
      name: "tracar_rota",
      description: "Traça uma rota pela estrada (OSRM) passando pelos pontos, na ordem. Calcula extensão e analisa asfalto x chão.",
      parameters: {
        type: "OBJECT",
        properties: {
          nome: { type: "STRING" },
          pontos: { type: "ARRAY", items: PONTO_REF, description: "mínimo 2 pontos, na ordem do percurso" },
          cor: { type: "STRING", description: "cor #RRGGBB opcional" },
        },
        required: ["nome", "pontos"],
      },
    },
    {
      name: "distancia_estrada",
      description: "Distância pela estrada entre dois pontos, sem desenhar nada no mapa.",
      parameters: {
        type: "OBJECT",
        properties: { de: PONTO_REF, ate: PONTO_REF },
        required: ["de", "ate"],
      },
    },
    {
      name: "buscar_ponto",
      description: "Procura pontos pelo nome entre os desenhados e os fixos (pedreiras, canteiros, cimento, cidades...). Devolve nome, categoria e coordenada.",
      parameters: { type: "OBJECT", properties: { texto: { type: "STRING" } }, required: ["texto"] },
    },
    {
      name: "listar_levantamento",
      description: "Lista tudo que já foi desenhado: pontos (com coordenada) e rotas (extensão, média, pavimento).",
    },
    {
      name: "media_rota",
      description: "Devolve a linha da memória de cálculo da rota (extensão ÷ 2) no formato padrão. Opcionalmente anexa à memória de cálculo da prancha.",
      parameters: {
        type: "OBJECT",
        properties: { nome: { type: "STRING" }, anexar_memoria: { type: "BOOLEAN" } },
        required: ["nome"],
      },
    },
    {
      name: "renomear_item",
      description: "Renomeia um ponto ou rota desenhado.",
      parameters: {
        type: "OBJECT",
        properties: { nome: { type: "STRING", description: "nome atual" }, novo_nome: { type: "STRING" } },
        required: ["nome", "novo_nome"],
      },
    },
    {
      name: "alterar_estilo",
      description: "Troca a cor e/ou o ícone (emoji, só para pontos) de um item desenhado.",
      parameters: {
        type: "OBJECT",
        properties: { nome: { type: "STRING" }, cor: { type: "STRING", description: "#RRGGBB" }, icone: { type: "STRING", description: "emoji" } },
        required: ["nome"],
      },
    },
    {
      name: "remover_item",
      description: "Exclui um ponto ou rota desenhado pelo nome exato. Só use se a pessoa pediu para apagar.",
      parameters: { type: "OBJECT", properties: { nome: { type: "STRING" } }, required: ["nome"] },
    },
    {
      name: "enquadrar_mapa",
      description: "Ajusta o zoom para mostrar tudo que foi desenhado, ou um item específico se nome for informado.",
      parameters: { type: "OBJECT", properties: { nome: { type: "STRING" } } },
    },
  ],
}];

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let bytes = 0, partes = [];
    req.on("data", c => {
      bytes += c.length;
      if (bytes > MAX_BYTES) { reject(new Error("grande")); req.destroy(); return; }
      partes.push(c);
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(partes).toString("utf8"))); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ erro: "Use POST." }); return; }
  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({ erro: "O assistente ainda não foi configurado (falta GEMINI_API_KEY no Vercel)." });
    return;
  }
  const codigo = process.env.CHAT_CODIGO;
  if (codigo && req.headers["x-chat-codigo"] !== codigo) {
    res.status(401).json({ erro: "Código de acesso inválido." });
    return;
  }
  let corpo;
  try { corpo = await lerCorpo(req); }
  catch { res.status(400).json({ erro: "Requisição inválida ou grande demais." }); return; }
  const contents = corpo && corpo.contents;
  if (!Array.isArray(contents) || !contents.length || contents.length > MAX_MENSAGENS ||
      JSON.stringify(contents).length > MAX_BYTES) {
    res.status(400).json({ erro: "Conversa inválida ou longa demais — comece uma nova." });
    return;
  }
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODELO)}:generateContent`;
    const chamar = comPensamento0 => fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SISTEMA }] },
        contents,
        tools: FERRAMENTAS,
        // sem "pensamento" interno: o pedido é simples (ferramenta + coordenada) e isso é o que mais atrasa
        generationConfig: { temperature: 0.2, maxOutputTokens: 1500,
                            ...(comPensamento0 ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
      }),
    });
    let r = await chamar(true);
    let j = await r.json().catch(() => ({}));
    if (r.status === 400 && /think/i.test(JSON.stringify(j))) { // este modelo não aceita desligar: repete sem
      r = await chamar(false);
      j = await r.json().catch(() => ({}));
    }
    if (r.status === 500 || r.status === 503) { // modelo sobrecarregado: uma nova tentativa
      await new Promise(ok => setTimeout(ok, 1500));
      r = await chamar(true);
      j = await r.json().catch(() => ({}));
    }
    if (!r.ok) {
      console.error("gemini", r.status, JSON.stringify(j).slice(0, 500));
      if (r.status === 429) {
        res.status(429).json({ erro: "Acabou a cota gratuita do assistente por agora (limite por minuto ou por dia). Tente em alguns minutos." });
      } else if (r.status === 400 || r.status === 401 || r.status === 403) {
        const m = (j.error && j.error.message) || "";
        res.status(502).json({ erro: "O Google recusou o pedido: " + m.slice(0, 200) });
      } else if (r.status === 404) {
        res.status(502).json({ erro: `Modelo “${MODELO}” não existe; ajuste CHAT_MODEL no Vercel.` });
      } else {
        // mostra o motivo real do Google (a mensagem dele não contém a chave)
        const m = (j.error && j.error.message) || "";
        res.status(502).json({ erro: `O assistente não respondeu (Google HTTP ${r.status}${m ? ": " + m.slice(0, 220) : ""}).` });
      }
      return;
    }
    const cand = j.candidates && j.candidates[0];
    if (!cand || !cand.content || !Array.isArray(cand.content.parts)) {
      const motivo = (j.promptFeedback && j.promptFeedback.blockReason) || (cand && cand.finishReason) || "sem resposta";
      res.status(502).json({ erro: "O assistente não gerou resposta (" + motivo + "). Reformule o pedido." });
      return;
    }
    // devolve as partes exatamente como vieram (inclui thoughtSignature, que o Gemini exige na volta)
    res.status(200).json({ parts: cand.content.parts, finishReason: cand.finishReason });
  } catch (e) {
    console.error("chat", e);
    res.status(502).json({ erro: "Falha ao falar com o assistente." });
  }
};
