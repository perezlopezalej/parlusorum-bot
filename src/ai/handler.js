const channelConfig = require('../../config/channel.json');
const messagesConfig = require('../../config/messages.json');
const identityReplies = require('../../config/identity-replies.json');
const { getCurrentGame, getGameInfo, lookupGameInfo, getStreamInfo, createStreamMarker, getChannelInfo } = require('../twitch/api');
const { getPlayer, isFreeCohostPaused, pauseFreeCohost, isTriviaActive, isSilenced, setTriviaActive, isRaidActive, getRaidUsername, setPersonalityMode, getPersonalityMode, getModeVariant, getModeSetAt, isBrb, addNarrativeEvent, getStreamNarrative, setGameContextFailed, getGameContextFailed, setLastCapsRageTime, getLastCapsRageTime, getBotHistory, addBotMessage, recordCohostAttempt, recordCohostSent, getStreamIsLive, addLoreSample, noteChatter, resetLoreSample, getLastCohostContextHash, setLastCohostContextHash, getDeathCount, getBossCount, markStructure, getUsedStructures, getStreamStartedAt, recordCohost, recordCohostDiscard, getLastCohostTime, getCohostTimes, claimHookPause, markNamed, getNamedUsers, noteMentionFua, getMentionFuaHistory, claimStartAnnouncement, resetStartAnnouncement, onNarrativeEvent, addCohostText, getCohostTexts } = require('../utils/state');
const { windowFacts, mergeBossMoments, bossInBatch, BOSS_SETTLE_MS } = require('../utils/narrative');
const { buildStoryBlock, condenseChat, decideMode, resolveModeConfig, MODE_WINDOWS, classifyCohostMoment, eventCohostAllowed, eventExpired, freeCohostDue, pruneHourly, EVENT_COHOST_MAX_PER_HOUR, EVENT_QUEUE_TTL_MS, FREE_COHOST_INTERVAL_MS, FREE_COHOST_ACTIVITY_WINDOW_MS, FREE_COHOST_MIN_MESSAGES, FREE_COHOST_MAX_PER_HOUR, streakAllowed, STREAK_COHOST_GAP_MS, hourlyCapReached, pickFreeTopic } = require('../utils/narrative');
const factcheck = require('./factcheck');
const { pickBest } = require('./pick-best');
const { buildGameTemplate } = require('./game-template');
const { buildGameSheet, leaksSheetRaw } = require('./game-sheet');
const { classifyMessage, cooldownMs, cooldownGate, provocationGate, mentionBudget, isStale } = require('./patterns');
const { translateGenres } = require('../utils/genres');
const quality = require('./quality');
const { sanitizeForAI } = require('../utils/filter');
const { classifyGameMatch, recoverTruncatedName } = require('../utils/game-match');
const { canMakeRequest, canUserMakeRequest } = require('../utils/ratelimit');
const { getMemoryContext } = require('../memory/handler');
const { getLoreTerms } = require('../lore/handler');
const { playerLine, roleLine, dayLine, buildHookSystem, buildShoutoutSystem, buildQueMePerdiSystem, pickCohostForm, buildProvocationSystem, buildCohostSystem, buildMentionSystem, buildQuestionSystem, parseCandidates, rankCandidates, retryNote } = require('./style');
const { persistCooldown, getRecentSessionDeaths, countSessionsOfGame } = require('../utils/supabase');
const logger = require('../utils/logger');
const chatlog = require('../utils/chatlog');
const { saveHighlight } = require('../utils/storage');
const { truncate, TWITCH_MAX_LENGTH } = require('../utils/groq-utils');
const { aiChat } = require('../utils/ai-router');
const { getViewersWithAppToken } = require('../eventsub');
const { throttleSay } = require('../alerts/handler');
// Cohost: los eventos (jefe, muerte, sub...) se comentan siempre y esperan en cola hasta EVENT_TTL_MS; los comentarios libres
// van por reloj (FREE_INTERVAL_MS, con chat activo). MAX_PER_HOUR / FREE_MAX_PER_HOUR son solo frenos de seguridad.
// NAME_WINDOW = tiempo sin volver a nombrar al mismo usuario. Los silencios los cubre el hook, no el cohost.
const COHOST_EVENT_TTL = parseInt(process.env.COHOST_EVENT_TTL_MS || String(EVENT_QUEUE_TTL_MS), 10);
const COHOST_FREE_INTERVAL = parseInt(process.env.COHOST_FREE_INTERVAL_MS || String(FREE_COHOST_INTERVAL_MS), 10);
const COHOST_STREAK_GAP = parseInt(process.env.COHOST_STREAK_GAP_MS || String(STREAK_COHOST_GAP_MS), 10);
const COHOST_FREE_MAX_PER_HOUR = parseInt(process.env.COHOST_FREE_MAX_PER_HOUR || String(FREE_COHOST_MAX_PER_HOUR), 10);
const COHOST_MAX_PER_HOUR = parseInt(process.env.COHOST_MAX_PER_HOUR || String(EVENT_COHOST_MAX_PER_HOUR), 10);
const COHOST_NAME_WINDOW = parseInt(process.env.COHOST_NAME_WINDOW_MS || '900000', 10);
const COHOST_CANDIDATES = parseInt(process.env.COHOST_CANDIDATES || '2', 10) === 3 ? 3 : 2; // candidatos por llamada del cohost (2 por defecto: en la prueba 2 bastan y gastan menos tokens)
// Provocaciones: solo la primera de cada usuario en esta ventana recibe réplica
const PROVOCATION_WINDOW = parseInt(process.env.PROVOCATION_WINDOW_MS || '600000', 10);
// Menciones: máximo MENTION_MAX_PER_USER respuestas por usuario cada MENTION_WINDOW_MS; una respuesta que lleva
// más de MENTION_MAX_AGE_MS esperando (IA + cola IRC) se descarta en vez de salir tarde
const MENTION_MAX_PER_USER = parseInt(process.env.MENTION_MAX_PER_USER || '3', 10);
const MENTION_WINDOW = parseInt(process.env.MENTION_WINDOW_MS || '300000', 10);
const MENTION_MAX_AGE_MS = 20000;
const PROVOCATION_MAX_RETRY_DELAY_MS = 3000; // una réplica tardía se descarta (MENTION_MAX_AGE_MS): mejor la de reserva al momento
const MENTION_MAX_RETRY_DELAY_MS = 5000;
const GENERAL_TEMPERATURE = 0.3; // cultura general: menos creatividad, menos datos inventados
const MENTION_MAX_CHARS = 200; // tope de las respuestas a menciones (con el @usuario), recortadas en final de frase
const QUESTION_COOLDOWN_MS = parseInt(process.env.QUESTION_COOLDOWN_MS || '10000', 10);

// FIX #1: roles claramente definidos
const CREATOR_USERNAME = (channelConfig.creator_username || '').toLowerCase();
const STREAMER_USERNAME = (channelConfig.streamer_username || '').toLowerCase();

// --- Fallbacks en personaje por tipo de error (textos en config/messages.json) ---
const FALLBACK_RESPONSES = messagesConfig.fallback_responses;

function getFallback(type, mention = '') {
  const pool = FALLBACK_RESPONSES[type] || FALLBACK_RESPONSES.error;
  const msg = pool[Math.floor(Math.random() * pool.length)];
  return mention ? `${mention} ${msg}` : msg;
}

function getEventSubLiveStatus() { return getStreamIsLive(); }

const userFactsCache = new Map();
const USER_FACTS_TTL = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of userFactsCache) if (now - v.ts > USER_FACTS_TTL) userFactsCache.delete(k);
}, USER_FACTS_TTL);

// Por user_id de Twitch (los hechos no se guardan por nick). Sin id no hay datos.
async function getCachedUserFacts(userId) {
  if (!userId) return [];
  const key = String(userId);
  const cached = userFactsCache.get(key);
  if (cached && Date.now() - cached.ts < USER_FACTS_TTL) return cached.data;
  const { getUserFacts, getUserCounter } = require('../utils/supabase');
  const [facts, wins] = await Promise.all([getUserFacts(key), getUserCounter(key, 'trivia_wins')]);
  // trivia_wins es un contador sin caducidad: se lee aparte del filtro de 30 días
  const data = [...facts.filter(f => f.fact_type !== 'trivia_wins'), ...(wins > 0 ? [{ fact_type: 'trivia_wins', value: String(wins) }] : [])];
  userFactsCache.set(key, { data, ts: Date.now() });
  return data;
}

function clearUserFactsCache() { userFactsCache.clear(); }

// --- Usuarios activos en el stream actual ---
const activeUsersThisStream = new Set();
const activeUserIds = new Map(); // nick en minúsculas → user_id de Twitch
const streamMessageCounts = new Map();

function trackActiveUser(username, userId = null) {
  if (!username) return;
  const lc = username.toLowerCase();
  activeUsersThisStream.add(lc);
  if (userId) activeUserIds.set(lc, String(userId));
}

// { nick: user_id } de los usuarios activos que tienen id (para guardar sus hechos por id)
function getActiveUserIds() {
  return Object.fromEntries(activeUserIds);
}

function getActiveUsers() {
  return [...activeUsersThisStream];
}

const MIN_REGULAR_MESSAGES = 3;
function getActiveUsersWithMinMessages(minCount = MIN_REGULAR_MESSAGES) {
  return [...activeUsersThisStream].filter(u => (streamMessageCounts.get(u) || 0) >= minCount);
}

function resetActiveUsers() {
  activeUsersThisStream.clear();
  activeUserIds.clear();
  streamMessageCounts.clear();
  userConversations.clear();
  setLastCohostContextHash('');
}
const chatHistory = [];
const MAX_HISTORY = 40;
const streamChatBuffer = [];
const MAX_STREAM_BUFFER = 50;
let lastChatMessageTime = Date.now();
const MAX_CONVERSATION_USERS = 200;

function addToHistory(username, message, userId = null) {
  if (message.startsWith('!')) return;
  // No guardar mensajes del propio bot en el historial
  if ((username || '').toLowerCase() === (process.env.BOT_USERNAME || '').toLowerCase()) return;
  const safe = sanitizeForAI(message);
  if (!safe) return;
  noteChatter(username);
  chatHistory.push({ username, message: safe, ts: Date.now() });
  if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
  streamChatBuffer.push({ username, message: safe });
  if (streamChatBuffer.length > MAX_STREAM_BUFFER) streamChatBuffer.shift();
  addLoreSample(username, safe, userId);
  lastChatMessageTime = Date.now();
  trackActiveUser(username, userId);
  const lc = (username || '').toLowerCase();
  streamMessageCounts.set(lc, (streamMessageCounts.get(lc) || 0) + 1);
}

function updateLastChatTime() { lastChatMessageTime = Date.now(); }

// Mensajes del chat de los últimos windowMs (sin comandos ni bots), del más antiguo al más reciente
function getChatWindow(windowMs = 30 * 60 * 1000, now = Date.now()) {
  return chatHistory.filter(m => now - m.ts <= windowMs).map(m => ({ username: m.username, message: m.message }));
}

function getRecentHistory(n = 6) {
  const cutoff = Date.now() - 10 * 60 * 1000;
  return chatHistory
    .filter(m => m.ts > cutoff)
    .slice(-n)
    .map(m => `${m.username}: ${quality.cleanChatNoise(m.message)}`)
    .join('\n');
}

// --- Memoria de conversacion por usuario ---
const userConversations = new Map();
const sessionStart = Date.now();
const MAX_CONV_TURNS = 5;
const MAX_CONV_AGE = 60 * 60 * 1000;

