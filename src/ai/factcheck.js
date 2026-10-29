// Comprobación SÍ/NO con el modelo rápido: ¿el mensaje afirma algo concreto del juego que no está en los datos?
// Toda duda o fallo cuenta como "descartar": mejor callar que arriesgar.

const { groqWithRetry, GROQ_MODEL_FAST } = require('../utils/groq-utils');
const { canMakeRequest } = require('../utils/ratelimit');
const logger = require('../utils/logger');

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

// true = descartar el mensaje. source: 'stream' (mensajes automáticos) | 'rawg' (!dios_fua con buscar_juego)
async function shouldDiscard(text, data, { source = 'stream' } = {}) {
  if (!canMakeRequest()) return true;
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
    return true;
  }
}

module.exports = { parseVerdict, buildCheckPrompt, shouldDiscard };
