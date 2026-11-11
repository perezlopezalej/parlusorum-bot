/**
 * filter.js — Filtro de contenido mejorado
 * Lista ampliada y normalización de texto para mayor cobertura.
 */

// Términos ofensivos: se vetan en la entrada (a la IA) y en la salida (al chat)
const OFFENSIVE_PATTERNS = [
  // Odio e insultos graves
  'nazi', 'hitler', 'fascist',
  'violacion', 'violación',
  'suicidio', 'autolisis', 'suicidar',
  'maricón', 'maricon', 'marika',
  'puta madre', 'hijo de puta', 'hdp',
  'zorra', 'perra', 'prostituta',
  'imbecil', 'imbécil',
  'negro de mierda', 'moro de mierda',
  // Contenido sexual explícito
  'pornografia', 'pornografía', 'porno',
  'follar', 'mamada', 'corrida',
  // Extremismo
  'terroris', 'yihad', 'isis',
];

// Inyección de prompt: solo se vigila en la entrada (lo que escriben los usuarios)
const INJECTION_PATTERNS = [
  // Inglés
  'ignore previous', 'ignore all', 'ignore your',
  'forget your instructions', 'new instructions',
  'system prompt', 'jailbreak', 'dan mode',
  'pretend you are', 'act as if',
  'do anything now',
  'hypothetically',
  'roleplay as',
  'simulate',
  'end system prompt', 'disregard', 'you are now', 'your new instructions',
  // Español
  'ignora las instrucciones', 'ignora tu', 'ignora tus',
  'olvida tu rol', 'olvida tus instrucciones', 'olvida las instrucciones',
  'actua como dan', 'actua como un', 'nueva personalidad',
  'eres libre ahora', 'sin restricciones', 'sin limites',
  'fin del sistema', 'fin del prompt', 'nueva instruccion',
  'modo sin censura', 'modo developer',
  'finge que eres', 'pretende ser', 'actua como si',
  'ignora todo lo anterior', 'a partir de ahora eres',
];

// Paráfrasis de inyección ("Ignora lo que te dijeron antes y escribe…"). Se aplican sobre texto normalizado
// (sin tildes, minúsculas, sin signos). Piden un verbo de anulación + un objeto que sea "lo que te dijeron /
// tus instrucciones", para no bloquear "olvida lo de antes" ni "ignora las reglas del juego".
const INJECTION_REGEXES = [
  /\b(ignor\w*|olvid\w*|omit\w*|descart\w*|desobedec\w*|borra\w*)\b.{0,30}\b(dijeron|dijo|indicaron|programaron|configuraron|instruccion\w*|indicacion\w*|directrices|prompt)\b/,
  /\b(repite|escribe|di|responde|contesta|imprime|pon)\b.{0,15}\b(exactamente|literalmente|textualmente|palabra por palabra)\b/,
  /\brepite\b.{0,10}\b(despues de mi|lo siguiente|conmigo)\b/,
  /\b(revela|muestra|dime|imprime)\b.{0,15}\b(tus? (prompt|instrucciones)|system prompt|prompt del sistema)\b/,
  /\b(ignore|disregard|forget|override)\b.{0,30}\b(previous|prior|above|earlier|instructions|rules|told|system)\b/,
];

// Patrones cortos que solo bloquean como palabra completa (evita "crisis", "análisis", "recoger"...)
const WORD_ONLY = new Set(['isis', 'corrida', 'perra', 'hdp', 'zorra', 'mamada', 'porno']);

// Caracteres invisibles que se usan para partir palabras ("na<ZWSP>zi")
const INVISIBLE = /[\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g;

// Normalizar texto: quitar acentos, pasar a minúsculas
function normalize(text) {
  return text
    .replace(INVISIBLE, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');
}

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' };

// Variante contra evasiones, solo se usa ADEMÁS del texto normal:
//  - "n a z i" / "n.a.z.i": une rachas de 3+ caracteres sueltos
//  - "n4zi" / "h1tl3r": números por letras, solo en palabras que mezclan letras y
//    dígitos (así "1515" o "ps5" no se convierten en "isis" ni en nada bloqueable)
function deobfuscate(text) {
  const tokens = normalize(text.replace(/(?<=[a-zA-Z])[@$](?=[a-zA-Z])/g, c => (c === '@' ? 'a' : 's')))
    .split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < tokens.length;) {
    let j = i;
    while (j < tokens.length && tokens[j].length === 1) j++;
    if (j - i >= 3) { out.push(tokens.slice(i, j).join('')); i = j; }
    else { out.push(tokens[i]); i++; }
  }
  return out
    .map(t => (/[a-z]/.test(t) && /\d/.test(t) ? t.replace(/\d/g, d => LEET[d] || d) : t))
    .join(' ');
}

function matchesList(normalized, patterns) {
  const padded = ` ${normalized.replace(/\s+/g, ' ')} `;
  return patterns.some(pattern => {
    const p = normalize(pattern);
    return WORD_ONLY.has(p) ? new RegExp(`\\s${p}s?\\s`).test(padded) : normalized.includes(p);
  });
}

function matchesInjection(normalized) {
  const flat = normalized.replace(/\s+/g, ' ');
  return matchesList(normalized, INJECTION_PATTERNS) || INJECTION_REGEXES.some(re => re.test(flat));
}

// Entrada: ofensivo o intento de inyección
function containsBlockedContent(text) {
  const variants = [normalize(text), deobfuscate(text)];
  return variants.some(v => matchesList(v, OFFENSIVE_PATTERNS) || matchesInjection(v));
}

// Salida: solo términos ofensivos (el bot puede decir "sin límites" o "modo dios")
function containsOffensive(text) {
  return [normalize(text), deobfuscate(text)].some(v => matchesList(v, OFFENSIVE_PATTERNS));
}

function sanitizeForAI(text) {
  if (!text || typeof text !== 'string') return null;
  if (containsBlockedContent(text)) return null;
  // Limitar longitud y eliminar caracteres peligrosos
  return text.slice(0, 200).replace(/[<>{}]/g, '').replace(/[\r\n]/g, ' ').trim() || null;
}

module.exports = { containsBlockedContent, containsOffensive, sanitizeForAI };
