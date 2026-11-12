// Política de emotes: cuántos caben, dónde van y cómo se recortan.

// --- Emotes: como mucho 1 de cada 3 mensajes ---
const emoteRe = (emotes) =>
  new RegExp(`(?:${emotes.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');

const hasEmote = (text, emotes) => emotes.length > 0 && emoteRe(emotes).test(text);

// Se permite emote solo si ninguno de los 2 últimos mensajes del bot (más recientes al final) llevó
function emoteAllowed(recentBotMessages, emotes) {
  return !recentBotMessages.slice(-2).some((m) => hasEmote(m, emotes));
}

// Espacio sobrante antes de signos de puntuación; no toca "usa !comando" (el signo va pegado a una palabra)
const SPACE_BEFORE_PUNCT_RE = /\s+([,.;:!?…])(?![\p{L}\p{N}_])/gu;

// Un emote entre paréntesis o corchetes deja «( )» al quitarlo
const EMPTY_BRACKETS_RE = /\(\s*\)|\[\s*\]/g;

function stripEmotes(text, emotes) {
  if (!emotes.length) return text;
  return text
    .replace(emoteRe(emotes), '')
    .replace(EMPTY_BRACKETS_RE, '')
    .replace(SPACE_BEFORE_PUNCT_RE, '$1')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// El emote va siempre al final del mensaje (nunca en medio ni antes de "?", "!" o "."): se saca de donde esté y se añade tras el texto
function moveEmotesToEnd(text, emotes) {
  if (!emotes.length) return text;
  const found = String(text).match(emoteRe(emotes));
  if (!found) return text;
  const body = String(text)
    .replace(emoteRe(emotes), '')
    .replace(EMPTY_BRACKETS_RE, '')
    .replace(/ {2,}/g, ' ')
    .replace(SPACE_BEFORE_PUNCT_RE, '$1')
    .trim();
  return body ? `${body} ${found[0]}` : found[0];
}

// Último "palabra" del texto que es un emote a medias ("parlus1PORELPO"): lo corta max_tokens o el límite de caracteres. Se elimina.
function dropPartialEmote(text, emotes) {
  const t = String(text || '').trimEnd();
  const m = t.match(/(\S+)$/);
  if (!m || !emotes.length) return t;
  const tail = m[1].replace(/[.,;:!?¡¿…]+$/, '').toLowerCase();
  if (tail.length < 4) return t;
  const partial = emotes.some((e) => e.toLowerCase().startsWith(tail) && e.toLowerCase() !== tail);
  return partial
    ? t
        .slice(0, m.index)
        .replace(/[\s,;:¡¿-]+$/, '')
        .trimEnd()
    : t;
}

// Ajusta un mensaje al límite de Twitch sin partir un emote: si no cabe entero, se quitan los emotes (antes de cortar el texto)
function fitWithEmotes(text, limit, emotes) {
  const t = dropPartialEmote(String(text || '').trim(), emotes);
  if (t.length <= limit || !emotes.length) return t;
  return stripEmotes(t, emotes);
}

// Símbolo con el que cierra el mensaje: emote del canal (en minúsculas) o emoji; '' si no cierra con ninguno
const TAIL_EMOJI_RE = /(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*$/u;

function tailSymbol(text, emotes = []) {
  const t = String(text || '').trimEnd();
  const emote = emotes.find((e) => t.toLowerCase().endsWith(e.toLowerCase()));
  if (emote) return emote.toLowerCase();
  const m = TAIL_EMOJI_RE.exec(t);
  return m ? m[1] : '';
}

// Si el mensaje cierra con el mismo emote o emoji que alguno de los últimos `n` mensajes del bot, se lo quita
function dropRepeatedTail(text, recent = [], emotes = [], n = 3) {
  const sym = tailSymbol(text, emotes);
  if (!sym || n <= 0 || !recent.slice(-n).some((r) => tailSymbol(r, emotes) === sym)) return text;
  const body = String(text).trimEnd().slice(0, -sym.length).trimEnd();
  return body || text;
}

// Emotes que no han cerrado ninguno de los últimos `n` mensajes del bot (si todos se han usado, la lista entera)
function freshEmotes(emotes = [], recent = [], n = 4) {
  const used = new Set(recent.slice(-n).map((r) => tailSymbol(r, emotes)));
  const fresh = emotes.filter((e) => !used.has(e.toLowerCase()));
  return fresh.length ? fresh : emotes;
}

// Aplica la política: sin permiso se quitan todos; con permiso se deja como mucho el primero, al final del mensaje.
// `recent` = últimos mensajes del bot: el mismo emote o emoji de cierre no se repite
function applyEmotePolicy(text, allowed, emotes, recent = []) {
  return dropRepeatedTail(applyEmotes(text, allowed, emotes), recent, emotes);
}

function applyEmotes(text, allowed, emotes) {
  if (!emotes.length) return text;
  if (!allowed) return stripEmotes(text, emotes);
  let seen = false;
  const single = text
    .replace(emoteRe(emotes), (m) => (seen ? '' : ((seen = true), m)))
    .replace(EMPTY_BRACKETS_RE, '')
    .replace(/ {2,}/g, ' ')
    .replace(SPACE_BEFORE_PUNCT_RE, '$1')
    .trim();
  return moveEmotesToEnd(single, emotes);
}

module.exports = {
  hasEmote,
  emoteAllowed,
  stripEmotes,
  applyEmotePolicy,
  dropPartialEmote,
  fitWithEmotes,
  moveEmotesToEnd,
  dropRepeatedTail,
  freshEmotes,
};