function getUserConversation(userId) {
  const conv = userConversations.get(userId) || [];
  const cutoff = Date.now() - MAX_CONV_AGE;
  return conv
    .filter(m => m.ts > sessionStart && m.ts > cutoff)
    .map(({ role, content }) => ({ role, content }));
}

function addToUserConversation(userId, role, content) {
  if (userConversations.size >= MAX_CONVERSATION_USERS) {
    const oldest = [...userConversations.entries()]
      .sort((a, b) => (a[1].at(-1)?.ts || 0) - (b[1].at(-1)?.ts || 0))
      .slice(0, 50)
      .map(([k]) => k);
    oldest.forEach(k => userConversations.delete(k));
  }
  const conv = userConversations.get(userId) || [];
  conv.push({ role, content, ts: Date.now() });
  while (conv.length > MAX_CONV_TURNS * 2) conv.shift();
  userConversations.set(userId, conv);
}

// Privacidad (!fua_olvidame): borra de la RAM todo lo de un usuario. Devuelve cuántas cosas quitó.
function forgetUserInMemory({ userId, login }) {
  const nick = String(login || '').toLowerCase();
  let removed = 0;
  const mine = m => !!nick && String(m.username || '').toLowerCase() === nick;
  for (const arr of [chatHistory, streamChatBuffer]) {
    for (let i = arr.length - 1; i >= 0; i--) if (mine(arr[i])) { arr.splice(i, 1); removed++; }
  }
  if (userId) {
    const id = String(userId);
    if (userConversations.delete(id)) removed++;
    if (userFactsCache.delete(id)) removed++;
    if (questionCooldowns.delete(id)) removed++;
  }
  if (nick) {
    if (userConversations.delete(nick)) removed++;
    if (activeUsersThisStream.delete(nick)) removed++;
    activeUserIds.delete(nick);
    streamMessageCounts.delete(nick);
  }
  return removed;
}

const recentMessages = [];
function trackMessage() {
  const now = Date.now();
  recentMessages.push(now);
  while (recentMessages.length > 0 && recentMessages[0] < now - 60000) recentMessages.shift();
  return recentMessages.length;
}

// --- Detección de tono del mensaje (heurística, sin llamada Groq) ---
const FRUSTRATION_WORDS = ['mierda', 'odio', 'imposible', 'no puedo', 'otra vez', 'siempre', 'asco', 'basura', 'me cago', 'joder', 'inutil', 'inútil'];
const HYPE_WORDS = ['gana', 'epico', 'épico', 'fua', 'brutal', 'increible', 'increíble', 'wow', 'omg', 'flipante', 'gg'];

function detectTone(message) {
  const lower = message.toLowerCase();
  const exclamations = (message.match(/!/g) || []).length;
  const questionMarks = (message.match(/\?/g) || []).length;
  const capsRatio = (message.match(/[A-ZÁÉÍÓÚÑ]/g) || []).length / Math.max(message.length, 1);
  if (FRUSTRATION_WORDS.some(w => lower.includes(w)) && exclamations >= 1) return 'frustration';
  if (capsRatio > 0.5 && HYPE_WORDS.some(w => lower.includes(w))) return 'hype';
  if (questionMarks >= 1) return 'question';
  return 'casual';
}

function isConfirmationTrap(msg) {
  return /[¿?].{0,40}(verdad|no es así|cierto|a que sí|eh|¿sí)\s*[?]?\s*$/i.test(msg)
    || /^(eres|eso es|está bien|mola|es genial).{0,30}[,¿?]?\s*(verdad|no|cierto)\s*[?]?\s*$/i.test(msg);
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
    recentChatCount: chatHistory.filter(m => m.ts > now - MODE_WINDOWS.chat).length,
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
  try { terms = await getLoreTerms(); } catch { /* sin lore aprendido */ }
  return `<lore>La comunidad del canal son los Lusorums.${terms ? ` Términos del canal: ${terms}.` : ''}</lore>`;
}

// Contexto de menciones y !dios_fua: juego, quién juega, caídas, lore y el último stream
async function buildContextText() {
  const parts = [];
  try {
    const game = (await getCurrentGame().catch(() => null))?.game;
    const safeGame = game ? sanitizeForAI(game) : '';
    if (safeGame) parts.push(`Se está jugando a «${safeGame}».`);
  } catch { /* sin juego */ }
  parts.push(playerLine(getPlayer()), dayLine());
  const deaths = getDeathCount();
  parts.push(deaths === 0 ? 'Aún sin caídas anotadas hoy.' : `${deaths} caídas anotadas hoy del streamer.`);
  parts.push('La comunidad del canal son los Lusorums.');
  try {
    const terms = await getLoreTerms();
    if (terms) parts.push(`Términos del canal: ${terms}.`);
  } catch { /* sin lore aprendido */ }
  try {
    const memory = await getMemoryContext({ maxStreams: 1, summaryMax: 160, maxHighlights: 1, plain: true });
    if (memory) parts.push(`Último stream: ${memory}`);
  } catch { /* sin memoria */ }
  return parts.join(' ');
}

// Quién escribe: su rol (creador, streamer, sub), la cuenta compartida ParLusorum y lo que el bot sabe de esa persona
async function buildRoleText(userType, username, userId = null) {
  const parts = [roleLine(userType, { creator: CREATOR_USERNAME, streamer: STREAMER_USERNAME })];
  if (String(username || '').toLowerCase() === 'parlusorum') parts.push('Escribe la cuenta ParLusorum, casi seguro Pao (o Manu).');
  if (username) {
    try {
      const facts = (await getCachedUserFacts(userId))
        .map(f => `${f.fact_type}: ${sanitizeForAI(String(f.value))}`)
        .filter(line => line.split(': ')[1]);
      if (facts.length) parts.push(`Datos del usuario: ${facts.join(', ')}.`);
    } catch { /* sin datos del usuario */ }
  }
  return parts.filter(Boolean).join(' ');
}

// Tono del mensaje del usuario, en positivo
function buildToneText(question) {
  const tone = detectTone(question);
  const narrative = getStreamNarrative();
  const manyDeaths = narrative.filter(e => e.type === 'death').length >= 3 && !narrative.some(e => e.type === 'victory');
  const parts = [];
  if (tone === 'frustration') parts.push(manyDeaths ? 'Suena frustrado y hay muchas caídas seguidas: responde con empatía y ánimo real, en serio.' : 'Suena frustrado: responde con empatía y ánimo.');
  else if (tone === 'hype') parts.push('Está emocionado: responde con energía.');
  if (isConfirmationTrap(question)) parts.push('Busca que le des la razón: responde con tu criterio real.');
  return parts.join(' ');
}

const emoteLineFor = (allowEmote, emotes) => (allowEmote ? `Puedes cerrar con un emote de esta lista: ${emotes.join(', ')}.` : 'Escribe solo texto.');

const NARRATOR_BASE = (game = '') => {
  const botName = process.env.BOT_USERNAME || 'dios_fua';
  const emotes = (channelConfig.channel_emotes || []).join(', ');
  return `Eres ${botName}, narrador en directo del canal de ${channelConfig.streamer}. Estilo: voz de Dios Fua — enérgico, con guasa y cariño, en primera persona. ${game} Emotes si encajan: ${emotes}. SIEMPRE en español. 1-2 frases. Sin presentarte.`;
};

function getUserType(username, tags) {
  const lower = username.toLowerCase();
  if (CREATOR_USERNAME && lower === CREATOR_USERNAME) return 'creator';
  if (STREAMER_USERNAME && lower === STREAMER_USERNAME) return 'streamer';
  if (tags?.mod || tags?.['user-type'] === 'mod' || tags?.badges?.moderator) return 'mod';
  if (tags?.subscriber || tags?.badges?.subscriber || tags?.badges?.founder) return 'sub';
  return 'normal';
}

// --- Co-host ---
let cohostRunning = false;

function detectChatMood(messages) {
  const text = messages.join(' ').toLowerCase();
  const hype = ['jaja','lol','gg','pog','hype','vamo','goat','omg','wow','ez',
                'pepehype','pogchamp','pepega','luego','siuu'];
  const frustracion = ['oof','no','mal','wtf','otra vez','siempre','muerto',
                       'nooo','noooo','rip','gg ez','mentira','dios mio'];
  const hypeCount = hype.filter(w => text.includes(w)).length;
  const frustCount = frustracion.filter(w => text.includes(w)).length;
  if (hypeCount >= 2) return 'HYPE';
  if (frustCount >= 2) return 'FRUSTRACIÓN';
  return 'NEUTRO';
}

// Cohost: habla cuando pasa algo destacado (`moment`, siempre, en cola) y, por reloj, reaccionando a lo que se habla en el chat.
// runCohost devuelve 'sent' | 'dropped' | 'retry' (retry = ahora no puede; se reintenta mientras el evento no caduque).
// La respuesta se valida en código: lo grave (inventos del juego, muertes, latam, robot) se descarta tras un reintento; lo leve
// (nombre repetido, fórmula, parecido, ambiente) se reintenta una vez y si persiste se envía igual. Después, la comprobación
// SÍ/NO del modelo rápido, solo si el mensaje habla del juego.
let freeCohostTimes = []; // cupo compartido: comentarios libres + rachas de muertes ENVIADOS en la última hora (máx. COHOST_FREE_MAX_PER_HOUR)
let freeAttemptTimes = []; // intentos de comentario libre (enviados o no): solo freno de seguridad para los reintentos
const FREE_ATTEMPTS_MAX_PER_HOUR = 8;
let lastCohostForm = ''; // id de la última forma del cohost (rota, no se repite seguida)
let lastFreeTopic = ''; // id del último tema del cohost libre enviado (rota, no se repite seguido)
let lastSharedAt = 0;    // último comentario enviado del cupo compartido (libre o racha)
let deathRecordCache = { at: 0, max: 0 };

// Máximo de muertes de los streams anteriores (para detectar el récord); caché de 30 min
async function getDeathRecord() {
  const now = Date.now();
  if (now - deathRecordCache.at < 30 * 60 * 1000) return deathRecordCache.max;
  const rows = await getRecentSessionDeaths(30).catch(() => []);
  deathRecordCache = { at: now, max: rows.reduce((m, r) => Math.max(m, Number.isFinite(r.death_count) ? r.death_count : 0), 0) };
  return deathRecordCache.max;
}

// Mensajes dirigidos con @ a otro usuario (no al bot ni al streamer): conversación entre ellos, no del cohost
const BOT_LOGIN = (process.env.BOT_USERNAME || 'dios_fua').toLowerCase();
function isDirectedElsewhere(message) {
  const m = /^\s*@(\w+)/.exec(String(message || ''));
  if (!m) return false;
  const login = m[1].toLowerCase();
  return login !== BOT_LOGIN && login !== STREAMER_USERNAME && login !== 'parlusorum';
}

// Chat reciente sin las conversaciones privadas entre usuarios (para los comentarios libres)
function publicChatContext(n = 5) {
  const cutoff = Date.now() - 10 * 60 * 1000;
  return chatHistory
    .filter(m => m.ts > cutoff && !isDirectedElsewhere(m.message))
    .slice(-n)
    .map(m => `${m.username}: ${quality.cleanChatNoise(m.message)}`)
    .join('\n');
}

// Si la mayoría de los últimos mensajes son charla entre dos usuarios, el cohost libre no entra
function isPrivateExchange(now = Date.now(), window = 6, min = 3) {
  const last = chatHistory.filter(m => m.ts > now - 5 * 60 * 1000).slice(-window);
  return last.filter(m => isDirectedElsewhere(m.message)).length >= min;
}

