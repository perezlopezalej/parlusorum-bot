// Piezas de contexto para los prompts: tono, modo de personalidad, lore, rol del usuario y emotes.
const channelConfig = require('../../config/channel.json');
const { getCurrentGame } = require('../twitch/api');
const {
  getPlayer,
  isRaidActive,
  setPersonalityMode,
  getPersonalityMode,
  getModeVariant,
  getModeSetAt,
  isBrb,
  getStreamNarrative,
  getLastCapsRageTime,
  getDeathCount,
} = require('../utils/state');
const { decideMode, resolveModeConfig, MODE_WINDOWS } = require('../utils/narrative');
const { sanitizeForAI } = require('../utils/filter');
const { getMemoryContext } = require('../memory/handler');
const { getLoreTerms } = require('../lore/handler');
const { playerLine, roleLine, dayLine } = require('./style');
const { chatHistory, getCachedUserFacts } = require('./chat-memory');
const { CREATOR_USERNAME, STREAMER_USERNAME } = require('./common');

// --- Detección de tono del mensaje (heurística, sin llamada Groq) ---
const FRUSTRATION_WORDS = [
  'mierda',
  'odio',
  'imposible',
  'no puedo',
  'otra vez',
  'siempre',
  'asco',
  'basura',
  'me cago',
  'joder',
  'inutil',
  'inútil',
];

const HYPE_WORDS = [
  'gana',
  'epico',
  'épico',
  'fua',
  'brutal',
  'increible',
  'increíble',
  'wow',
  'omg',
  'flipante',
  'gg',
];

function detectTone(message) {
  const lower = message.toLowerCase();
  const exclamations = (message.match(/!/g) || []).length;
  const questionMarks = (message.match(/\?/g) || []).length;
  const capsRatio = (message.match(/[A-ZÁÉÍÓÚÑ]/g) || []).length / Math.max(message.length, 1);
  if (FRUSTRATION_WORDS.some((w) => lower.includes(w)) && exclamations >= 1) return 'frustration';
  if (capsRatio > 0.5 && HYPE_WORDS.some((w) => lower.includes(w))) return 'hype';
  if (questionMarks >= 1) return 'question';
  return 'casual';
}

function isConfirmationTrap(msg) {
  return (
    /[¿?].{0,40}(verdad|no es así|cierto|a que sí|eh|¿sí)\s*[?]?\s*$/i.test(msg) ||
    /^(eres|eso es|está bien|mola|es genial).{0,30}[,¿?]?\s*(verdad|no|cierto)\s*[?]?\s*$/i.test(msg)
  );
}

// --- Detección de modo de personalidad ---
// Se recalcula en cada uso (personalidad, cohost, patrones): decide la narrativa del stream y caduca por la hora de cada evento
function refreshMode() {
  const now = Date.now();
  const next = decideMode({
    now,
    events: getStreamNarrative(),
    raidActive: isRaidActive(),
    brb: isBrb(),
    capsRageAt: getLastCapsRageTime(),
    recentChatCount: chatHistory.filter((m) => m.ts > now - MODE_WINDOWS.chat).length,
    prev: { mode: getPersonalityMode(), variant: getModeVariant(), setAt: getModeSetAt() },
  });
  setPersonalityMode(next.mode, next.variant);
  return next;
}

// Config del modo actual (max_chars, max_tokens, cohost_multiplier, pattern_cooldown_multiplier, prompt_extension)
function getModeConfig() {
  return resolveModeConfig(channelConfig.personality_modes, getPersonalityMode(), getModeVariant());
}

// --- Contexto de los prompts por tipo (etiquetas de style.js) ---
// Lore del canal para el cohost: la comunidad y los términos aprendidos activos
async function getLoreBlock() {
  let terms = '';
  try {
    terms = await getLoreTerms();
  } catch {
    /* sin lore aprendido */
  }
  return `<lore>La comunidad del canal son los Lusorums.${terms ? ` Términos del canal: ${terms}.` : ''}</lore>`;
}

// Contexto de menciones y !dios_fua: juego, quién juega, caídas, lore y el último stream
async function buildContextText() {
  const parts = [];
  try {
    const game = (await getCurrentGame().catch(() => null))?.game;
    const safeGame = game ? sanitizeForAI(game) : '';
    if (safeGame) parts.push(`Se está jugando a «${safeGame}».`);
  } catch {
    /* sin juego */
  }
  parts.push(playerLine(getPlayer()), dayLine());
  const deaths = getDeathCount();
  parts.push(deaths === 0 ? 'Aún sin caídas anotadas hoy.' : `${deaths} caídas anotadas hoy del streamer.`);
  parts.push('La comunidad del canal son los Lusorums.');
  try {
    const terms = await getLoreTerms();
    if (terms) parts.push(`Términos del canal: ${terms}.`);
  } catch {
    /* sin lore aprendido */
  }
  try {
    const memory = await getMemoryContext({ maxStreams: 1, summaryMax: 160, maxHighlights: 1, plain: true });
    if (memory) parts.push(`Último stream: ${memory}`);
  } catch {
    /* sin memoria */
  }
  return parts.join(' ');
}

// Quién escribe: su rol (creador, streamer, sub), la cuenta compartida ParLusorum y lo que el bot sabe de esa persona
async function buildRoleText(userType, username, userId = null) {
  const parts = [roleLine(userType, { creator: CREATOR_USERNAME, streamer: STREAMER_USERNAME })];
  if (String(username || '').toLowerCase() === 'parlusorum')
    parts.push('Escribe la cuenta ParLusorum, casi seguro Pao (o Manu).');
  if (username) {
    try {
      const facts = (await getCachedUserFacts(userId))
        .map((f) => `${f.fact_type}: ${sanitizeForAI(String(f.value))}`)
        .filter((line) => line.split(': ')[1]);
      if (facts.length) parts.push(`Datos del usuario: ${facts.join(', ')}.`);
    } catch {
      /* sin datos del usuario */
    }
  }
  return parts.filter(Boolean).join(' ');
}

// Tono del mensaje del usuario, en positivo
function buildToneText(question) {
  const tone = detectTone(question);
  const narrative = getStreamNarrative();
  const manyDeaths =
    narrative.filter((e) => e.type === 'death').length >= 3 && !narrative.some((e) => e.type === 'victory');
  const parts = [];
  if (tone === 'frustration')
    parts.push(
      manyDeaths
        ? 'Suena frustrado y hay muchas caídas seguidas: responde con empatía y ánimo real, en serio.'
        : 'Suena frustrado: responde con empatía y ánimo.',
    );
  else if (tone === 'hype') parts.push('Está emocionado: responde con energía.');
  if (isConfirmationTrap(question)) parts.push('Busca que le des la razón: responde con tu criterio real.');
  return parts.join(' ');
}

const emoteLineFor = (allowEmote, emotes) =>
  allowEmote ? `Puedes cerrar con un emote de esta lista: ${emotes.join(', ')}.` : 'Escribe solo texto.';

module.exports = {
  refreshMode,
  getModeConfig,
  getLoreBlock,
  emoteLineFor,
  buildContextText,
  buildRoleText,
  buildToneText,
};
