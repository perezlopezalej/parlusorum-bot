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
    ? '¿El mensaje afirma algo sobre el juego que no esté en el resultado de RAWG de arriba?'
    : '¿El mensaje afirma algo concreto del juego (mecánicas, armas, zonas, dificultad, jefes, historia, consejos, fechas) que no esté en estos datos? Las bromas, el FUA y los hechos del stream (muertes, chat, eventos) no cuentan.';
  return `Datos disponibles:\n${ctx}\n\nMensaje:\n${text}\n\n${question} Responde SOLO "SÍ" o "NO".`;
}

// Juego a partir de los datos ("Juego: X. Muertes...") cuando el llamador no lo pasa aparte
function gameFromData(data) {
  const m = /^Juego:\s*(.+?)\.(?:\s|$)/.exec(String(data || ''));
  return m ? m[1] : '';
}

// true = descartar el mensaje. source: 'stream' (mensajes automáticos) | 'rawg' (!dios_fua con buscar_juego)
// Los mensajes 'stream' que no hablan del juego no se comprueban (ni gastan petición). Usa su propio cupo (canMakeAuxRequest).
async function shouldDiscard(text, data, { source = 'stream', game } = {}) {
  if (source === 'stream' && !mentionsGame(text, game ?? gameFromData(data))) return false;
  if (!canMakeAuxRequest()) { recordFactcheckFailure('ratelimit'); return true; }
  try {
    const response = await groqWithRetry({
      model: GROQ_MODEL_FAST,
      max_tokens: 8,
      temperature: 0,
      messages: [
        { role: 'system', content: 'Eres un verificador estricto. Respondes únicamente SÍ o NO.' },
        { role: 'user', content: buildCheckPrompt(text, data, source) },
      ],
    });
    return parseVerdict(response.choices[0]?.message?.content) !== 'no';
  } catch (err) {
    logger.warn(`Comprobación de datos del juego falló, se descarta: ${err.message}`);
    recordFactcheckFailure(err.status === 429 ? 'groq429' : 'error');
    return true;
  }
}

module.exports = { parseVerdict, buildCheckPrompt, gameFromData, shouldDiscard };
