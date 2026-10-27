/**
 * Dato opcional sobre quien se suscribe, para que el agradecimiento suene a canal con memoria.
 * Función pura: recibe los datos ya leídos y devuelve una línea para el prompt (o '').
 * Lista blanca de datos; como máximo uno por mensaje, y nunca algo que pueda incomodar.
 */

const { sanitizeForAI } = require('../utils/filter');

const MIN_WINS = 2;

// facts: [{ fact_type, value }]; nickname: apodo del lore manual o null; isAvoided: (texto) => bool
function buildSubContext(username, facts, { nickname = null, isAvoided = () => false, rng = Math.random } = {}) {
  const byType = new Map((facts || []).map(f => [f.fact_type, f.value]));
  const options = [];

  if (nickname) options.push(`en el canal le llaman "${nickname}" (apodo oficial)`);

  const joke = sanitizeForAI(String(byType.get('recurring_joke') || ''));
  if (joke && !isAvoided(joke)) options.push(`su frase habitual en el chat es "${joke}"`);

  const wins = parseInt(byType.get('trivia_wins'), 10) || 0;
  if (wins >= MIN_WINS) options.push(`ha ganado ${wins} trivias del chat`);

  if (byType.get('is_regular') === 'true') options.push('es habitual del canal, lleva tiempo por aquí');

  if (!options.length) return '';
  const chosen = options[Math.min(options.length - 1, Math.floor(rng() * options.length))];
  return `Dato opcional sobre @${username}: ${chosen}. Úsalo solo si encaja, con cariño y naturalidad; no lo expliques ni lo uses como burla.`;
}

module.exports = { buildSubContext };
