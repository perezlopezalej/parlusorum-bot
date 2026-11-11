// Utilidades de texto compartidas por el resto de módulos de calidad.

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

// --- Directo del 10-11: ruido del chat, mayúsculas, ortografía, formato de informe, listas de palabras, hora y repeticiones del stream ---
// Texto sin emotes del canal, @menciones ni enlaces: lo que queda son palabras del bot
function plainWords(text) {
  return String(text || '').replace(/https?:\/\/\S+/gi, ' ').replace(/@\w+/g, ' ').replace(/\bparlus1\w*/gi, ' ');
}

module.exports = { norm, plainWords };
