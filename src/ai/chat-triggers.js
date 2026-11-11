// Disparadores sin IA del chat: highlight (marker), spam de emotes y mayúsculas.
const { createStreamMarker } = require('../twitch/api');
const { isSilenced, isReactive, addNarrativeEvent, setLastCapsRageTime } = require('../utils/state');
const logger = require('../utils/logger');
const { saveHighlight } = require('../utils/storage');
const { truncate } = require('../utils/groq-utils');
const { template } = require('../utils/plantillas');
const { getEventSubLiveStatus } = require('./common');

// --- Deteccion de highlights para stream markers ---
const highlightKeywords = [
  'clip',
  'clipa',
  'clipalo',
  'marca',
  'wtf',
  'wow',
  'fua',
  'increible',
  'brutal',
  'epico',
  'epica',
  'locura',
  'boom',
  'gg',
  'no puede ser',
];

const recentHighlightMsgs = [];

const HIGHLIGHT_WINDOW = 15 * 1000;

const HIGHLIGHT_THRESHOLD = 4; // usuarios distintos

let lastMarkerTime = 0;

const MARKER_COOLDOWN = 3 * 60 * 1000;

async function checkForHighlight(client, channel, message, userId) {
  if (!getEventSubLiveStatus()) return;
  const now = Date.now();
  if (now - lastMarkerTime < MARKER_COOLDOWN) return;

  const lower = message.toLowerCase();
  if (!highlightKeywords.some((kw) => lower.includes(kw))) return;

  recentHighlightMsgs.push({ ts: now, message, userId });
  while (recentHighlightMsgs.length > 0 && recentHighlightMsgs[0].ts < now - HIGHLIGHT_WINDOW) {
    recentHighlightMsgs.shift();
  }

  if (new Set(recentHighlightMsgs.map((e) => e.userId)).size >= HIGHLIGHT_THRESHOLD) {
    const triggerMessages = recentHighlightMsgs.map((e) => e.message);
    recentHighlightMsgs.length = 0;
    lastMarkerTime = now;
    addNarrativeEvent('victory', 'El chat explotó — momento épico detectado automáticamente');

    const markerResult = await createStreamMarker('Momento epico detectado por el chat');
    const markerCreated = markerResult !== null;
    if (markerCreated) logger.info(`Stream marker creado automaticamente`);

    if (markerCreated) {
      saveHighlight(triggerMessages, markerResult.id, 'Momento epico detectado por el chat')
        .then((r) => {
          if (r?.error) logger.warn(`Highlight no persistido: ${r.error.message}`);
        })
        .catch(() => {});
    }
    client.say(channel, truncate(template(markerCreated ? 'highlight_marker' : 'highlight')));
  }
}

// --- Emote spam detection ---
const recentEmoteUse = new Map(); // emoteToken → [{user, ts}]

const EMOTE_WINDOW_MS = 20 * 1000;

const EMOTE_SPAM_THRESHOLD = 8;

let lastEmoteCommentTime = 0;

const EMOTE_COMMENT_COOLDOWN = 90 * 1000;

function extractEmoteTokens(tags, message) {
  const tokens = new Set();

  // 1. Emotes nativos de Twitch via tags.emotes: { emoteId: ['start-end', ...] }
  if (tags.emotes && typeof tags.emotes === 'object') {
    for (const positions of Object.values(tags.emotes)) {
      if (positions && positions.length > 0) {
        const [start, end] = positions[0].split('-').map(Number);
        const name = message.slice(start, end + 1);
        if (name) tokens.add(name);
      }
    }
  }

  // 2. Fallback BTTV/FFZ: ALL_CAPS de 4+ chars o CamelCase con uppercase interno
  // 4 chars mínimo para evitar falsos positivos como FUA, GTA, LOL, GG
  if (tokens.size === 0) {
    for (const word of message.split(/\s+/)) {
      if (/^[A-Z]{4,}$/.test(word) || /^[A-Z][a-z]+[A-Z][A-Za-z0-9]*$/.test(word)) {
        tokens.add(word);
      }
    }
  }

  return [...tokens];
}

async function checkEmoteSpam(client, channel, tags, message) {
  if (!getEventSubLiveStatus() || isSilenced() || isReactive()) return;
  const now = Date.now();
  if (now - lastEmoteCommentTime < EMOTE_COMMENT_COOLDOWN) return;

  const username = tags['display-name'];
  const tokens = extractEmoteTokens(tags, message);

  for (const token of tokens) {
    if (!recentEmoteUse.has(token)) {
      // Cap máximo de 100 tokens para evitar memory leak en streams largos
      if (recentEmoteUse.size >= 100) {
        recentEmoteUse.delete(recentEmoteUse.keys().next().value);
      }
      recentEmoteUse.set(token, []);
    }
    const entries = recentEmoteUse.get(token);
    entries.push({ user: username, ts: now });
    const fresh = entries.filter((e) => e.ts > now - EMOTE_WINDOW_MS);
    recentEmoteUse.set(token, fresh);

    const uniqueUsers = new Set(fresh.map((e) => e.user)).size;
    if (uniqueUsers >= EMOTE_SPAM_THRESHOLD) {
      lastEmoteCommentTime = now;
      recentEmoteUse.delete(token);
      client.say(channel, truncate(template('emote_spam', { token })));
      return;
    }
  }

  // Limpieza ocasional del mapa
  if (Math.random() < 0.03) {
    for (const [k, v] of recentEmoteUse) {
      const fresh = v.filter((e) => e.ts > now - EMOTE_WINDOW_MS);
      if (fresh.length === 0) recentEmoteUse.delete(k);
      else recentEmoteUse.set(k, fresh);
    }
  }
}

// --- CAPS rage detection ---
const capsMessages = []; // {user, ts}

const CAPS_WINDOW_MS = 15 * 1000;

const CAPS_THRESHOLD = 5;

let lastCapsCommentTime = 0;

const CAPS_COMMENT_COOLDOWN = 120 * 1000;

function isCapsMessage(msg) {
  // \p{L} = cualquier letra Unicode (incluye Á É Í Ó Ú Ñ)
  // \p{Lu} = letras mayúsculas Unicode
  // Nota: regex Unicode es ~3x más lento que ASCII pero
  // necesario para chats en español
  const letters = [...msg].filter((c) => /\p{L}/u.test(c));
  if (letters.length < 8) return false;
  return letters.filter((c) => /\p{Lu}/u.test(c)).length / letters.length >= 0.7;
}

async function checkCapsRage(client, channel, tags, message) {
  if (!getEventSubLiveStatus() || isSilenced() || isReactive()) return;
  if (!isCapsMessage(message)) return;
  const now = Date.now();
  if (now - lastCapsCommentTime < CAPS_COMMENT_COOLDOWN) return;

  const username = tags['display-name'];
  capsMessages.push({ user: username, ts: now });
  while (capsMessages.length > 0 && capsMessages[0].ts < now - CAPS_WINDOW_MS) capsMessages.shift();

  const uniqueUsers = new Set(capsMessages.map((e) => e.user)).size;
  if (uniqueUsers >= CAPS_THRESHOLD) {
    lastCapsCommentTime = now;
    setLastCapsRageTime(now);
    capsMessages.length = 0;
    addNarrativeEvent('rage', 'CAPS rage del chat — energía colectiva desbordada');
    client.say(channel, truncate(template('caps_rage')));
  }
}

module.exports = { checkForHighlight, checkEmoteSpam, checkCapsRage };
