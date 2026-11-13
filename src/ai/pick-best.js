// Selector con IA: entre los candidatos que ya pasan los filtros del código, un modelo de OTRA familia que el generador
// (generó gpt-oss → elige qwen, y al revés) elige el más correcto (no el más gracioso: los LLM son malos jueces de la gracia, ver sección 11 de la investigación), con los candidatos en orden aleatorio,
// comparándolos entre sí (ortografía, lógica, encaje con los hechos del momento) o dice que ninguno vale (entonces se calla).
// Recibe los mismos hechos que el generador, nunca el chat literal: así no da por bueno un candidato «porque el chat lo dijo».

const { aiChat } = require('../utils/ai-router');
const { canMakeAuxRequest } = require('../utils/ratelimit');
const logger = require('../utils/logger');
const { stripEmotes } = require('./factcheck');

const SYSTEM =
  'Eres el editor de un chat de Twitch en España. Te paso comentarios candidatos del bot Dios Fua y el contexto real del directo. Tu trabajo es ELEGIR EL MÁS CORRECTO, no el más gracioso: juzgas solo la corrección (sentido, ortografía y que hable de un hecho dado sin inventar), nunca la gracia, porque no se te da bien medirla. Casi siempre hay alguno que se puede enviar, y lo eliges aunque no sea perfecto. ' +
  'Solo dices que ninguno vale si TODOS los candidatos tienen un fallo claro de estas tres clases: ' +
  '(1) ortografía: palabras cortadas, inventadas o mal escritas, género o número incorrectos; ' +
  '(2) sin sentido: la frase no significa nada, el sujeto y la acción no encajan o la comparación no tiene lógica; ' +
  '(3) no cuadra con <hechos>, <datos> y <ahora>: habla de algo que no está en los hechos (apuestas, silencio, discusiones del chat, cosas que nadie ha contado), contradice la actividad del chat, la hora o el contador, o mezcla quién juega. Si un candidato lleva delante el hecho del que dice partir («[h2]»), tiene que hablar de ese hecho. ' +
  'No son fallos, y no cuentan a favor ni en contra: que tenga más o menos gracia, un estilo flojo, una exageración o broma clara, «puzle» o «puzzle», ni «el FUA», que es el grito de carácter del canal. Entre varios correctos, elige el que mejor se entienda y mejor encaje con los hechos; si hay empate, el que cuente el hecho de forma más directa y sencilla, sin fijarte en cuál hace más gracia. ' +
  'Ejemplos de fallo: «Men martes tarde más majo» (palabra cortada), «Manu se ha besado el suelo» (el suelo no se besa), «ha probado el suelo más veces que el felpudo de casa» (comparación sin lógica), «Rata de exploración tranquila» (frase sin sentido), «media hora tan limpia que hasta el FUA tiene la cola entre las patas» (frase hecha que no pega con lo que pasa), «el chat mudo» con el chat hablando. ' +
  'Ante la duda entre elegir y descartar, elige. Responde solo con este JSON: {"mejor": N} con el número del más correcto, o {"mejor": 0} si todos tienen un fallo claro.';

const block = (tag, body) => (body ? `<${tag}>\n${String(body).trim()}\n</${tag}>` : '');

// candidates: textos u objetos { text, hecho } (hecho = id del hecho del que parte). ctx.hechos: bloque <hechos> ya montado
// (moment-facts.renderFacts) o ''. El selector no recibe líneas del chat: solo los hechos y cuántos mensajes hay.
function buildPickPrompt(candidates, { dayLine = '', game = '', facts = '', hechos = '', activity = null } = {}) {
  const textOf = (c) => (typeof c === 'string' ? c : c.text);
  const list = candidates
    .map((c, i) => `${i + 1}) ${c.hecho ? `[${c.hecho}] ` : ''}${stripEmotes(textOf(c))}`)
    .join('\n');
  return [
    block('ahora', dayLine),
    block(
      'datos',
      [
        game ? `Juego: ${game}.` : '',
        facts,
        activity != null ? `Mensajes en el chat en los últimos 5 minutos: ${activity}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    ),
    String(hechos || '').trim(),
    block('candidatos', list),
  ]
    .filter(Boolean)
    .join('\n');
}

// "{"mejor": 2}" | "2" | "mejor: 0" → número (0 = ninguno) o null si es ilegible
function parsePick(raw, max) {
  const t = String(raw || '').replace(/```(?:json)?/gi, '');
  const m = /"?mejor"?\s*[:=]\s*(\d+)/i.exec(t) || /^\s*(\d+)\b/.exec(t);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 0 && n <= max ? n : null;
}

const shuffle = (n) => {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * ctx.generator: modelo que escribió los candidatos (el selector será de otra familia). ctx.order: permutación fija (tests).
 * → { status: 'ok', index } (índice 0-based del elegido) | { status: 'none' } (ninguno vale) | { status: 'error' } (cupo o fallo: el llamador decide)
 * Con un solo candidato hace de revisor: lo da por bueno o dice 'none'.
 */
async function pickBest(candidates, ctx = {}) {
  const list = (candidates || []).filter(Boolean);
  if (!list.length) return { status: 'none' };
  const order = ctx.order || shuffle(list.length); // orden al azar: el selector no favorece al primero
  const shown = order.map((i) => list[i]);
  if (!canMakeAuxRequest()) {
    logger.info('Selector: sin cupo auxiliar, se usa el orden del código');
    return { status: 'error' };
  }
  try {
    const response = await aiChat(
      'pick',
      {
        max_tokens: 600, // el modelo razona antes de contestar: con poco margen se queda sin contenido
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: buildPickPrompt(shown, ctx) },
        ],
      },
      { generator: ctx.generator },
    );
    const n = parsePick(response.choices[0]?.message?.content, list.length);
    if (n === null) {
      logger.warn('Selector: respuesta ilegible, se usa el orden del código');
      return { status: 'error' };
    }
    if (n === 0) return { status: 'none' };
    return { status: 'ok', index: order[n - 1] };
  } catch (err) {
    logger.warn(`Selector falló, se usa el orden del código: ${err.message}`);
    return { status: 'error' };
  }
}

module.exports = { pickBest, buildPickPrompt, parsePick, SYSTEM };
