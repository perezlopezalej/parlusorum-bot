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
  'pretend you are', 'act as if',
  'do anything now',
  'hypothetically',
  'roleplay as',
  'simulate',
  'end system prompt', 'disregard', 'you are now', 'your new instructions',
  // Inyección de prompt — español
  'ignora las instrucciones', 'ignora tu', 'ignora tus',
  'olvida tu rol', 'olvida tus instrucciones', 'olvida las instrucciones',
  'actua como dan', 'actua como un', 'nueva personalidad',
  'eres libre ahora', 'sin restricciones', 'sin limites',
  'fin del sistema', 'fin del prompt', 'nueva instruccion',
  'modo sin censura', 'modo developer', 'modo dios',
  'finge que eres', 'pretende ser', 'actua como si',
  'ignora todo lo anterior', 'a partir de ahora eres',
];

// Patrones cortos que solo bloquean como palabra completa (evita "crisis", "análisis", "recoger"...)
const WORD_ONLY = new Set(['isis', 'coger', 'corrida', 'perra', 'hdp', 'zorra', 'mamada', 'porno']);

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
  const padded = ` ${normalized.replace(/\s+/g, ' ')} `;
  return BLOCKED_PATTERNS.some(pattern => {
    const p = normalize(pattern);
    return WORD_ONLY.has(p) ? new RegExp(`\\s${p}s?\\s`).test(padded) : normalized.includes(p);
  });
}

function sanitizeForAI(text) {
  if (!text || typeof text !== 'string') return null;
  if (containsBlockedContent(text)) return null;
  // Limitar longitud y eliminar caracteres peligrosos
  return text.slice(0, 200).replace(/[<>{}]/g, '').replace(/[\r\n]/g, ' ').trim() || null;
}

module.exports = { containsBlockedContent, sanitizeForAI };