async function runCohost(client, channel, moment = null) {
  const kind = moment ? 'event' : 'free';
  const kindKey = moment ? moment.kind : 'free';
  if (!getEventSubLiveStatus()) return 'dropped';
  const blocked = isSilenced() ? 'silencio' : isBrb() ? 'brb' : isTriviaActive() ? 'trivia' : null;
  if (blocked) {
    if (moment) { recordCohostAttempt(kind); recordCohostDiscard(blocked); }
    return 'dropped';
  }
  if (cohostRunning) return moment ? 'retry' : 'dropped';
  const now = Date.now();
  if (!moment && isFreeCohostPaused(now)) return 'dropped';
  if (moment && !eventCohostAllowed({ now, lastAt: getLastCohostTime(), stamps: getCohostTimes(), max: COHOST_MAX_PER_HOUR })) return 'retry';
  // Las rachas de muertes comparten cupo con los comentarios libres (~4/h como máximo): fuera de cupo se descartan, no esperan en cola
  const isStreak = moment?.kind === 'streak';
  if (isStreak && !streakAllowed({ now, lastSharedAt, sharedStamps: freeCohostTimes, gapMs: COHOST_STREAK_GAP, max: COHOST_FREE_MAX_PER_HOUR })) {
    recordCohostAttempt(kind); recordCohostDiscard('racha_cupo');
    logger.info('Co-host: racha de muertes sin comentar (cupo compartido con los libres)');
    return 'dropped';
  }
  if (!canMakeRequest()) {
    if (moment) return 'retry';
    recordCohostAttempt(kind); recordCohostDiscard('ratelimit');
    return 'dropped';
  }
  const recentContext = moment ? getRecentHistory(5) : publicChatContext(5);
  if (!moment && !recentContext) return 'dropped';
  // Alguien dice que está mal o de bajón: el cohost libre no bromea con eso (calla)
  if (!moment && quality.hasPersonalDistress(recentContext)) { logger.info('Co-host libre: calla (alguien comenta que está mal)'); return 'dropped'; }
  if (!moment && isPrivateExchange(now)) { recordCohostAttempt(kind); recordCohostDiscard('privado'); return 'dropped'; }

  recordCohostAttempt(kind);
  if (!moment) freeAttemptTimes = pruneHourly([...freeAttemptTimes, now]);
  refreshMode();
  const modeConfig = getModeConfig();
  const recentBot = getBotHistory().map(e => e.msg);
  const emotes = channelConfig.channel_emotes || [];
  const allowEmote = quality.emoteAllowed(recentBot, emotes);
  const deathCount = getDeathCount();
  const named = getNamedUsers();
  const namesAllowed = !!moment && (moment.kind === 'sub' || moment.kind === 'raid');

  cohostRunning = true;
  let reason = 'error';

  try {
    const gameInfo = await getCurrentGame();
    const mood = detectChatMood(chatHistory.slice(-10).map(m => m.message || ''));
    const startedAt = getStreamStartedAt();
    const minutes = startedAt ? Math.floor((now - startedAt) / 60000) : null;
    const baseDeathLine = deathCount === 0 ? 'Aún sin caídas anotadas: el tema es la partida, el chat o el FUA.' : `${deathCount} ${deathCount === 1 ? 'caída anotada' : 'caídas anotadas'}.`;
    const raidLine = isRaidActive() ? ` Acaba de llegar una raid de @${getRaidUsername()}: los raiders son visitantes de otro canal, no los espectadores del directo.` : '';
    const nameLine = namesAllowed ? 'Puedes nombrar a quien aparece en el suceso.' : 'Dirígete a Manu o al chat en general.';
    const emoteLine = emoteLineFor(allowEmote, emotes);
    const loreBlock = await getLoreBlock();
    const windowLines = chatHistory.filter(m => m.ts > now - 5 * 60 * 1000).slice(-25);
    const chatSummary = condenseChat(windowLines);
    const maxChars = modeConfig.max_chars ?? TWITCH_MAX_LENGTH;
    // Ficha del juego actual (caché de IGDB) para que el revisor reconozca como respaldados el año, el estudio o el género
    const gameFacts = gameInfo?.game ? factcheck.gameFactsText((await lookupGameInfo(gameInfo.game, { detail: true }).catch(() => ({}))).info) : '';
    const facts = `Juego: ${gameInfo?.game || 'desconocido'}. Muertes anotadas: ${deathCount}. ${gameFacts} ${moment ? `Suceso: ${moment.description}. ` : ''}Chat reciente: ${recentContext}`;

    // El número de muertes no se cita en dos mensajes seguidos del bot (salvo en la primera muerte y el récord, que son el dato)
    const countIsTheNews = moment && ['first_death', 'record'].includes(moment.kind);
    const lastCitedDeaths = !countIsTheNews && quality.citesDeathCount(recentBot[recentBot.length - 1] || '', deathCount);
    const deathLine = `${baseDeathLine}${lastCitedDeaths ? ' Esta vez deja fuera la cifra de caídas.' : ''}${raidLine}`;
    const validateCtx = { player: getPlayer(), deathCount, recent: recentBot, sameKind: getCohostTexts(kindKey), named: namesAllowed ? new Map() : named, now, nameWindowMs: COHOST_NAME_WINDOW, usedStructures: getUsedStructures(), lastCitedDeaths, game: gameInfo?.game || '' };
    // Revisión en una llamada: datos del juego (si habla de él) y sentido/redacción
    // Lo que genera Gemini no pasa por la revisión de sentido por IA (solo reglas de quality.js y factcheck si habla del juego)
    let generatorModel; // modelo que escribió los candidatos: el selector es de otra familia
    const reviewText = async (text, { sense = true } = {}) => {
      const review = await factcheck.evaluate(text, facts, { game: gameInfo?.game, sense });
      if (review.discard) {
        logger.info(`Co-host descartado (datos del juego sin respaldo): ${text.slice(0, 80)}`);
        return { ok: false, reason: 'factcheck' };
      }
      if (review.nonsense) {
        logger.info(`Co-host descartado (sin sentido o mal escrito): ${text.slice(0, 80)}`);
        return { ok: false, reason: 'sentido' };
      }
      return { ok: true };
    };
    // Un candidato listo para validar: recorte, política de emotes y, si abre con un nombre ya citado, sin él
    const prepare = candidate => {
      let text = quality.applyEmotePolicy(truncate(candidate, maxChars), allowEmote, emotes);
      if (!namesAllowed) {
        const repeated = quality.recentlyNamedIn(text, named, now, COHOST_NAME_WINDOW);
        const stripped = repeated.length ? quality.stripLeadingNames(text, repeated) : null;
        if (stripped) text = stripped;
      }
      return text;
    };

    let reply = '';
    let fixKey = ''; // regla fallida del intento anterior: el reintento recibe solo la corrección en positivo
    const form = pickCohostForm(lastCohostForm); // la forma cambia en cada comentario, sin repetir la anterior
    lastCohostForm = form.id;
    // Cohost libre: el código elige el tema (rotando) y el modelo solo devuelve la lista vacía si de verdad no puede hablar de él
    const topicCtx = { minutes: minutes || 0, bosses: getBossCount(), game: gameInfo?.game || '', deathCount, canCiteDeaths: !lastCitedDeaths };
    let freeTopic = moment ? null : pickFreeTopic({ ...topicCtx, last: lastFreeTopic });
    for (let attempt = 0; attempt < 2 && !reply; attempt++) {
      if (attempt > 0 && !canMakeRequest()) { reason = 'ratelimit'; break; }
      const system = buildCohostSystem({ game: gameInfo?.game || '', minutes, deathLine, player: getPlayer(), mood, form, emoteLine, nameLine, loreBlock, candidates: COHOST_CANDIDATES, modeLine: modeConfig.prompt_extension, event: !!moment, weekday: !getUsedStructures().has('dia-semana') }) + retryNote(fixKey);
      const chatBlock = recentContext ? `<chat>\n${recentContext}\n</chat>` : '';
      const user = moment
        ? `<suceso>${moment.description}</suceso>\n${chatBlock}\nComenta el suceso.`
        : `${chatBlock}${chatSummary ? `\n<resumen_chat>${chatSummary}</resumen_chat>` : ''}${buildStoryBlock(getStreamNarrative(), now)}\n<tema>${freeTopic.note}</tema>\nComenta el tema.`;
      const response = await aiChat('cohost', { max_tokens: 220, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
      generatorModel = response._ai?.model;
      const raw = (response.choices[0].message.content || '').trim();
      const candidates = /^SKIP\b/i.test(raw) ? [] : parseCandidates(raw, COHOST_CANDIDATES);
      if (!candidates.length) {
        if (moment) { fixKey = 'vacio'; reason = 'quality:vacio'; continue; }
        recordCohostDiscard('skip'); // cuenta cada lista vacía del modelo (sale en el resumen de fin de stream)
        if (attempt === 0) { // segundo intento con otro tema
          freeTopic = pickFreeTopic({ ...topicCtx, last: freeTopic.id });
          logger.info(`Co-host: sin candidatos, reintento con otro tema (${freeTopic.id})`);
          continue;
        }
        reason = 'sin_tema'; logger.info('Co-host: sin tema tras el reintento'); break;
      }
      // El código elige: pasa todos los filtros y es el que menos se parece a los últimos mensajes del bot
      const { ranked, failures } = rankCandidates(candidates.map(prepare), { validate: t => quality.validateCohost(t, validateCtx), recent: recentBot });
      for (const f of failures) logger.info(`Co-host descartado (${f.reason}): ${f.text.slice(0, 80)}`);
      if (ranked.length) {
        // Un modelo pequeño elige el mejor comparándolos con el chat y el juego, o dice que ninguno vale (entonces se calla)
        const pick = await pickBest(ranked.map(r => r.text), {
          dayLine: dayLine(new Date(now)),
          game: gameInfo?.game || '',
          facts: `Caídas anotadas: ${deathCount}. Juega ${getPlayer() === 'pao' ? 'Pao' : 'Manu'}.${minutes != null ? ` Llevan ${quality.approxDuration(minutes)} de directo.` : ''}${moment ? ` Suceso: ${moment.description}.` : ''}`,
          chat: getRecentHistory(8),
          activity: chatHistory.filter(m => m.ts > now - 5 * 60 * 1000).length,
          generator: generatorModel,
        });
        if (pick.status === 'ok') {
          const chosen = ranked[pick.index].text;
          const review = await reviewText(chosen, { sense: false }); // el sentido ya lo ha mirado el selector: aquí solo los datos del juego
          if (review.ok) reply = chosen;
          else { fixKey = review.reason; reason = review.reason; }
        } else if (pick.status === 'none') {
          logger.info('Co-host: el selector no ve bueno ningún candidato');
          fixKey = 'selector'; reason = 'selector';
        } else { // el selector no pudo (cupo o fallo): orden del código y la revisión de siempre
          for (const candidate of ranked.slice(0, 2)) {
            const review = await reviewText(candidate.text);
            if (review.ok) { reply = candidate.text; break; }
            fixKey = review.reason; reason = review.reason;
          }
        }
      }
      if (!reply && !ranked.length) {
        const counts = {};
        for (const f of failures) counts[f.rule] = (counts[f.rule] || 0) + 1;
        fixKey = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 'vacio';
        reason = `quality:${fixKey}`;
      }
    }

    if (!reply) { recordCohostDiscard(reason); return 'dropped'; } // los candidatos fallaron: se calla
    if (freeTopic) lastFreeTopic = freeTopic.id;
    client.say(channel, reply, { origin: 'cohost' });
    addBotMessage(reply);
    addCohostText(kindKey, reply);
    for (const key of quality.streamMarks(reply, gameInfo?.game || '')) markStructure(key);
    markNamed(quality.namesIn(reply, [...chatHistory.slice(-60).map(m => m.username), 'pao']));
    recordCohost();
    recordCohostSent(kind);
    if (isStreak || !moment) { // cupo compartido: solo cuentan los enviados (un SKIP o un descarte no gasta cupo)
      lastSharedAt = Date.now(); lastFreeAt = lastSharedAt; // el reloj de los libres vuelve a empezar
      freeCohostTimes = pruneHourly([...freeCohostTimes, lastSharedAt]);
    }
    return 'sent';
  } catch (err) {
    logger.error(`Co-host: ${err.message}`);
    recordCohostDiscard(err.status === 429 ? 'groq429' : 'error');
    return 'dropped';
  } finally { cohostRunning = false; }
}

// Compatibilidad: un único comentario inmediato (evento o libre); devuelve true si habló
async function handleCohost(client, channel, moment = null) {
  return (await runCohost(client, channel, moment)) === 'sent';
}

// Cola de eventos: se comentan todos, de uno en uno; los que esperan más de COHOST_EVENT_TTL caducan
const EVENT_QUEUE_MAX = 6;
const EVENT_SETTLE_MS = 3000; // deja que salga antes el mensaje propio del evento (alerta, contador...)
let eventQueue = [];
let drainTimer = null;
let draining = false;

function scheduleDrain(ms) {
  if (drainTimer) return;
  drainTimer = setTimeout(() => { drainTimer = null; drainEventQueue().catch(err => logger.warn(`Cola de cohost: ${err.message}`)); }, ms);
  drainTimer.unref?.();
}

// Jefes seguidos: varios !boss en ~2 min se comentan una sola vez (el primero espera BOSS_SETTLE_MS por si llegan más)
let lastBossAt = 0;
const BOSS_SETTLE = parseInt(process.env.COHOST_BOSS_SETTLE_MS || String(BOSS_SETTLE_MS), 10);
function enqueueCohostMoment(client, channel, moment, now = Date.now()) {
  if (moment.kind === 'boss') {
    const inBatch = bossInBatch(lastBossAt, now);
    lastBossAt = now;
    if (inBatch) {
      const pending = eventQueue.find(i => i.moment.kind === 'boss' && !i.started);
      if (pending) {
        pending.moment = mergeBossMoments(pending.moment, moment, getBossCount());
        pending.notBefore = now + BOSS_SETTLE;
        scheduleDrain(BOSS_SETTLE);
      } else { recordCohostAttempt('event'); recordCohostDiscard('jefe_seguido'); } // la tanda ya se comentó
      return;
    }
    eventQueue.push({ client, channel, moment, queuedAt: now, notBefore: now + BOSS_SETTLE });
    scheduleDrain(BOSS_SETTLE);
    return;
  }
  eventQueue.push({ client, channel, moment, queuedAt: now, notBefore: now + EVENT_SETTLE_MS });
  if (eventQueue.length > EVENT_QUEUE_MAX) {
    eventQueue.shift();
    recordCohostAttempt('event'); recordCohostDiscard('cola_llena');
  }
  scheduleDrain(EVENT_SETTLE_MS);
}

async function drainEventQueue() {
  if (draining) return;
  draining = true;
  try {
    while (eventQueue.length) {
      const item = eventQueue[0];
      const now = Date.now();
      if (eventExpired(item.queuedAt, now, COHOST_EVENT_TTL)) {
        eventQueue.shift();
        recordCohostAttempt('event'); recordCohostDiscard('caducado');
        logger.info(`Co-host: evento caducado en cola (${item.moment.kind})`);
        continue;
      }
      if (now < item.notBefore) { scheduleDrain(item.notBefore - now); return; }
      item.started = true; // un jefe nuevo ya no se suma a este comentario
      const outcome = await chatlog.runWithOrigin('cohost', () => runCohost(item.client, item.channel, item.moment))
        .catch(err => { logger.warn(`Cohost por evento: ${err.message}`); return 'dropped'; });
      if (outcome === 'retry') { item.started = false; scheduleDrain(5000); return; }
      eventQueue.shift();
    }
  } finally { draining = false; }
}

// Comentario libre por reloj: cada COHOST_FREE_INTERVAL, si el chat tiene actividad reciente. Tras un fallo reintenta en 3 min.
const FREE_RETRY_MS = 3 * 60 * 1000;
let lastFreeAt = 0;

async function freeCohostTick(client, channel) {
  if (!getEventSubLiveStatus()) { lastFreeAt = 0; return; }
  const now = Date.now();
  if (!lastFreeAt) { lastFreeAt = now; return; }
  if (cohostRunning || eventQueue.length) return;
  if (isFreeCohostPaused(now)) return; // alguien pidió silencio: los libres esperan
  const recentMessages = chatHistory.filter(m => m.ts > now - FREE_COHOST_ACTIVITY_WINDOW_MS).length;
  if (hourlyCapReached(freeCohostTimes, COHOST_FREE_MAX_PER_HOUR, now)) return;
  if (!freeCohostDue({ now, lastFreeAt, intervalMs: COHOST_FREE_INTERVAL, recentMessages, minMessages: FREE_COHOST_MIN_MESSAGES, lastAnyAt: getLastCohostTime(), freeStamps: freeAttemptTimes, maxFree: FREE_ATTEMPTS_MAX_PER_HOUR })) return;
  const outcome = await chatlog.runWithOrigin('cohost', () => runCohost(client, channel, null));
  lastFreeAt = outcome === 'sent' ? Date.now() : Date.now() - COHOST_FREE_INTERVAL + FREE_RETRY_MS;
}

// Engancha el cohost a los eventos nuevos de la narrativa (muerte, boss, sub, raid, explosión del chat...) y arranca el reloj de los libres.
function startEventCohost(client, channel) {
  onNarrativeEvent(async (event, events) => {
    if (!getEventSubLiveStatus()) return;
    const deathCount = getDeathCount();
    const recordToBeat = event.type === 'death' ? await getDeathRecord() : 0;
    const moment = classifyCohostMoment(event, { events, deathCount, recordToBeat });
    if (moment) enqueueCohostMoment(client, channel, moment);
  });
  const clock = setInterval(() => {
    freeCohostTick(client, channel).catch(err => logger.warn(`Cohost libre: ${err.message}`));
  }, 30 * 1000);
  clock.unref?.();
}

// --- Stream status ---
let streamWasLive = false;
let streamStatusInitialized = false;
let streamEndPostedByEventSub = false;

async function initStreamStatus() {
  const isLive = getEventSubLiveStatus();
  if (isLive) {
    streamWasLive = true;
    streamStatusInitialized = true;
    logger.info(`Iniciando: EN DIRECTO (EventSub)`);
    return;
  }
  const info = await getStreamInfo().catch(() => null);
  streamWasLive = info?.live === true;
  streamStatusInitialized = true;
  logger.info(`Iniciando: ${streamWasLive ? 'EN DIRECTO' : 'OFFLINE'}`);
}

const streamStartMessages = messagesConfig.stream_start_messages || [];
const streamEndMessages = messagesConfig.stream_end_messages || [];

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function checkStreamStatus(client, channel) {
  if (!streamStatusInitialized) return;
  const isLive = getEventSubLiveStatus();

  if (!streamWasLive && isLive) {
    streamWasLive = true;
    streamEndPostedByEventSub = false;
    if (claimStartAnnouncement()) client.say(channel, pickRandom(streamStartMessages));
  } else if (streamWasLive && !isLive) {
    streamWasLive = false;
    resetStartAnnouncement();
    // EventSub ya posteó el resumen IA; solo usar fallback si no lo hizo
    if (!streamEndPostedByEventSub) {
      client.say(channel, pickRandom(streamEndMessages));
    }
  }
}

// Llamado desde eventsub.js cuando arrancan con pocos viewers
async function onWarmupMode(client, channel, game) {
  if (!canMakeRequest()) return;
  // Un solo mensaje de inicio: si el aviso normal ya salió, el calentamiento no añade otro
  if (!claimStartAnnouncement()) { logger.info('Warmup: ya salió el mensaje de inicio, no se añade otro'); return; }
  try {
    const gameContext = game ? ` El juego de hoy: "${game}".` : '';
    const response = await aiChat('alert', {
      max_tokens: 100,
      messages: [
        {
          role: 'system',
          content: `Eres dios_fua, bot del canal de ${channelConfig.streamer}. Canal: ${channelConfig.vibe}. Emotes si encajan: ${(channelConfig.channel_emotes || []).join(', ')}. El stream acaba de empezar y hay pocos viewers — momento ideal para calentar el chat.${gameContext} Genera un mensaje de calentamiento: una bienvenida energetica + UNA pregunta directa al chat sobre ${game ? 'el juego de hoy' : 'lo que se viene'} que invite a responder. SIEMPRE en espanol. Max 2 frases. Usa FUA. Sin presentarte.`
        },
        { role: 'user', content: `Calienta el chat` }
      ]
    });
    client.say(channel, truncate(quality.vetAuto(response.choices[0].message.content)));
    logger.info(`🔥 Warmup mode activado`);
  } catch (err) {
    logger.warn(`Warmup mode: ${err.message}`);
    if (!isSilenced()) client.say(channel, truncate(messagesConfig.warmup_fallback));
  }
}

// Llamado desde eventsub.js tras generar la memoria del stream
function postStreamEnd(client, channel, aiSummary) {
  streamWasLive = false;
  streamEndPostedByEventSub = true;
  const msg = aiSummary
    ? `🎬 ¡Fin del stream! ${aiSummary} ¡Hasta la próxima! FUA! 💜🔥`
    : pickRandom(streamEndMessages);
  throttleSay(client, channel, truncate(msg));
}

// --- !quemeperdi ---
const queMePerdiCooldowns = new Map();
const QUEMEPERDI_COOLDOWN_MS = 120000;
setInterval(() => { const now = Date.now(); for (const [k,v] of queMePerdiCooldowns) if (now > v) queMePerdiCooldowns.delete(k); }, 30 * 60 * 1000);

async function handleQueMePerdi(client, channel, tags) {
  if (isSilenced()) return;
  const username = tags['display-name'];
  const userId = tags['user-id'] || tags['username'] || username;
  const msgs = messagesConfig.quemeperdi;
  if (!getStreamIsLive()) { client.say(channel, truncate(msgs.offline.replace('{username}', username))); return; }

  const now = Date.now();
  const until = queMePerdiCooldowns.get(userId);
  if (until && now < until) {
    client.say(channel, truncate(msgs.cooldown.replace('{username}', username).replace('{seconds}', Math.ceil((until - now) / 1000))));
    return;
  }

  const chat = getStreamChatBuffer();
  const narrative = getStreamNarrative();
  if (!chat && narrative.length === 0) { client.say(channel, truncate(msgs.nothing_yet.replace('{username}', username))); return; }
  queMePerdiCooldowns.set(userId, now + QUEMEPERDI_COOLDOWN_MS);

  const gameInfo = await getCurrentGame().catch(() => null);
  const game = gameInfo?.game || null;
  const startedAt = getStreamStartedAt();
  const minutes = startedAt ? Math.floor((now - startedAt) / 60000) : 0;
  const deaths = getDeathCount();

  if (!canMakeRequest() || !canUserMakeRequest(userId, getUserType(username, tags))) {
    client.say(channel, truncate(msgs.fallback.replace('{minutes}', minutes).replace('{game}', game || 'directo').replace('{deaths}', quality.countDeaths(deaths))));
    return;
  }
  try {
    const story = buildStoryBlock(narrative);
    const bosses = getBossCount();
    const facts = `Minutos de stream: ${minutes}. Muertes del streamer (veces que ha caído): ${deaths}. Jefes derrotados: ${bosses}.`;
    let text = '';
    let feedback = '';
    for (let attempt = 0; attempt < 2 && !text; attempt++) {
      if (attempt > 0 && !canMakeRequest()) break;
      const response = await aiChat('quemeperdi', {
        max_tokens: 150,
        messages: [
          { role: 'system', content: `${buildQueMePerdiSystem({ game: game || '', player: getPlayer() })}${retryNote(feedback)}` },
          { role: 'user', content: `<datos>${facts}</datos>${story}
<chat>
${chat}
</chat>
Cuenta lo ocurrido.` }
        ]
      });
      const choice = response.choices[0];
      const out = (choice.finish_reason === 'length' ? quality.dropTrailingFragment(choice.message.content) : (choice.message.content || '')).trim();
      const problem = quality.validateQueMePerdi(out, { deathCount: deaths, bosses, minutes, source: `${chat}\n${story}\n${facts}` });
      if (problem) { feedback = problem; logger.info(`!quemeperdi descartado (${problem}): ${out.slice(0, 80)}`); continue; }
      if (await factcheck.shouldDiscard(out, `Juego: ${game || 'desconocido'}. ${facts}`)) { feedback = 'afirma datos del juego sin respaldo; no hables del juego'; continue; }
      text = out;
    }
    if (!text) throw new Error('sin respuesta válida');
    // Emote como en el resto (1 de cada 3, siempre al final) y nunca partido: si el mensaje no cabe, se quita el emote
    const qEmotes = channelConfig.channel_emotes || [];
    const qAllow = quality.emoteAllowed(getBotHistory().map(e => e.msg), qEmotes);
    const qBody = quality.applyEmotePolicy(text, qAllow, qEmotes);
    const qOut = truncate(quality.fitWithEmotes(`@${username} ${qBody}`, TWITCH_MAX_LENGTH, qEmotes));
    client.say(channel, qOut);
    addBotMessage(qOut.replace(/^@\S+\s*/, ''));
  } catch (err) {
    logger.warn(`!quemeperdi: ${err.message}`);
    queMePerdiCooldowns.delete(userId);
    client.say(channel, truncate(msgs.fallback.replace('{minutes}', minutes).replace('{game}', game || 'directo').replace('{deaths}', quality.countDeaths(deaths))));
  }
}

// --- Conversation hooks --- FIX #6: game hooks enriquecidos con la ficha del juego + comentarios IA espontáneos
let lastHookTime = 0;
const recentHooks = [];
const usedStaticHooks = new Set(); // hooks estáticos ya dichos en este stream
const HOOK_INTERVAL = parseInt(process.env.HOOK_INTERVAL_MS || '600000', 10);
const HOOK_MIN_SILENCE = parseInt(process.env.HOOK_SILENCE_MS || '300000', 10);
const MIN_VIEWERS_FOR_HOOKS = 3;

// Los hooks fijos sobre el juego ("¿Alguien lo conocía ya?") solo valen en los primeros streams de un juego nuevo
const NEW_GAME_HOOK_STREAMS = 2;
const HOOK_FACTS_WINDOW_MS = 45 * 60 * 1000;
const gameHookCache = new Map(); // juego → { ok, at }
async function gameHooksAllowed(game) {
  const cached = gameHookCache.get(game);
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.ok;
  const count = await countSessionsOfGame(game);
  const ok = count !== null && count <= NEW_GAME_HOOK_STREAMS; // sin base de datos, mejor ningún hook fijo del juego
  gameHookCache.set(game, { ok, at: Date.now() });
  return ok;
}

async function checkChatHook(client, channel) {
  if (isSilenced() || isTriviaActive()) return;
  if (!getEventSubLiveStatus()) return;
  const now = Date.now();
  if (isFreeCohostPaused(now)) return; // alguien pidió silencio: tampoco el hook anti-silencio (los timers fijos siguen)
  const silenceTime = now - lastChatMessageTime;

  if (now - lastHookTime < HOOK_INTERVAL) return;

  // Si hay raid activa y el chat lleva al menos 1 min sin actividad, dar bienvenida a raiders
  if (isRaidActive() && silenceTime >= 60000) {
    if (!claimHookPause(lastChatMessageTime, now)) return;
    lastHookTime = now;
    client.say(channel, `👋 ¡Bienvenidos a los raiders de @${getRaidUsername()}! Si tenéis preguntas sobre el canal usad !dios_fua, y si os apetece un desafío probad !trivia 🔥`);
    return;
  }

  if (silenceTime < HOOK_MIN_SILENCE) return;
  // Si el chat lleva más de 10 min muerto, no forzar — no hay nadie
  try {
    const viewers = await getViewersWithAppToken(channelConfig.broadcaster_id);
    if (viewers !== null && viewers < MIN_VIEWERS_FOR_HOOKS) return;
  } catch {}

  if (!claimHookPause(lastChatMessageTime, now)) return; // en esta pausa ya habló un hook
  lastHookTime = now;
  const gameInfo = await getCurrentGame().catch(() => null);
  const game = gameInfo?.game;

  // IA: una pregunta al chat sobre lo que ha pasado en el stream (caídas, jefes, rachas). Sin sucesos, hooks fijos.
  const hookFacts = windowFacts(getStreamNarrative(), now, HOOK_FACTS_WINDOW_MS);
  if (game && hookFacts.relevant && canMakeRequest()) {
    try {
      const gi = await getGameInfo(game, { detail: true }).catch(() => null);
      const gameFacts = factcheck.gameFactsText(gi);
      const gameContext = gi
        ? `${game} (${translateGenres(gi.genres) || 'sin género'}, ${gi.released?.slice(0,4) || '?'})`
        : game;
      const deathCount = getDeathCount();
      const eventText = `${hookFacts.lines.join('; ')}. Caídas anotadas hoy: ${deathCount}.`;
      const system = buildHookSystem({ game, player: getPlayer(), weekday: !getUsedStructures().has('dia-semana') });
      const lastCitedDeaths = quality.citesDeathCount((getBotHistory().slice(-1)[0] || {}).msg || '', deathCount);

      let text = '';
      let feedback = '';
      for (let attempt = 0; attempt < 2 && !text; attempt++) {
        if (attempt > 0 && !canMakeRequest()) break;
        const response = await aiChat('hook', {
          max_tokens: 80,
          messages: [
            { role: 'system', content: `${system}${retryNote(feedback)}` },
            { role: 'user', content: `<suceso>${eventText}</suceso>` }
          ]
        });
        const out = truncate((response.choices[0].message.content || '').trim());
        const check = quality.validateHook(out, { deathCount, recent: recentHooks, player: getPlayer(), lastCitedDeaths, requireQuestion: true, extraDeathNumbers: [hookFacts.deaths, hookFacts.streak] });
        if (!check.ok) { feedback = check.reason; logger.info(`Hook descartado (${check.reason}): ${out.slice(0, 80)}`); continue; }
        const review = await factcheck.evaluate(out, `Juego: ${gameContext}. Muertes anotadas: ${deathCount}. ${gameFacts}`, { game, sense: true });
        if (review.discard) {
          logger.info(`Hook descartado (datos del juego sin respaldo): ${out.slice(0, 80)}`);
          break;
        }
        if (review.nonsense) { feedback = 'la frase no tiene sentido o está mal escrita'; logger.info(`Hook descartado (sin sentido o mal escrito): ${out.slice(0, 80)}`); continue; }
        text = out;
      }
      if (!text) throw new Error('hook IA sin respuesta válida');
      recentHooks.push(text);
      if (recentHooks.length > 12) recentHooks.shift();
      for (const key of quality.streamMarks(text, game)) markStructure(key);
      addBotMessage(text);
      client.say(channel, text, { origin: 'hook' });
      return;
    } catch (err) {
      logger.warn(`Hook IA espontaneo fallo: ${err.message}`);
      // Si falla la IA, caemos al hook genérico
    }
  }

  // Hooks estáticos de fallback
  const genericHooks = [
    '¿Sois más de cooperativo o en solitario? 💬',
    '¡Chat! ¿Alguien se anima con un !trivia? 🧠',
    '¿Cuántas muertes creéis que habrá hoy? 💀',
    '¿Cuál es vuestro juego favorito de todos los tiempos? 🎮',
    '¡Usad !chiste para que cuente un chiste! 😂',
  ];

  let gameHooks = [];
  if (game && await gameHooksAllowed(game)) {
    try {
      const gi = await getGameInfo(game, { detail: true }); // misma clave de caché que la ficha precalentada del juego actual
      const genres = translateGenres(gi?.genres);
      if (genres) {
        const year = gi.released?.slice(0, 4) || '';
        gameHooks = [
          `🎮 ${channelConfig.streamer} jugando a ${game} (${genres}${year ? ', ' + year : ''}). ¿Alguien lo ha jugado?`,
          `¿Qué os parece ${game} hasta ahora? Género: ${genres} 🎮`,
          `${game} - ${genres}${year ? ', ' + year : ''}. ¿Alguien lo conocía ya? 🤔`,
        ];
      } else {
        gameHooks = [
          `¿Qué os parece ${game} hasta ahora? 🎮`,
          `¿Alguien ha jugado ${game} antes? ¿Es difícil? 🤔`,
        ];
      }
    } catch {
      gameHooks = [
        `¿Qué os parece ${game} hasta ahora? 🎮`,
        `¿Alguien ha jugado ${game}? ¿Qué tal? 🤔`,
      ];
    }
  }

  // Sin repetir en este stream: se descartan los ya usados; si se agotan, se vuelve a empezar
  let allHooks = [...gameHooks, ...genericHooks].filter(h => !usedStaticHooks.has(h));
  if (!allHooks.length) { usedStaticHooks.clear(); allHooks = [...gameHooks, ...genericHooks]; }
  const hook = allHooks[Math.floor(Math.random() * allHooks.length)];
  usedStaticHooks.add(hook);
  client.say(channel, hook, { origin: 'hook' });
}

// --- !chiste ---
const chistesDB = require('../../data/chistes.json');
const chisteCooldowns = new Map();
let lastChisteIndex = -1;
setInterval(() => { const now = Date.now(); for (const [k,v] of chisteCooldowns) if (now > v) chisteCooldowns.delete(k); }, 30 * 60 * 1000);

function handleChiste(client, channel, tags) {
  if (isSilenced()) return;
  const username = tags['display-name'];
  // BUG FIX #2: fallback si user-id es undefined (evita cooldown compartido)
  const userId = tags['user-id'] || tags['username'] || username;
  const key = `chiste-${userId}`;
  const now = Date.now();
  if (chisteCooldowns.has(key) && now < chisteCooldowns.get(key)) {
    client.say(channel, `@${username} espera ${Math.ceil((chisteCooldowns.get(key) - now) / 1000)}s.`);
    return;
  }
  let index, attempts = 0;
  do { index = Math.floor(Math.random() * chistesDB.length); attempts++; } while (index === lastChisteIndex && attempts < 10);
  lastChisteIndex = index;
  chisteCooldowns.set(key, now + 30000);
  persistCooldown(key, now + 30000);
  client.say(channel, truncate(`😂 ${chistesDB[index]}`));
}

// --- Herramienta buscar_juego (solo !dios_fua) ---
const BUSCAR_JUEGO_TOOL = {
  type: 'function',
  function: {
    name: 'buscar_juego',
    description: 'SOLO para videojuegos (nunca para cultura general): busca datos reales de un videojuego: fecha de salida, desarrolladora, editora, país de la desarrolladora (si consta), géneros y descripción corta',
    parameters: {
      type: 'object',
      properties: { nombre: { type: 'string', description: 'Nombre del videojuego' } },
      required: ['nombre']
    }
  }
};

// { text, info }: text es lo que ve la IA; info solo viene con coincidencia exacta (para la plantilla de reserva)
async function buscarJuegoLookup(nombre, question = '') {
  const recovered = recoverTruncatedName(nombre, question);
  if (recovered.truncated || recovered.recovered) logger.info(`!dios_fua buscar_juego: nombre truncado "${nombre}" → "${recovered.name}"${recovered.truncated ? ' (sin recuperar)' : ''}`);
  const clean = sanitizeForAI(recovered.name || '');
  if (!clean) return { text: 'SIN DATOS: no se indicó ningún juego.', info: null };
  const { info, error } = await lookupGameInfo(clean.slice(0, 80), { detail: true }).catch(() => ({ info: null, error: true }));
  if (error) { logger.warn(`!dios_fua buscar_juego: fuentes no disponibles para "${clean.slice(0, 80)}"`); return { info: null, unavailable: true, text: 'SIN DATOS: no se puede consultar ahora.' }; }
  let match = info ? classifyGameMatch(clean, info.name) : 'none';
  if (match === 'match' && recovered.truncated) match = 'maybe'; // nombre cortado y sin recuperar: nunca coincidencia segura
  logger.info(`!dios_fua buscar_juego: "${clean.slice(0, 80)}" → ${info ? `${info.name} (${match})` : 'sin datos'}`);
  if (match === 'none') return { info: null, text: `SIN DATOS: no hay información de "${clean}". Si es un videojuego no inventes nada y dilo con humor sin hablar de datos ni de fuentes; si no es un videojuego, responde con lo que sepas.` };
  if (match === 'maybe') return { info: null, text: `SIN DATOS, quizá se refiera a ${info.name}. Sin hablar de datos ni de fuentes: no presentes ese juego como el pedido ni uses sus datos; pregunta si se refiere a ese.` };
  // Ficha en español y en limpio (fecha legible, géneros traducidos, resumen en español de la caché): el modelo nunca ve el inglés de IGDB
  const text = await buildGameSheet(info);
  return { text, info };
}

async function buscarJuegoTool(nombre) {
  return (await buscarJuegoLookup(nombre)).text;
}

// --- !dios_fua --- FIX #4 + #7: prompt mejorado + busqueda web Tavily
const questionCooldowns = new Map();
setInterval(() => { const now = Date.now(); for (const [k,v] of questionCooldowns) if (now > v) questionCooldowns.delete(k); }, 30 * 60 * 1000);

async function handleQuestion(client, channel, tags, args) {
  if (isSilenced()) return;
  const username = tags['display-name'];
  // BUG FIX #2: fallback si user-id es undefined
  const userId = tags['user-id'] || tags['username'] || username;
  const now = Date.now();

  if (questionCooldowns.has(userId) && now < questionCooldowns.get(userId)) {
    client.say(channel, `@${username} espera ${Math.ceil((questionCooldowns.get(userId) - now) / 1000)}s.`);
    return;
  }

  const rawQuestion = args.slice(1).join(' ');
  if (!rawQuestion) { client.say(channel, `@${username} escribe algo después de !dios_fua 😅`); return; }
  const question = sanitizeForAI(rawQuestion);
  if (!question) { client.say(channel, `@${username} esa pregunta no la puedo responder 🙅`); return; }
  // Identidad (quién eres, quién te creó, quién lleva el canal): plantilla fija, sin IA ni cupo
  const identity = quality.identityQuestion(question);
  if (identity) {
    const reply = pickIdentityReply(identity);
    client.say(channel, truncate(`@${username} ${reply}`));
    addBotMessage(reply);
    questionCooldowns.set(userId, now + QUESTION_COOLDOWN_MS);
    return;
  }
  if (!canMakeRequest()) { client.say(channel, `@${username} demasiadas peticiones globales ⏳`); return; }

  const userType = getUserType(username, tags);
  if (!canUserMakeRequest(userId, userType)) { client.say(channel, `@${username} espera un momento antes de volver a preguntar ⏳`); return; }

  try {
    trackMessage();
    refreshMode();
    const userConv = getUserConversation(userId);
    const questionMode = getModeConfig();
    const systemContent = buildQuestionSystem({
      context: await buildContextText(),
      role: await buildRoleText(userType, username, tags['user-id']),
      tone: buildToneText(question),
      modeLine: questionMode.prompt_extension,
    });
    const messages = [
      { role: 'system', content: systemContent },
      ...userConv,
      { role: 'user', content: `${username}: ${question}` }
    ];
    const qModeConfig = getModeConfig();
    const qMaxTokens = qModeConfig.max_tokens ?? 150;
    // Si la pregunta nombra un juego, su ficha de IGDB se busca ANTES de llamar al modelo y se le pasa siempre (como en las menciones):
    // no se depende de que el modelo llame a buscar_juego. Sin ficha (no hay nombre o IGDB no lo conoce) sigue el flujo con la herramienta.
    const gameName = quality.extractGameMention(question);
    const pre = gameName ? await buscarJuegoLookup(gameName, question) : null;
    const prefetched = !!pre?.info;
    if (prefetched) {
      chatlog.noteTool('buscar_juego');
      const last = messages[messages.length - 1];
      last.content = `<ficha_igdb>\n${pre.text}\n</ficha_igdb>\n${last.content}`;
    }
    let response = await aiChat('diosfua', {
      max_tokens: qMaxTokens,
      ...(quality.isGameQuestion(question) || quality.talksAboutGames(question) ? {} : { temperature: GENERAL_TEMPERATURE }),
      ...(prefetched ? {} : { tools: [BUSCAR_JUEGO_TOOL], tool_choice: 'auto' }),
      messages
    });
    // Una sola ronda de herramienta: ejecutar buscar_juego y pedir la respuesta final sin tools
    const toolCalls = response.choices[0]?.message?.tool_calls;
    let gameText = prefetched ? `${pre.text}\n` : '';
    let gameData = prefetched ? pre.info : null;
    let gameDown = false;
    if (toolCalls?.length) {
      messages.push(response.choices[0].message);
      for (const call of toolCalls.slice(0, 2)) {
        let result = 'Herramienta desconocida.';
        if (call.function?.name === 'buscar_juego') {
          let nombre = '';
          try { nombre = String(JSON.parse(call.function.arguments || '{}').nombre || ''); } catch { /* args inválidos */ }
          chatlog.noteTool('buscar_juego');
          const lookup = await buscarJuegoLookup(nombre, question);
          result = lookup.text;
          gameData = gameData || lookup.info;
          if (lookup.unavailable) gameDown = true;
          gameText += `${result}\n`;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      // datos de juegos caídos (no es "juego no encontrado"): se dice con humor, sin pedirle nada más a la IA
      if (gameDown && !gameData) {
        client.say(channel, truncate(`@${username} ${pickRandom(messagesConfig.dios_fua_game_down)}`));
        questionCooldowns.set(userId, now + QUESTION_COOLDOWN_MS);
        return;
      }
      response = await aiChat('diosfua', {
        max_tokens: qMaxTokens,
        messages
      });
    }
    let answer = quality.fixFuaGender(response.choices[0].message.content);
    // El canal es de Manu y Pao: si la respuesta se lo atribuye a vlxj97, un reintento con la corrección; si repite, se descarta
    if (quality.claimsChannelOwner(answer)) {
      messages.push({ role: 'user', content: 'Recuerda: el canal lo llevan Manu y Pao, y vlxj97 creó el bot. Responde otra vez.' });
      const fix = await aiChat('diosfua', { max_tokens: qMaxTokens, messages });
      answer = fix.choices[0].message.content;
    }
    const ownerClaim = quality.claimsChannelOwner(answer);
    const qMaxChars = qModeConfig.max_chars ?? TWITCH_MAX_LENGTH;
    // Datos del juego: solo los que devolvió buscar_juego (IGDB); si afirma algo más, no se envía.
    // Solo si hablan de videojuegos: la cultura general se responde con el conocimiento del modelo.
    const gameTopic = quality.isGameQuestion(question) || quality.talksAboutGames(`${question} ${answer}`)
      || ((prefetched || !!toolCalls?.length) && gameText.length > 0 && !gameText.startsWith('SIN DATOS'));
    const techLeak = quality.leaksTech(answer) || ownerClaim;
    let discard = techLeak;
    let claim = '';
    if (!techLeak && gameTopic) ({ discard, claim } = await factcheck.evaluate(answer, gameText, { source: 'juego' }));
    // País, nacionalidad, personas y cifras solo valen si están en los datos de IGDB (el verificador de IA a veces los deja pasar)
    // Sin datos de buscar_juego (no encontrado), ni estudio ni editora ni nacionalidad: todo sería inventado
    const noGameData = !!toolCalls?.length && !/^Nombre: /m.test(gameText);
    const inventedAttr = !techLeak && (gameTopic || noGameData)
      ? (noGameData ? quality.inventedCompany(answer, gameText) : quality.unsupportedAttributes(answer, gameText))
      : '';
    if (inventedAttr && !discard) { discard = true; claim = inventedAttr; }
    // Ficha volcada en bruto (inglés, fechas ISO, campos copiados): no se envía; con datos de IGDB, un reintento y si no la plantilla
    const rawLeak = !techLeak ? leaksSheetRaw(answer, { names: [gameData?.name, gameName, ...(channelConfig.games_played || [])] }) : '';
    if (rawLeak && !discard) { discard = true; claim = rawLeak; logger.info(`!dios_fua: respuesta con la ficha en bruto (${rawLeak})`); }
    // Con datos reales de IGDB, un único reintento diciéndole qué frase no estaba respaldada
    if (discard && !techLeak && /^Nombre: /m.test(gameText)) {
      messages.push({ role: 'user', content: 'Responde otra vez en español y con tus palabras, en una o dos frases, contestando directamente a lo que pregunta con la ficha; para lo que la ficha no diga, di con humor que no tienes ni idea.' });
      const retry = await aiChat('diosfua', { max_tokens: qMaxTokens, messages });
      const retryAnswer = retry.choices[0].message.content;
      if (retryAnswer && !quality.leaksTech(retryAnswer) && !leaksSheetRaw(retryAnswer, { names: [gameData?.name, gameName, ...(channelConfig.games_played || [])] }) && !quality.unsupportedAttributes(retryAnswer, gameText) && !await factcheck.shouldDiscard(retryAnswer, gameText, { source: 'juego' })) { answer = retryAnswer; discard = false; }
    }
    // Sigue fallando pero IGDB sí tiene el juego: plantilla solo con datos de IGDB en vez de la frase de reserva
    if (discard && !techLeak && gameData) {
      const tpl = buildGameTemplate(gameData, messagesConfig.dios_fua_game_quips);
      if (tpl) { answer = tpl; discard = false; logger.info(`!dios_fua: plantilla de juego para "${gameData.name}"`); }
    }
    if (discard) {
      logger.info(`!dios_fua descartado (${techLeak ? 'respuesta técnica' : 'datos del juego sin respaldo'}): ${String(answer).slice(0, 80)}`);
      // Juego que IGDB no conoce: lo dice con humor en vez de la frase de reserva genérica
      const unknownGame = !techLeak && gameText.includes('SIN DATOS') && !/^Nombre: /m.test(gameText);
      client.say(channel, truncate(`@${username} ${pickRandom(unknownGame ? messagesConfig.dios_fua_unknown_game : messagesConfig.dios_fua_no_data)}`));
      questionCooldowns.set(userId, now + QUESTION_COOLDOWN_MS);
      return;
    }
    answer = String(answer).replace(/\s*\n+\s*/g, ' ').trim(); // una sola línea
    client.say(channel, truncate(`@${username} ${answer}`, qMaxChars));
    addBotMessage(truncate(answer, qMaxChars));
    questionCooldowns.set(userId, now + QUESTION_COOLDOWN_MS);
    persistCooldown(`question-${userId}`, now + QUESTION_COOLDOWN_MS);
    addToUserConversation(userId, 'user', `${username}: ${question}`);
    addToUserConversation(userId, 'assistant', answer);
  } catch (err) {
    logger.error(`!dios_fua: ${err.message}`);
    const isTimeout = err.message?.includes('timeout') || err.code === 'ETIMEDOUT';
    const is429 = err.status === 429;
    const ftype = is429 ? 'ratelimit' : isTimeout ? 'timeout' : 'error';
    client.say(channel, truncate(getFallback(ftype, `@${username}`)));
  }
}


// --- !so ---
async function handleShoutout(client, channel, tags, targetUsername) {
  const isMod = tags.mod || tags['user-type'] === 'mod' || tags.badges?.broadcaster === '1';
  if (!isMod) { client.say(channel, `@${tags['display-name']} solo mods pueden usar !so.`); return; }
  if (!targetUsername) { client.say(channel, `Uso: !so @usuario`); return; }

  const target = targetUsername.replace('@', '');
  client.say(channel, `Preparando shoutout para @${target}...`);

  try {
    if (!canMakeRequest()) {
      client.say(channel, `📢 ¡Échad un ojo a @${target}! 💜 twitch.tv/${target}`);
      return;
    }
    const info = await getChannelInfo(target);
    const lastGame = info?.game_name ? `, su último juego: «${info.game_name}»` : '';
    const response = await aiChat('command', {
      max_tokens: 80,
      messages: [
        { role: 'system', content: buildShoutoutSystem() },
        { role: 'user', content: `<canal>@${target}${lastGame}</canal>` }
      ]
    });
    client.say(channel, truncate(`📢 ${response.choices[0].message.content.trim()} twitch.tv/${target}`));
  } catch (err) {
    logger.error(`!so: ${err.message}`);
    client.say(channel, `📢 ¡Échad un ojo a @${target}! 💜 twitch.tv/${target}`);
  }
}

// --- Deteccion de highlights para stream markers --- FIX #10
const highlightKeywords = [
  'clip', 'clipa', 'clipalo', 'marca', 'wtf', 'wow', 'fua',
  'increible', 'brutal', 'epico', 'epica', 'locura', 'boom', 'gg', 'no puede ser'
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
  if (!highlightKeywords.some(kw => lower.includes(kw))) return;

  recentHighlightMsgs.push({ ts: now, message, userId });
  while (recentHighlightMsgs.length > 0 && recentHighlightMsgs[0].ts < now - HIGHLIGHT_WINDOW) {
    recentHighlightMsgs.shift();
  }

  if (new Set(recentHighlightMsgs.map(e => e.userId)).size >= HIGHLIGHT_THRESHOLD) {
    const triggerMessages = recentHighlightMsgs.map(e => e.message);
    recentHighlightMsgs.length = 0;
    lastMarkerTime = now;
    addNarrativeEvent('victory', 'El chat explotó — momento épico detectado automáticamente');

    const markerResult = await createStreamMarker('Momento epico detectado por el chat');
    const markerCreated = markerResult !== null;
    if (markerCreated) logger.info(`Stream marker creado automaticamente`);

    if (canMakeRequest()) {
      try {
        const gameInfo = await getCurrentGame().catch(() => null);
        const game = gameInfo?.game ? ` Juego: "${gameInfo.game}".` : '';
        const response = await aiChat('reaction', {
          max_tokens: 70,
          messages: [
            { role: 'system', content: NARRATOR_BASE(game) },
            { role: 'user', content: `El chat acaba de explotar con hype` }
          ]
        });
        const aiDesc = response.choices[0].message.content;
        const prefix = markerCreated ? '🏁' : '🔥';
        client.say(channel, truncate(`${prefix} ${aiDesc}`));
        if (markerCreated) {
          saveHighlight(triggerMessages, markerResult.id, aiDesc)
            .then(r => { if (r?.error) logger.warn(`Highlight no persistido: ${r.error.message}`); })
            .catch(() => {});
        }
      } catch {
        if (markerCreated) {
          saveHighlight(triggerMessages, markerResult.id, 'Momento epico detectado por el chat')
            .then(r => { if (r?.error) logger.warn(`Highlight no persistido: ${r.error.message}`); })
            .catch(() => {});
          client.say(channel, `🏁 ¡Momento marcado para el VOD! ¡FUA! 🔥`);
        } else {
          client.say(channel, `🔥 ¡QUÉ MOMENTO, FUA! 💜`);
        }
      }
    } else if (markerCreated) {
      saveHighlight(triggerMessages, markerResult.id, 'Momento epico detectado por el chat')
        .then(r => { if (r?.error) logger.warn(`Highlight no persistido: ${r.error.message}`); })
        .catch(() => {});
      client.say(channel, `🏁 ¡Momento marcado para el VOD! ¡FUA! 🔥`);
    } else {
      client.say(channel, `🔥 ¡QUÉ MOMENTO, FUA! 💜`);
    }
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
  if (!getEventSubLiveStatus() || isSilenced()) return;
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
    const fresh = entries.filter(e => e.ts > now - EMOTE_WINDOW_MS);
    recentEmoteUse.set(token, fresh);

    const uniqueUsers = new Set(fresh.map(e => e.user)).size;
    if (uniqueUsers >= EMOTE_SPAM_THRESHOLD && canMakeRequest()) {
      lastEmoteCommentTime = now;
      recentEmoteUse.delete(token);
      try {
        const response = await aiChat('reaction', {
          max_tokens: 60,
          messages: [
            { role: 'system', content: NARRATOR_BASE('') },
            { role: 'user', content: `El chat spamea "${token}"` }
          ]
        });
        client.say(channel, truncate(response.choices[0].message.content));
      } catch {}
      return;
    }
  }

  // Limpieza ocasional del mapa
  if (Math.random() < 0.03) {
    for (const [k, v] of recentEmoteUse) {
      const fresh = v.filter(e => e.ts > now - EMOTE_WINDOW_MS);
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
  const letters = [...msg].filter(c => /\p{L}/u.test(c));
  if (letters.length < 8) return false;
  return letters.filter(c => /\p{Lu}/u.test(c)).length / letters.length >= 0.7;
}

async function checkCapsRage(client, channel, tags, message) {
  if (!getEventSubLiveStatus() || isSilenced()) return;
  if (!isCapsMessage(message)) return;
  const now = Date.now();
  if (now - lastCapsCommentTime < CAPS_COMMENT_COOLDOWN) return;

  const username = tags['display-name'];
  capsMessages.push({ user: username, ts: now });
  while (capsMessages.length > 0 && capsMessages[0].ts < now - CAPS_WINDOW_MS) capsMessages.shift();

  const uniqueUsers = new Set(capsMessages.map(e => e.user)).size;
  if (uniqueUsers >= CAPS_THRESHOLD && canMakeRequest()) {
    lastCapsCommentTime = now;
    setLastCapsRageTime(now);
    capsMessages.length = 0;
    addNarrativeEvent('rage', 'CAPS rage del chat — energía colectiva desbordada');
    try {
      const gameInfo = await getCurrentGame().catch(() => null);
      const game = gameInfo?.game ? ` Juego: "${gameInfo.game}".` : '';
      const response = await aiChat('reaction', {
        max_tokens: 60,
        messages: [
          { role: 'system', content: NARRATOR_BASE(game) },
          { role: 'user', content: `El chat entra en modo CAPS RAGE` }
        ]
      });
      client.say(channel, truncate(response.choices[0].message.content));
    } catch {}
  }
}

// --- Pattern matcher: preguntas naturales sin ! ---

// Detección en patterns.js. Menciones directas: cooldown propio (8s global + 10s por usuario), sin escalar por modo
// Separadas para permitir conversación fluida sin bloquear el global de patrones generales
let lastDirectMentionTime = 0;
const directMentionUserCooldowns = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of directMentionUserCooldowns) if (now > v) directMentionUserCooldowns.delete(k);
}, 15 * 60 * 1000);

const mentionStamps = new Map(); // userId -> instantes de sus últimas respuestas a menciones
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of mentionStamps) if (!v.some(t => now - t < MENTION_WINDOW)) mentionStamps.delete(k);
}, 15 * 60 * 1000);

