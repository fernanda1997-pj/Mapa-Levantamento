/* Assistente do Geoportal — função serverless do Vercel.
   O navegador manda a conversa; aqui ela é repassada à API da Anthropic junto com as
   ferramentas do mapa. As ferramentas NÃO rodam aqui: o modelo só pede (tool_use) e o
   navegador executa no mapa, devolvendo o resultado na rodada seguinte.

   Variáveis de ambiente (Vercel > Settings > Environment Variables):
     ANTHROPIC_API_KEY  (obrigatória) chave da API
     CHAT_CODIGO        (recomendada) código de acesso da equipe; sem ele qualquer um
                        que abra o site gasta a sua chave
     CHAT_MODEL         (opcional) padrão claude-haiku-5-5 */

const MODELO = process.env.CHAT_MODEL || "claude-haiku-5-5";
const MAX_MENSAGENS = 60;
const MAX_BYTES = 80 * 1024;

const SISTEMA = `Você é o assistente do Geoportal RTA-MSI (levantamento de trechos rodoviários no Tocantins). \
A pessoa conversa com você e o mapa é montado por suas ferramentas. Responda sempre em português do Brasil, curto e direto.

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
- Para rota: use tracar_rota com os nomes de pontos que já existem (desenhados ou fixos, como canteiro/pedreira/cidade) ou coordenadas. \
A rota segue a estrada pelo OSRM. Se um nome casar com vários pontos, pergunte qual.
- "Média" da rota = extensão ÷ 2 (DMT ao meio). Use media_rota; não calcule de cabeça.
- Antes de afirmar distância, KM ou o que existe no mapa, consulte as ferramentas (listar_levantamento, buscar_ponto). Não chute.
- Depois de montar algo, diga em uma ou duas linhas o que foi feito (nome, coordenada plotada, extensão). Sem enrolação.
- Você NÃO gera a prancha PNG nem baixa KML: se pedirem, diga qual botão usar (📐 Prancha / ⬇️ Baixar levantamento).
- Se não souber ou a ferramenta falhar, diga isso. Não invente resultado.`;

const FERRAMENTAS = [
  {
    name: "plotar_pontos",
    description: "Cria um ou mais pontos no levantamento a partir de coordenadas. Cada ponto usa lat/lng (graus decimais) OU este/norte (UTM).",
    input_schema: {
      type: "object",
      properties: {
        pontos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              nome: { type: "string" },
              lat: { type: "number", description: "graus decimais, negativo no Tocantins" },
              lng: { type: "number", description: "graus decimais, negativo no Tocantins" },
              este: { type: "number", description: "UTM leste (m)" },
              norte: { type: "number", description: "UTM norte (m)" },
              zona: { type: "string", enum: ["22", "23"], description: "zona UTM sul, só se informada" },
              icone: { type: "string", description: "emoji opcional (ex.: ⛺ canteiro, 🪨 pedreira, 🚜 areial, 🚧 obra)" },
              cor: { type: "string", description: "cor #RRGGBB opcional" },
              texto_original: { type: "string", description: "como a pessoa escreveu a coordenada" },
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
    description: "Traça uma rota pela estrada (OSRM) passando pelos pontos, na ordem. Cada ponto é o NOME de um ponto existente (desenhado ou fixo) ou um objeto com lat/lng. Calcula extensão e analisa asfalto x chão.",
    input_schema: {
      type: "object",
      properties: {
        nome: { type: "string" },
        pontos: {
          type: "array",
          minItems: 2,
          items: {
            anyOf: [
              { type: "string", description: "nome de ponto existente" },
              { type: "object", properties: { lat: { type: "number" }, lng: { type: "number" } }, required: ["lat", "lng"] },
            ],
          },
        },
        cor: { type: "string", description: "cor #RRGGBB opcional" },
      },
      required: ["nome", "pontos"],
    },
  },
  {
    name: "buscar_ponto",
    description: "Procura pontos pelo nome entre os desenhados e os fixos (pedreiras, canteiros, cimento, cidades...). Devolve nome, categoria e coordenada.",
    input_schema: { type: "object", properties: { texto: { type: "string" } }, required: ["texto"] },
  },
  {
    name: "listar_levantamento",
    description: "Lista tudo que já foi desenhado: pontos (com coordenada) e rotas (extensão, média, pavimento).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "media_rota",
    description: "Devolve a linha da memória de cálculo da rota (extensão ÷ 2) no formato padrão. Opcionalmente anexa à memória de cálculo da prancha.",
    input_schema: {
      type: "object",
      properties: { nome: { type: "string" }, anexar_memoria: { type: "boolean" } },
      required: ["nome"],
    },
  },
  {
    name: "remover_item",
    description: "Exclui um ponto ou rota desenhado pelo nome exato. Só use se a pessoa pediu para apagar.",
    input_schema: { type: "object", properties: { nome: { type: "string" } }, required: ["nome"] },
  },
  {
    name: "enquadrar_mapa",
    description: "Ajusta o zoom do mapa para mostrar tudo que foi desenhado, ou um item específico se nome for informado.",
    input_schema: { type: "object", properties: { nome: { type: "string" } } },
  },
];

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
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ erro: "O assistente ainda não foi configurado (falta ANTHROPIC_API_KEY no Vercel)." });
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
  const mensagens = corpo && corpo.messages;
  if (!Array.isArray(mensagens) || !mensagens.length || mensagens.length > MAX_MENSAGENS ||
      JSON.stringify(mensagens).length > MAX_BYTES) {
    res.status(400).json({ erro: "Conversa inválida ou longa demais — comece uma nova." });
    return;
  }
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 1500,
        system: SISTEMA,
        tools: FERRAMENTAS,
        messages: mensagens,
      }),
    });
    const j = await r.json();
    if (!r.ok) {
      console.error("anthropic", r.status, JSON.stringify(j).slice(0, 400));
      res.status(502).json({ erro: "O assistente não respondeu agora. Tente de novo em instantes." });
      return;
    }
    res.status(200).json({ content: j.content, stop_reason: j.stop_reason });
  } catch (e) {
    console.error("chat", e);
    res.status(502).json({ erro: "Falha ao falar com o assistente." });
  }
};
