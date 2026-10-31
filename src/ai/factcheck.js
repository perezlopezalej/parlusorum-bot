// Comprobación SÍ/NO con el modelo rápido: ¿el mensaje afirma algo concreto del juego que no está en los datos?
// Solo se comprueba lo que habla del juego; si es de eso y hay duda o fallo, se descarta. Lo que no habla del juego se envía sin comprobar.

const { groqWithRetry, GROQ_MODEL_FAST } = require('../utils/groq-utils');
const { canMakeAuxRequest } = require('../utils/ratelimit');
const { mentionsGame } = require('./quality');
const logger = require('../utils/logger');
const { recordCohostDiscard } = require('../utils/state');

// Fallos de la propia comprobación (no del mensaje), para distinguirlos en el resumen de fin de stream
function recordFactcheckFailure(kind) { recordCohostDiscard(`factcheck_${kind}`); }

// 'yes' | 'no' | null (respuesta ilegible)
function parseVerdict(raw) {
  const t = String(raw || '').trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  if (/^(si|yes)\b/.test(t)) return 'yes';
  if (/^no\b/.test(t)) return 'no';
  return null;
}

function buildCheckPrompt(text, data, source) {
  const ctx = String(data || '').trim() || '(ninguno)';
  const question = source === 'rawg'
    ? '¿El mensaje afirma algún dato concreto y comprobable del juego (fechas, estudio, mecánicas, armas, zonas, dificultades, personajes, tramas) que no esté en el resultado de RAWG de arriba (incluida su descripción)? Las opiniones, valoraciones y descripciones de tono o ambiente ("atmósfera densa", "ideal para flipar"), las bromas y el FUA no se comprueban y no cuentan. Si no hay datos y el mensaje solo dice que no conoce el juego, responde NO. Responde "NO" si todo está respaldado, o "SÍ: " seguido de la frase o dato no respaldado, copiado del mensaje (máx. 15 palabras).'
    : '¿El mensaje afirma algo concreto del juego (mecánicas, armas, zonas, dificultad, jefes, historia, consejos, fechas) que no esté en estos datos? Las bromas, el FUA y los hechos del stream (muertes, chat, eventos) no cuentan.';
  return `Datos disponibles:\n${ctx}\n\nMensaje:\n${text}\n\n${question} ${source === 'rawg' ? '' : 'Responde SOLO "SÍ" o "NO".'}`;
}

// Juego a partir de los datos ("Juego: X. Muertes...") cuando el llamador no lo pasa aparte
function gameFromData(data) {
  const m = /^Juego:\s*(.+?)\.(?:\s|$)/.exec(String(data || ''));
  return m ? m[1] : '';
}

// Frase no respaldada tras "SÍ:" (solo la pide el prompt de RAWG)
function parseClaim(raw) {
  const m = /^\s*s[ií]\s*[:\-–]\s*(.+)$/is.exec(String(raw || ''));
  return m ? m[1].trim().replace(/^["“«]|["”»]$/g, '').slice(0, 120) : '';
}

// { discard, claim }: claim es lo no respaldado cuando el verificador lo indica
async function evaluate(text, data, { source = 'stream', game } = {}) {
  if (source === 'stream' && !mentionsGame(text, game ?? gameFromData(data))) return { discard: false, claim: '' };
  if (!canMakeAuxRequest()) { recordFactcheckFailure('ratelimit'); return { discard: true, claim: '' }; }
  try {
    const response = await groqWithRetry({
      model: GROQ_MODEL_FAST,
      max_tokens: source === 'rawg' ? 60 : 8,
      temperature: 0,
      messages: [
        { role: 'system', content: source === 'rawg' ? 'Eres un verificador estricto. Respondes "NO" o "SÍ: <frase no respaldada>".' : 'Eres un verificador estricto. Respondes únicamente SÍ o NO.' },
        { role: 'user', content: buildCheckPrompt(text, data, source) },
      ],
    });
    const raw = response.choices[0]?.message?.content;
    return { discard: parseVerdict(raw) !== 'no', claim: parseClaim(raw) };
  } catch (err) {
    logger.warn(`Comprobación de datos del juego falló, se descarta: ${err.message}`);
    recordFactcheckFailure(err.status === 429 ? 'groq429' : 'error');
    return { discard: true, claim: '' };
  }
}

// true = descartar el mensaje. source: 'stream' (mensajes automáticos) | 'rawg' (!dios_fua con buscar_juego)
// Los mensajes 'stream' que no hablan del juego no se comprueban (ni gastan petición). Usa su propio cupo (canMakeAuxRequest).
async function shouldDiscard(text, data, opts) {
  return (await evaluate(text, data, opts)).discard;
}

module.exports = { parseVerdict, parseClaim, evaluate, buildCheckPrompt, gameFromData, shouldDiscard };
