// Lista de palabras que el bot no debería procesar
// Añadir las que sean necesarias para el canal
const BLOCKED_WORDS = [
  'nazi', 'Hitler', 'violación', 'suicidio', 'autolisis',
  'puta madre', 'hijo de puta', 'maricón', 'zorra'
];

// Convertir a lowercase para comparación
const blockedLower = BLOCKED_WORDS.map(w => w.toLowerCase());

function containsBlockedContent(text) {
  const lower = text.toLowerCase();
  return blockedLower.some(word => lower.includes(word));
}

function sanitizeForAI(text) {
  if (containsBlockedContent(text)) return null;
  return text.slice(0, 200).replace(/[<>]/g, '').trim();
}

module.exports = { containsBlockedContent, sanitizeForAI };