// Provocaciones: userId -> fin de su ventana (solo la primera de cada ventana recibe réplica)
const provocationUntil = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of provocationUntil) if (now > v) provocationUntil.delete(k);
}, 15 * 60 * 1000);

// Preguntas naturales: 45s global + 30s por usuario, escalados por pattern_cooldown_multiplier del modo
let lastPatternTime = 0;
const patternUserCooldowns = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of patternUserCooldowns) if (now > v) patternUserCooldowns.delete(k);
}, 15 * 60 * 1000);

// Petición de silencio al bot ("Dios Fua, cállate un rato"): respuesta breve y amable, sin IA, y el cohost libre se pausa 10 min.
// Los eventos (jefe, raid...) y las respuestas directas siguen funcionando. Un aviso por usuario cada 2 min como mucho.
const FREE_COHOST_PAUSE_MS = parseInt(process.env.COHOST_SHUTUP_PAUSE_MS || String(10 * 60 * 1000), 10);
const shutUpCooldowns = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of shutUpCooldowns) if (now > v) shutUpCooldowns.delete(k);
}, 15 * 60 * 1000);

function handleShutUp(client, channel, tags) {
  const now = Date.now();
  const userId = tags['user-id'] || tags['username'];
  pauseFreeCohost(FREE_COHOST_PAUSE_MS, now);
  if (now < (shutUpCooldowns.get(userId) || 0)) return 'blocked';
  shutUpCooldowns.set(userId, now + 2 * 60 * 1000);
  const reply = pickRandom(messagesConfig.shutup_replies);
  const out = truncate(`@${tags['display-name']} ${reply}`);
  client.say(channel, out, undefined, { expiresAt: now + MENTION_MAX_AGE_MS });
  addBotMessage(reply);
  logger.info(`Silencio pedido por ${tags['display-name']}: cohost libre en pausa ${Math.round(FREE_COHOST_PAUSE_MS / 60000)} min`);
  return true;
}

