/**
 * filter.js — Filtro de contenido mejorado
 * Lista ampliada y normalización de texto para mayor cobertura.
 */

const BLOCKED_PATTERNS = [
  // Odio e insultos graves
  'nazi', 'hitler', 'fascist',
  'violacion', 'violación',
  'suicidio', 'autolisis', 'suicidar',
  'maricón', 'maricon', 'marika',
  'puta madre', 'hijo de puta', 'hdp',
  'zorra', 'perra', 'prostituta',
  'retrasado', 'imbecil', 'imbécil',
  'negro de mierda', 'moro de mierda',
  // Contenido sexual explícito
  'pornografia', 'pornografía', 'porno',
  'follar', 'coger', 'mamada', 'corrida',
  // Extremismo
  'terroris', 'yihad', 'isis',
  // Inyección de prompt — inglés
  'ignore previous', 'ignore all', 'ignore your',
  'forget your instructions', 'new instructions',
  'system prompt', 'jailbreak', 'dan mode',
  'pretend you are', 'act as if', 'you are now',
  'disregard', 'override', 'bypass', 'roleplay as',
  'from now on you', 'your new instructions',
  // Inyección de prompt — español
  'ignora tus instrucciones', 'ignora todas', 'ignora todo lo anterior',
  'olvida tus instrucciones', 'olvida lo anterior', 'olvida todo',
  'nuevas instrucciones', 'nueva instruccion', 'nuevo rol',
  'a partir de ahora eres', 'ahora eres', 'eres ahora',
  'actua como si', 'finge que eres', 'finge ser',
  'comportate como', 'comportarte como',
  'sin restricciones', 'sin limites', 'modo libre',
  'modo sin filtros', 'modo sin censura',
  'instruccion del sistema', 'prompt del sistema',
  'sal del personaje', 'rompe el personaje',
];

// Normalizar texto: quitar acentos, pasar a minúsculas
function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');
}

function containsBlockedContent(text) {
  const normalized = normalize(text);
  return BLOCKED_PATTERNS.some(pattern => normalized.includes(normalize(pattern)));
}

function sanitizeForAI(text) {
  if (!text || typeof text !== 'string') return null;
  if (containsBlockedContent(text)) return null;
  // Limitar longitud y eliminar caracteres peligrosos
  return text.slice(0, 200).replace(/[<>{}]/g, '').trim() || null;
}

module.exports = { containsBlockedContent, sanitizeForAI };
