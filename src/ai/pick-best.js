// Selector con IA: entre los candidatos que ya pasan los filtros del código, un modelo de OTRA familia que el generador
// (generó gpt-oss → elige qwen, y al revés) elige el mejor, con los candidatos en orden aleatorio,
// comparándolos entre sí (ortografía, lógica, encaje con lo que acaba de pasar) o dice que ninguno vale (entonces se calla).

const { aiChat } = require('../utils/ai-router');
const { canMakeAuxRequest } = require('../utils/ratelimit');
const logger = require('../utils/logger');
const { stripEmotes } = require('./factcheck');

const SYSTEM = 'Eres el editor de un chat de Twitch en España. Te paso comentarios candidatos del bot Dios Fua y el contexto real del directo. Tu trabajo es ELEGIR EL MEJOR: casi siempre hay alguno que se puede enviar, y lo eliges aunque no sea perfecto ni muy gracioso. ' +
  'Solo dices que ninguno vale si TODOS los candidatos tienen un fallo claro de estas tres clases: ' +
  '(1) ortografía: palabras cortadas, inventadas o mal escritas, género o número incorrectos; ' +
  '(2) sin sentido: la frase no significa nada, el sujeto y la acción no encajan o la comparación no tiene lógica; ' +
  '(3) no cuadra con <chat>, <datos> y <ahora>: atribuye al chat algo que no aparece en <chat> (apuestas, silencio, discusiones), contradice la actividad del chat, la hora o el contador, o mezcla quién juega. ' +
  'No son fallos: que tenga poca gracia, un estilo flojo, una exageración o broma clara, «puzle» o «puzzle», ni «el FUA», que es el grito de carácter del canal. Entre varios válidos, elige el que mejor se entienda y mejor encaje con lo que ha pasado. ' +
  'Ejemplos de fallo: «Men martes tarde más majo» (palabra cortada), «Manu se ha besado el suelo» (el suelo no se besa), «ha probado el suelo más veces que el felpudo de casa» (comparación sin lógica), «Rata de exploración tranquila» (frase sin sentido), «el chat mudo» con el chat hablando. ' +
  'Ante la duda entre elegir y descartar, elige. Responde solo con este JSON: {"mejor": N} con el número del mejor, o {"mejor": 0} si todos tienen un fallo claro.';

const block = (tag, body) => (body ? `<${tag}>\n${String(body).trim()}\n</${tag}>` : '');

function buildPickPrompt(candidates, { dayLine = '', game = '', facts = '', chat = '', activity = null } = {}) {
  const list = candidates.map((c, i) => `${i + 1}) ${stripEmotes(c)}`).join('\n');
  return [
    block('ahora', dayLine),
    block('datos', [game ? `Juego: ${game}.` : '', facts, activity != null ? `Mensajes en el chat en los últimos 5 minutos: ${activity}.` : ''].filter(Boolean).join(' ')),
    block('chat', chat || '(sin mensajes recientes)'),
    block('candidatos', list),
  ].filter(Boolean).join('\n');
}

// "{"mejor": 2}" | "2" | "mejor: 0" → número (0 = ninguno) o null si es ilegible
function parsePick(raw, max) {
  const t = String(raw || '').replace(/```(?:json)?/gi, '');
  const m = /"?mejor"?\s*[:=]\s*(\d+)/i.exec(t) || /^\s*(\d+)\b/.exec(t);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 0 && n <= max ? n : null;
}

const shuffle = n => { const a = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/**
 * ctx.generator: modelo que escribió los candidatos (el selector será de otra familia). ctx.order: permutación fija (tests).
 * → { status: 'ok', index } (índice 0-based del elegido) | { status: 'none' } (ninguno vale) | { status: 'error' } (cupo o fallo: el llamador decide)
 * Con un solo candidato hace de revisor: lo da por bueno o dice 'none'.
 */
async function pickBest(candidates, ctx = {}) {
  const list = (candidates || []).filter(Boolean);
  if (!list.length) return { status: 'none' };
  const order = ctx.order || shuffle(list.length); // orden al azar: el selector no favorece al primero
  const shown = order.map(i => list[i]);
  if (!canMakeAuxRequest()) { logger.info('Selector: sin cupo auxiliar, se usa el orden del código'); return { status: 'error' }; }
  try {
    const response = await aiChat('pick', {
      max_tokens: 600, // el modelo razona antes de contestar: con poco margen se queda sin contenido
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildPickPrompt(shown, ctx) },
      ],
    }, { generator: ctx.generator });
    const n = parsePick(response.choices[0]?.message?.content, list.length);
    if (n === null) { logger.warn('Selector: respuesta ilegible, se usa el orden del código'); return { status: 'error' }; }
    if (n === 0) return { status: 'none' };
    return { status: 'ok', index: order[n - 1] };
  } catch (err) {
    logger.warn(`Selector falló, se usa el orden del código: ${err.message}`);
    return { status: 'error' };
  }
}

module.exports = { pickBest, buildPickPrompt, parsePick, SYSTEM };