// false = no era para el bot (el cohost puede hablar); 'blocked' = sí lo era pero no se responde (cooldown, límite); true = respondido
async function checkPatternMatch(client, channel, tags, message) {
  if (isSilenced() || isTriviaActive()) return false;

  const kind = classifyMessage(message, tags, { botNames: [process.env.BOT_USERNAME] });
  if (!kind) return false;
  if (kind === 'shutup') return handleShutUp(client, channel, tags);

  const now = Date.now();
  const startedAt = now;
  const userId = tags['user-id'] || tags['username'];
  const isProvocation = kind === 'provocation';
  const isDirect = kind === 'direct' || isProvocation;
  const cdKind = isDirect ? 'direct' : 'natural';
  const userCooldowns = isDirect ? directMentionUserCooldowns : patternUserCooldowns;

  // Provocación repetida dentro de su ventana: se ignora (y el cohost tampoco entra a la provocación)
  if (isProvocation && !provocationGate(now, provocationUntil.get(userId) || 0)) return 'blocked';

  refreshMode();
  const modeConfig = getModeConfig();
  const multiplier = modeConfig.pattern_cooldown_multiplier ?? 1;
  const prevGlobal = isDirect ? lastDirectMentionTime : lastPatternTime;
  const prevUser = userCooldowns.get(userId);
  if (!cooldownGate(cdKind, { now, lastGlobalAt: prevGlobal, userUntil: prevUser || 0, multiplier })) return 'blocked';

  const username = tags['display-name'];
  const question = sanitizeForAI(message);
  if (!question) return 'blocked';
  if (!canMakeRequest()) return 'blocked';

  // Tope por usuario: pasado el límite se ignora en silencio (y el cohost tampoco entra)
  const prevStamps = mentionStamps.get(userId);
  if (isDirect) {
    const budget = mentionBudget(prevStamps, now, MENTION_MAX_PER_USER, MENTION_WINDOW);
    if (!budget.ok) { mentionStamps.set(userId, budget.stamps); return 'blocked'; }
    mentionStamps.set(userId, budget.stamps);
  }

  // Se reservan antes de esperar a la IA (evita dobles respuestas) y se devuelven si la IA falla
  const release = () => {
    if (isDirect) lastDirectMentionTime = prevGlobal; else lastPatternTime = prevGlobal;
    if (prevUser) userCooldowns.set(userId, prevUser); else userCooldowns.delete(userId);
    if (isProvocation) provocationUntil.delete(userId);
    if (isDirect) { if (prevStamps) mentionStamps.set(userId, prevStamps); else mentionStamps.delete(userId); }
  };
  const cd = cooldownMs(cdKind, multiplier);
  if (isDirect) lastDirectMentionTime = now; else lastPatternTime = now;
  userCooldowns.set(userId, now + cd.userMs);
  if (isProvocation) provocationUntil.set(userId, now + PROVOCATION_WINDOW);

  try {
    const emotes = channelConfig.channel_emotes || [];
    const allowEmote = quality.emoteAllowed(getBotHistory().map(e => e.msg), emotes) && !isProvocation;
    const maxChars = isProvocation ? Math.min(160, modeConfig.max_chars ?? 160) : Math.min(MENTION_MAX_CHARS, modeConfig.max_chars ?? MENTION_MAX_CHARS);
    let answer = '';

    // "Cuéntame de qué va Silent Hill F": se busca el juego en IGDB y se responde con esos datos (sin IA que pueda inventar).
    // Si IGDB no contesta, a !dios_fua; si pide datos de un juego que no encuentra, se dice con humor que no se pilla.
    const identity = isProvocation ? null : quality.identityQuestion(question);
    if (identity) answer = pickIdentityReply(identity);
    if (!answer && !isProvocation && !quality.isCurrentGameQuestion(question) && !quality.isDeathQuestion(question)) {
      const gameQuery = quality.extractGameQuery(question);
      if (gameQuery) {
        const lookup = await buscarJuegoLookup(gameQuery.name, question);
        if (lookup.info) answer = buildGameTemplate(lookup.info, messagesConfig.mention_game_quips);
        else if (lookup.unavailable) answer = pickRandom(messagesConfig.mention_game_redirect);
        else if (gameQuery.strict) answer = pickRandom(messagesConfig.mention_not_understood);
      }
    }

    if (answer) {
      // consulta de juego ya resuelta
    } else if (isProvocation) {
      answer = await generateProvocationReply(username, question, maxChars);
    } else if (quality.isCurrentGameQuestion(question)) {
      // "¿Qué juego es?": el juego actual del stream, sin IA
      const current = await getCurrentGame().catch(() => null);
      answer = current?.game
        ? pickRandom(messagesConfig.mention_current_game.some).replace('{game}', current.game)
        : messagesConfig.mention_current_game.none;
    } else if (quality.isDeathQuestion(question)) {
      // Por las muertes: el contador real, sin IA
      const n = getDeathCount();
      answer = n === 0 ? messagesConfig.mention_deaths.none : n === 1 ? messagesConfig.mention_deaths.one : messagesConfig.mention_deaths.some.replace('{n}', n);
    } else if (quality.isGameQuestion(question)) {
      // Preguntas concretas del juego: a !dios_fua, que consulta IGDB
      answer = pickRandom(messagesConfig.mention_game_redirect);
    } else {
      const userType = getUserType(username, tags);
      const userConv = getUserConversation(userId);
      const system = buildMentionSystem({
        context: await buildContextText(),
        role: await buildRoleText(userType, username, tags['user-id']),
        tone: buildToneText(question),
        emoteLine: emoteLineFor(allowEmote, emotes),
        modeLine: modeConfig.prompt_extension,
      });

      let fixKey = ''; // regla fallida del intento anterior: el reintento recibe solo la corrección en positivo
      for (let attempt = 0; attempt < 2 && !answer; attempt++) {
        const response = await aiChat('mention', {
          max_tokens: modeConfig.max_tokens ?? 120,
          temperature: GENERAL_TEMPERATURE,
          messages: [
            { role: 'system', content: `${system}${retryNote(fixKey)}` },
            ...userConv,
            { role: 'user', content: `${username}: ${question}` }
          ]
        }, 2, { maxDelayMs: MENTION_MAX_RETRY_DELAY_MS });
        const choice = response.choices[0];
        const raw = choice.finish_reason === 'length' ? quality.dropTrailingFragment(choice.message.content) : (choice.message.content || '').trim();
        const check = quality.validateMention(raw, { question, player: getPlayer() });
        if (!check.ok) { fixKey = check.rule; continue; }
        const mentionGame = await getCurrentGame().catch(() => null);
        // Solo se vigila lo que habla de videojuegos; "resistencia" o "zona" en una pregunta de cultura general no cuentan
        const gameTalk = quality.talksAboutGames(`${question} ${raw}`, mentionGame?.game);
        if (gameTalk && quality.mentionsMechanics(raw)) { fixKey = 'juego'; continue; }
        const invented = gameTalk ? quality.unsupportedAttributes(raw, `Juego: ${mentionGame?.game || ''}`) : '';
        if (invented) { fixKey = 'juego'; continue; }
        // Una sola llamada: datos del juego (solo si habla de videojuegos) y sentido/redacción
        const review = await factcheck.evaluate(raw, `Juego: ${mentionGame?.game || 'desconocido'}. Muertes anotadas: ${getDeathCount()}.`, { game: mentionGame?.game, sense: true, checkData: gameTalk });
        if (review.discard) { fixKey = 'juego'; continue; }
        if (review.nonsense) { fixKey = 'sentido'; continue; }
        answer = raw;
      }
      // Sin respuesta válida tras reintentar: callar. Las réplicas de reserva son solo para provocaciones reales
      if (!answer) {
        logger.info(`Mención sin respuesta válida, se calla: ${question.slice(0, 80)}`);
        release();
        return 'blocked';
      }
      addToUserConversation(userId, 'user', `${username}: ${question}`);
      addToUserConversation(userId, 'assistant', answer);
    }

    if (isStale(startedAt, Date.now(), MENTION_MAX_AGE_MS)) {
      logger.info(`Respuesta a ${username} descartada por tardía (${Math.round((Date.now() - startedAt) / 1000)} s): ${String(answer).slice(0, 60)}`);
      release();
      return 'blocked';
    }
    if (!isProvocation) { // el «¡FUA!» de cierre no es una costumbre: solo en 1 de cada 3 menciones
      const closing = quality.limitTrailingFua(answer, getMentionFuaHistory());
      answer = closing.text;
      noteMentionFua(closing.had);
    }
    const out = quality.applyEmotePolicy(truncate(`@${username} ${answer}`, maxChars), allowEmote, emotes);
    client.say(channel, out, undefined, { expiresAt: startedAt + MENTION_MAX_AGE_MS });
    addBotMessage(out.replace(/^@\S+\s*/, ''));
    markNamed([username]);
    return true;
  } catch (err) {
    logger.warn(`Pattern matcher: ${err.message}`);
    release();
    return false;
  }
}

