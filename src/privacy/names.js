/**
 * privacy/names.js — Funciones puras para quitar nicks de textos que se guardan.
 * Streamers, mods, bot y canal no se tocan (son públicos): misma lista que ai-pseudonym.
 */
const { excludedNames } = require('../utils/ai-pseudonym');

const MIN_NAME_LEN = 3;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Nicks válidos para sustituir: ≥3 letras, sin espacios, sin los excluidos; los más largos primero
function cleanNicks(nicks, exclude = excludedNames(), minLen = MIN_NAME_LEN) {
  return [...new Set((nicks || []).map(n => String(n || '').replace(/^@/, '').trim().toLowerCase()))]
    .filter(n => n.length >= minLen && !/\s/.test(n) && !exclude.has(n))
    .sort((a, b) => b.length - a.length);
}

// Regex de palabra completa (con @ opcional) para esos nicks; null si no hay ninguno
function nickRegex(nicks, exclude, minLen) {
  const list = cleanNicks(nicks, exclude, minLen);
  if (!list.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_])@?(?:${list.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
}

function scrubNicks(text, nicks, { replacement = 'un espectador', exclude, minLen } = {}) {
  if (typeof text !== 'string') return text;
  const re = nickRegex(nicks, exclude, minLen);
  return re ? text.replace(re, replacement) : text;
}

// Nicks que escriben en una muestra "usuario: mensaje" por líneas
function nicksFromChatSample(chatSample) {
  const out = new Set();
  for (const line of String(chatSample || '').split('\n')) {
    const sep = line.indexOf(': ');
    if (sep > 0) out.add(line.slice(0, sep).trim().toLowerCase());
  }
  return [...out];
}

module.exports = { cleanNicks, nickRegex, scrubNicks, nicksFromChatSample, MIN_NAME_LEN };
