// Selector con IA: entre los candidatos que ya pasan los filtros del código, un modelo pequeño (Groq 20b) elige el mejor
// comparándolos entre sí (ortografía, lógica, encaje con lo que acaba de pasar) o dice que ninguno vale (entonces se calla).

const { aiChat } = require('../utils/ai-router');
const { canMakeAuxRequest } = require('../utils/ratelimit');
const logger = require('../utils/logger');
const { stripEmotes } = require('./factcheck');

const SYSTEM = 'Eres el editor de un chat de Twitch en España. Te paso comentarios candidatos del bot Dios Fua y el contexto real del directo. Eliges el mejor o dices que ninguno vale. ' +
  'Un comentario vale solo si: (1) está bien escrito: palabras reales y completas, ortografía, género y número correctos, mayúsculas solo en el FUA y nombres propios; ' +
  '(2) tiene lógica y se entiende a la primera: sujeto y acción encajan, la broma tiene un sentido claro, sin metáforas que no significan nada; ' +
  '(3) cuadra con <chat>, <datos> y <ahora>: no atribuye al chat nada que no aparezca en <chat> (apuestas, silencio, discusiones), no contradice la actividad del chat, la hora ni el contador, y no mezcla quién juega; ' +
  '(4) suena natural, como una frase de una persona. Las bromas y exageraciones claras valen; «puzle» y «puzzle» son grafías válidas; «el FUA» es el grito de carácter del canal. ' +
  'Ejemplos que NO valen: «Men martes tarde más majo» (palabra cortada), «Manu se ha besado el suelo» (el suelo no se besa), «ha probado el suelo más veces que el felpudo de casa» (comparación sin lógica), «Rata de exploración tranquila» (frase sin sentido), «el chat mudo» con el chat hablando. ' +
  'Responde solo con este JSON: {"mejor": N} con el número del mejor comparándolos, o {"mejor": 0} si ninguno vale.';

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

/**
 * → { status: 'ok', index } (índice 0-based del elegido) | { status: 'none' } (ninguno vale) | { status: 'error' } (cupo o fallo: el llamador decide)
 * Con un solo candidato hace de revisor: lo da por bueno o dice 'none'.
 */
async function pickBest(candidates, ctx = {}) {
  const list = (candidates || []).filter(Boolean);
  if (!list.length) return { status: 'none' };
  if (!canMakeAuxRequest()) { logger.info('Selector: sin cupo auxiliar, se usa el orden del código'); return { status: 'error' }; }
  try {
    const response = await aiChat('review', {
      max_tokens: 600, // el modelo razona antes de contestar: con poco margen se queda sin contenido
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildPickPrompt(list, ctx) },
      ],
    });
    const n = parsePick(response.choices[0]?.message?.content, list.length);
    if (n === null) { logger.warn('Selector: respuesta ilegible, se usa el orden del código'); return { status: 'error' }; }
    if (n === 0) return { status: 'none' };
    return { status: 'ok', index: n - 1 };
  } catch (err) {
    logger.warn(`Selector falló, se usa el orden del código: ${err.message}`);
    return { status: 'error' };
  }
}

module.exports = { pickBest, buildPickPrompt, parsePick, SYSTEM };