// Respuesta fija a una pregunta de identidad (config/identity-replies.json): rota sin repetir la última de ese tipo
const lastIdentityReply = {};
function pickIdentityReply(kind) {
  const pool = (identityReplies[kind] || []).filter(r => r !== lastIdentityReply[kind]);
  const pick = pool[Math.floor(Math.random() * pool.length)] || '';
  lastIdentityReply[kind] = pick;
  return pick;
}

// Réplicas de reserva (config/messages.json), sin repetir la última
let lastProvocationReply = '';
function pickProvocationReply() {
  const pool = (messagesConfig.provocation_replies || []).filter(r => r !== lastProvocationReply);
  const pick = pool[Math.floor(Math.random() * pool.length)] || '';
  lastProvocationReply = pick;
  return pick;
}

// Réplica corta con personalidad; si la IA falla, rechaza o suena latina, se usa la de reserva
async function generateProvocationReply(username, question, maxChars) {
  try {
    const response = await aiChat('provocation', {
      max_tokens: 60,
      messages: [
        { role: 'system', content: buildProvocationSystem() },
        { role: 'user', content: `${username}: ${question}` }
      ]
    }, 1, { maxDelayMs: PROVOCATION_MAX_RETRY_DELAY_MS });
    const choice = response.choices[0];
    const text = choice.finish_reason === 'length' ? quality.dropTrailingFragment(choice.message.content) : (choice.message.content || '').trim();
    // Revisión de sentido (sin datos de juego): si no se entiende, va la de reserva
    if (quality.validateMention(text).ok && text.length <= maxChars && !(await factcheck.evaluate(text, '', { sense: true, checkData: false })).nonsense) return text;
  } catch (err) {
    logger.warn(`Réplica a provocación: ${err.message}`);
  }
  return pickProvocationReply();
}

// Logins distintos que han escrito en los últimos windowMs (más recientes primero)
function getRecentChatters(windowMs = 5 * 60 * 1000, now = Date.now()) {
  const botName = (process.env.BOT_USERNAME || '').toLowerCase();
  const seen = new Set();
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    const m = chatHistory[i];
    if (now - m.ts > windowMs) break;
    const login = String(m.username || '').toLowerCase();
    if (login && login !== botName) seen.add(login);
  }
  return [...seen];
}

function getStreamChatBuffer() {
  return streamChatBuffer.map(m => `${m.username}: ${m.message}`).join('\n');
}

function resetStreamChatBuffer() {
  streamChatBuffer.length = 0;
  recentHooks.length = 0;
  usedStaticHooks.clear();
  resetLoreSample();
}

// Restaurar cooldowns desde Supabase al arrancar (prefijos: question-, chiste-)
function restoreCooldowns(data) {
  const now = Date.now();
  for (const [key, expiresAt] of Object.entries(data)) {
    if (expiresAt <= now) continue;
    if (key.startsWith('question-')) questionCooldowns.set(key.slice('question-'.length), expiresAt);
    if (key.startsWith('chiste-')) chisteCooldowns.set(key, expiresAt);
  }
  logger.info(`✅ Cooldowns restaurados desde Supabase (${Object.keys(data).length})`);
}

module.exports = {
  handleCohost, runCohost, enqueueCohostMoment, startEventCohost, handleChiste, handleQuestion, handleShoutout, handleQueMePerdi,
  addToHistory, updateLastChatTime, getRecentHistory, checkChatHook, checkStreamStatus,
  initStreamStatus, checkForHighlight,
  checkEmoteSpam, checkCapsRage, checkPatternMatch,
  getActiveUsers, getActiveUsersWithMinMessages, resetActiveUsers, onWarmupMode, postStreamEnd,
  getStreamChatBuffer, resetStreamChatBuffer, getRecentChatters,
  restoreCooldowns, clearUserFactsCache, getCachedUserFacts, getActiveUserIds, forgetUserInMemory,
  // solo tests
  addToUserConversation, getUserConversation,
  getChatWindow, NARRATOR_BASE,
};
