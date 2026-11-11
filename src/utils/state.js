// Estado compartido entre módulos — evita dependencias circulares
const { pruneNarrative, restoreNarrative, pruneHourly } = require('./narrative');

// --- Trivia ---
let triviaActive = false;
function setTriviaActive(value) { triviaActive = value; }
function isTriviaActive() { return triviaActive; }

// --- Silencio ---
let silenceMode = false;
function setSilenceMode(active) { silenceMode = active; }
// Silencio temporal (!fua_callate): se levanta solo al llegar a muteUntil
let muteUntil = 0;
function setMuteUntil(ts) { muteUntil = Number.isFinite(ts) && ts > 0 ? ts : 0; }
function getMuteUntil(now = Date.now()) { return muteUntil > now ? muteUntil : 0; }
function isSilenced() { return silenceMode || Date.now() < muteUntil; }

// --- Modo del bot: 'normal' o 'reactivo' (solo menciones y comandos) ---
let botMode = 'normal';
function setBotMode(mode) { botMode = mode === 'reactivo' ? 'reactivo' : 'normal'; }
function getBotMode() { return botMode; }
function isReactive() { return botMode === 'reactivo'; }

// --- BRB ---
let brbMode = false;
let brbStart = null;
let brbInterval = null;

function setBrbMode(active, client, channel, startedAt = null) {
  brbMode = active;
  brbStart = active ? (startedAt || Date.now()) : null;

  if (brbInterval) {
    clearInterval(brbInterval);
    brbInterval = null;
  }

  // Recordatorio cada 5 minutos cuando está en BRB
  if (active && client && channel) {
    brbInterval = setInterval(() => {
      const mins = Math.floor((Date.now() - brbStart) / 60000);
      client.say(channel, `⏳ El streamer lleva ${mins} minutos fuera. ¡Ahora vuelve! 🚪`);
    }, 5 * 60 * 1000);
  }
}

function isBrb() { return brbMode; }
function getBrbStart() { return brbStart; }
function getBrbDuration() {
  if (!brbStart) return 0;
  return Math.floor((Date.now() - brbStart) / 60000);
}

// --- Plantillas fijas: índice de la última variante usada por clave (para no repetirla) ---
const templateLast = new Map();
function getTemplateLast(key) { return templateLast.get(key); }
function setTemplateLast(key, i) { templateLast.set(key, i); }

// --- Raid ---
let raidActiveUntil = 0;
let raidUsername = null;
const RAID_DURATION_MS = 5 * 60 * 1000;

function setRaidActive(username, durationMs = RAID_DURATION_MS) {
  raidActiveUntil = Date.now() + durationMs;
  raidUsername = username;
}

function isRaidActive() { return Date.now() < raidActiveUntil; }
function getRaidUsername() { return raidUsername; }

// --- Lotes de subs regaladas (origin-id de submysterygift → expiración) ---
const GIFT_BATCH_TTL_MS = 10 * 60 * 1000;
const giftBatches = new Map();

function markGiftBatch(originId) {
  if (originId) giftBatches.set(originId, Date.now() + GIFT_BATCH_TTL_MS);
}
function isGiftBatch(originId) {
  const exp = originId && giftBatches.get(originId);
  return !!exp && exp > Date.now();
}
setInterval(() => {
  const now = Date.now();
  for (const [id, exp] of giftBatches) if (exp <= now) giftBatches.delete(id);
}, 10 * 60 * 1000).unref();

// --- Narrativa del stream ---
let streamNarrative = [];
let narrativeListener = null;

// Un único listener (la persistencia en Supabase) se entera de cada cambio
function onNarrativeChange(fn) { narrativeListener = fn; }
function notifyNarrative() {
  if (!narrativeListener) return;
  try { narrativeListener(getStreamNarrative()); } catch {}
}

// Segundo listener, solo para eventos nuevos (el cohost por eventos); no salta al restaurar tras un reinicio
let newEventListener = null;
function onNarrativeEvent(fn) { newEventListener = fn; }

// n (opcional): unidades que aporta el evento de golpe (p. ej. "!muertes +3")
function addNarrativeEvent(type, description, n = 1) {
  const event = { type, description, ts: Date.now(), ...(n > 1 ? { n } : {}) };
  streamNarrative.push(event);
  streamNarrative = pruneNarrative(streamNarrative);
  notifyNarrative();
  if (newEventListener) { try { newEventListener(event, getStreamNarrative()); } catch {} }
}
function getStreamNarrative() { return [...streamNarrative]; }
function resetStreamNarrative() { streamNarrative = []; }
// Recuperación tras reinicio: no vuelve a persistir lo que acaba de leer
function setStreamNarrative(events) { streamNarrative = restoreNarrative(events); }

// --- Cohost: marcas de tiempo (tope por hora) y turnos hook/cohost dentro de una pausa del chat ---
let cohostTimes = [];
let lastCohostTime = 0;
let pauseState = { id: null, hookAt: 0 };

// counts=false (fallo de la IA): solo reinicia el cooldown, sin gastar cupo de la hora
function recordCohost(now = Date.now(), counts = true) {
  lastCohostTime = now;
  if (!counts) return;
  cohostTimes = pruneHourly(cohostTimes, now);
  cohostTimes.push(now);
}
function getLastCohostTime() { return lastCohostTime; }
function getCohostTimes() { return [...cohostTimes]; }

// Una pausa del chat se identifica por la hora de su último mensaje; el hook habla como mucho una vez por pausa.
function claimHookPause(pauseId, now = Date.now()) {
  if (pauseState.id === pauseId && pauseState.hookAt) return false;
  pauseState = { id: pauseId, hookAt: now };
  return true;
}

// --- Modo de personalidad ---
let currentMode = 'normal';
let currentVariant = null;
let modeSetAt = 0;

// modeSetAt solo cambia cuando cambia el modo (o su variante): sirve para la permanencia mínima
function setPersonalityMode(mode, variant = null) {
  if (mode === currentMode && variant === currentVariant) return;
  currentMode = mode;
  currentVariant = variant;
  modeSetAt = Date.now();
}
function getPersonalityMode() { return currentMode; }
function getModeVariant() { return currentVariant; }
function getModeSetAt() { return modeSetAt; }

// --- Historial de mensajes propios del bot ---
const MAX_BOT_HISTORY = 8;
let botMessageHistory = [];

function addBotMessage(msg) {
  botMessageHistory.push({ msg, ts: Date.now() });
  if (botMessageHistory.length > MAX_BOT_HISTORY) botMessageHistory.shift();
}

// ¿Llevaron "Lusorums" (quality.limitLusorums) los últimos 3 mensajes enviados por el bot, de cualquier tipo?
const lusorumsHistory = [];
function noteLusorums(had) { lusorumsHistory.push(!!had); if (lusorumsHistory.length > 3) lusorumsHistory.shift(); }
function getLusorumsHistory() { return [...lusorumsHistory]; }

// ¿Cerraron con «¡FUA!» las últimas respuestas a menciones? (quality.limitTrailingFua: solo 1 de cada 3)
const mentionFuaHistory = [];
function noteMentionFua(had) { mentionFuaHistory.push(!!had); if (mentionFuaHistory.length > 3) mentionFuaHistory.shift(); }
function getMentionFuaHistory() { return [...mentionFuaHistory]; }

// Un solo mensaje de inicio por directo: el aviso normal y el de calentamiento se disputan el turno
let startAnnounced = false;
function claimStartAnnouncement() { if (startAnnounced) return false; startAnnounced = true; return true; }
function resetStartAnnouncement() { startAnnounced = false; }

function getBotHistory() { return [...botMessageHistory]; }
function resetBotHistory() { botMessageHistory = []; cohostTextsByKind.clear(); usedStructures.clear(); startAnnounced = false; mentionFuaHistory.length = 0; }

// Estructuras de frase (quality.structureKey) ya usadas por el cohost/timer en este stream
const usedStructures = new Set();
function markStructure(key) { if (key) usedStructures.add(key); }
function getUsedStructures() { return new Set(usedStructures); }

// Textos del cohost de este stream por tipo de momento ('boss', 'first_death', 'free'...): para que un jefe no se comente dos veces igual
const MAX_TEXTS_PER_KIND = 12;
const cohostTextsByKind = new Map();
function addCohostText(kind, text) {
  const list = cohostTextsByKind.get(kind) || [];
  list.push(text);
  if (list.length > MAX_TEXTS_PER_KIND) list.shift();
  cohostTextsByKind.set(kind, list);
}
function getCohostTexts(kind) { return [...(cohostTextsByKind.get(kind) || [])]; }

// --- Usuarios nombrados por el bot (login en minúsculas → ts): evita citar al mismo usuario una y otra vez ---
const NAMED_TTL_MS = 60 * 60 * 1000;
const namedUsers = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of namedUsers) if (now - ts > NAMED_TTL_MS) namedUsers.delete(k);
}, 15 * 60 * 1000).unref();

function markNamed(logins, now = Date.now()) {
  for (const l of logins) namedUsers.set(String(l).toLowerCase(), now);
}
function getNamedUsers() { return new Map(namedUsers); }
function resetNamedUsers() { namedUsers.clear(); }

// --- Contexto del último cohost (anti-repetición de contexto) ---
let lastCohostContextHash = '';
function getLastCohostContextHash() { return lastCohostContextHash; }
function setLastCohostContextHash(hash) { lastCohostContextHash = hash; }

// --- Anclaje periódico de personalidad ---
let messagesSinceReinforce = 0;
const REINFORCE_EVERY = 50;

function tickReinforce() {
  messagesSinceReinforce++;
  if (messagesSinceReinforce >= REINFORCE_EVERY) {
    messagesSinceReinforce = 0;
    return true;
  }
  return false;
}

function resetReinforceCounter() { messagesSinceReinforce = 0; }

// --- Estado de contexto de juego ---
let _gameContextFailed = false;
function setGameContextFailed(val) { _gameContextFailed = val; }
function getGameContextFailed() { return _gameContextFailed; }

// --- Tiempo de último CAPS rage ---
let lastCapsRageTime = 0;
function setLastCapsRageTime(ts) { lastCapsRageTime = ts; }
function getLastCapsRageTime() { return lastCapsRageTime; }

// --- Estado del stream (via EventSub) ---
let streamStartedAt = null;
let streamIsLive = false;
let _sessionStarting = null;

function setStreamStartedAt(val) { streamStartedAt = val; }
function getStreamStartedAt() { return streamStartedAt; }
function setStreamIsLive(val) { streamIsLive = val; }
function getStreamIsLive() { return streamIsLive; }

// Margen tras el fin del directo en el que el bot aún puede despedirse (resumen de fin de stream)
let streamEndGraceUntil = 0;
function setStreamEndGraceUntil(ts) { streamEndGraceUntil = ts; }
function getStreamEndGraceUntil() { return streamEndGraceUntil; }

// Últimos mensajes de usuarios (para que el filtro de salida detecte si el bot los repite tal cual)
const RECENT_USER_TEXTS_MAX = 60;
const RECENT_USER_TEXTS_TTL_MS = 5 * 60 * 1000;
const recentUserTexts = [];
function pushUserText(text, at = Date.now()) {
  recentUserTexts.push({ text: String(text || ''), at });
  while (recentUserTexts.length > RECENT_USER_TEXTS_MAX) recentUserTexts.shift();
}
function getRecentUserTexts(now = Date.now()) {
  while (recentUserTexts.length && now - recentUserTexts[0].at > RECENT_USER_TEXTS_TTL_MS) recentUserTexts.shift();
  return recentUserTexts.slice();
}
function resetRecentUserTexts() { recentUserTexts.length = 0; }
function setSessionStarting(promise) { _sessionStarting = promise; }
function getSessionStarting() { return _sessionStarting; }
function clearSessionStarting() { _sessionStarting = null; }

// --- Contador de muertes ---
let deathCount = 0;
function getDeathCount() { return deathCount; }
function incrementDeathCount() { deathCount++; return deathCount; }
function resetDeathCount() { deathCount = 0; }
function setDeathCount(n) { deathCount = Math.max(0, Math.floor(n) || 0); }

// --- Contador de jefes de la sesión (se persiste igual que las muertes) ---
let bossCount = 0;
function getBossCount() { return bossCount; }
function setBossCount(n) { bossCount = Math.max(0, Math.floor(n) || 0); return bossCount; }
function resetBossCount() { bossCount = 0; }

// --- Predicción activa ---
let activePrediction = null;
function getActivePrediction() { return activePrediction; }
function setActivePrediction(val) { activePrediction = val; }
function clearActivePrediction() { activePrediction = null; }

// --- Estadísticas de trivia (dificultad adaptativa) ---
let triviaStats = { aciertos: 0, fallos: 0, rachaActual: 0 };

function getTriviaStats() { return { ...triviaStats }; }
function registrarAcierto() {
  triviaStats.aciertos++;
  triviaStats.rachaActual = Math.max(0, triviaStats.rachaActual) + 1;
}
function registrarFallo() {
  triviaStats.fallos++;
  triviaStats.rachaActual = Math.min(0, triviaStats.rachaActual) - 1;
}
function resetTriviaStats() {
  triviaStats = { aciertos: 0, fallos: 0, rachaActual: 0 };
}

// --- Ranking de trivia: racha de victorias seguidas del mismo usuario + caché del top ---
let triviaStreak = { username: null, count: 0 };
let triviaTopCache = { data: null, ts: 0 };

function bumpTriviaStreak(username) {
  const u = String(username).toLowerCase();
  triviaStreak = { username: u, count: triviaStreak.username === u ? triviaStreak.count + 1 : 1 };
  return triviaStreak.count;
}
function getTriviaTopCache() { return { ...triviaTopCache }; }
function setTriviaTopCache(data) { triviaTopCache = { data, ts: Date.now() }; }
function invalidateTriviaTopCache() { triviaTopCache = { data: null, ts: 0 }; }

// --- Muestra de chat para aprender lore (reservoir sampling: uniforme sobre todo el stream) ---
const LORE_SAMPLE_SIZE = 400;
let loreSample = [];
let loreSampleSeen = 0;

function addLoreSample(username, message, userId = null) {
  const idx = loreSampleSeen++;
  const entry = { idx, username, message, userId: userId ? String(userId) : null };
  if (loreSample.length < LORE_SAMPLE_SIZE) { loreSample.push(entry); return; }
  const j = Math.floor(Math.random() * (idx + 1));
  if (j < LORE_SAMPLE_SIZE) loreSample[j] = entry;
}
function getLoreSample() {
  return [...loreSample].sort((a, b) => a.idx - b.idx).map(m => `${m.username}: ${m.message}`).join('\n');
}
// nick (minúsculas) → user_id de lo escrito en la muestra
function getLoreSampleIds() {
  const ids = new Map();
  for (const m of loreSample) if (m.userId) ids.set(String(m.username).toLowerCase(), m.userId);
  return ids;
}
function resetLoreSample() { loreSample = []; loreSampleSeen = 0; }

// Coincide por user_id o, en entradas sin id, por nick (minúsculas)
function isSubject(entryUserId, entryName, userId, login) {
  if (userId && entryUserId && String(entryUserId) === String(userId)) return true;
  return !!login && String(entryName || '').toLowerCase() === String(login).toLowerCase();
}
// Privacidad: quita de la muestra de lore lo escrito por un usuario. Devuelve cuántas entradas quitó.
function removeLoreSampleByUser(userId, login) {
  const before = loreSample.length;
  loreSample = loreSample.filter(m => !isSubject(m.userId, m.username, userId, login));
  return before - loreSample.length;
}

// --- Uso de modelos de reserva de Groq en el stream ("pedido→usado" → nº de peticiones) ---
const groqFallbackUse = new Map();
function recordGroqFallback(requested, used) {
  const key = `${requested}→${used}`;
  groqFallbackUse.set(key, (groqFallbackUse.get(key) || 0) + 1);
}
function getGroqFallbackUse() { return Object.fromEntries(groqFallbackUse); }
function resetGroqFallbackUse() { groqFallbackUse.clear(); }

// --- Tokens gastados en Groq por modelo (cada modelo tiene su propio cupo diario) ---
// stream: desde el último resumen de fin de stream. day: acumulado del día UTC (Groq repone el cupo a las 00:00 UTC);
// en memoria, así que un reinicio de Render lo pone a cero y el % del cupo es un mínimo.
const groqTokensStream = new Map();
let groqTokensDay = new Map();
let groqTokensDayKey = '';
function addTokens(map, model, prompt, completion) {
  const cur = map.get(model) || { prompt: 0, completion: 0, calls: 0 };
  cur.prompt += prompt; cur.completion += completion; cur.calls++;
  map.set(model, cur);
}
function recordGroqTokens(model, usage, now = Date.now()) {
  const prompt = Number(usage?.prompt_tokens) || 0;
  const completion = Number(usage?.completion_tokens) || 0;
  const key = new Date(now).toISOString().slice(0, 10);
  if (key !== groqTokensDayKey) { groqTokensDayKey = key; groqTokensDay = new Map(); }
  addTokens(groqTokensStream, model, prompt, completion);
  addTokens(groqTokensDay, model, prompt, completion);
}
const tokensOf = map => Object.fromEntries([...map].map(([m, v]) => [m, { ...v, total: v.prompt + v.completion }]));
function getGroqTokenUse() { return { stream: tokensOf(groqTokensStream), day: tokensOf(groqTokensDay), dayKey: groqTokensDayKey }; }
function resetGroqTokenUse() { groqTokensStream.clear(); }

// --- Cupo real de Groq según las cabeceras x-ratelimit-* (clave "groq:modelo") ---
// Vale hasta su reposición: pasado resetTokensMs (o resetRequestsMs) ese dato ya no se usa.
const groqLimits = new Map();
function noteGroqLimits(key, info, now = Date.now()) {
  if (!info) return;
  groqLimits.set(key, { ...info, at: now });
}
// { remainingTokens?, remainingRequests? } vigentes ahora, o null
function getGroqLimits(key, now = Date.now()) {
  const l = groqLimits.get(key);
  if (!l) return null;
  const out = {};
  if (l.remainingTokens !== undefined && now - l.at < (l.resetTokensMs ?? 60000)) out.remainingTokens = l.remainingTokens;
  if (l.remainingRequests !== undefined && now - l.at < (l.resetRequestsMs ?? 60000)) out.remainingRequests = l.remainingRequests;
  return Object.keys(out).length ? out : null;
}
function resetGroqLimits() { groqLimits.clear(); }

// --- Descarte por filtro (cohost, timer IA, filtro de salida) frente a lo enviado, por origen, para el resumen de fin de stream ---
// No cuentan como filtro: los motivos que no son calidad (silencio, cupo, errores del proveedor...)
const NON_FILTER_REASONS = new Set(['silencio', 'reactivo', 'brb', 'trivia', 'ratelimit', 'racha_cupo', 'skip', 'sin_cupo', 'groq429', 'error']);
const filterDiscards = new Map(); // origen → Map(motivo → n)
const filterSent = new Map();     // origen → n enviados
function recordFilterDiscard(origin, reason) {
  if (!reason || NON_FILTER_REASONS.has(reason)) return;
  const m = filterDiscards.get(origin) || new Map();
  m.set(reason, (m.get(reason) || 0) + 1);
  filterDiscards.set(origin, m);
}
function recordFilterSent(origin) { const o = origin || 'otro'; filterSent.set(o, (filterSent.get(o) || 0) + 1); }
function getFilterStats() {
  const origins = new Set([...filterDiscards.keys(), ...filterSent.keys()]);
  const out = {};
  for (const o of origins) {
    const reasons = Object.fromEntries(filterDiscards.get(o) || []);
    const discarded = Object.values(reasons).reduce((a, b) => a + b, 0);
    out[o] = { sent: filterSent.get(o) || 0, discarded, reasons };
  }
  return out;
}
function resetFilterStats() { filterDiscards.clear(); filterSent.clear(); }

// --- Router de IA: bloqueos, uso por minuto y por día, y nicks conocidos ---
// Clave de modelo: "proveedor:modelo". Todo en memoria: un reinicio lo pone a cero.
const aiBlocks = new Map();
function blockAi(key, until) { aiBlocks.set(key, until); }
function aiBlockedUntil(key) { return aiBlocks.get(key) || 0; }
function isAiBlocked(key, now = Date.now()) { return aiBlockedUntil(key) > now; }
function resetAiBlocks() { aiBlocks.clear(); }

// Groq repone el cupo a las 00:00 UTC; Gemini a medianoche del Pacífico (09:00 en España)
const PACIFIC_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
const PACIFIC_CLOCK_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function aiDayKey(provider, now = Date.now()) {
  return provider === 'gemini' ? PACIFIC_FMT.format(now) : new Date(now).toISOString().slice(0, 10);
}
// Ms hasta la próxima medianoche del Pacífico (en los dos días de cambio de hora se desvía como mucho 1 h)
function msUntilPacificMidnight(now = Date.now()) {
  const [h, m, s] = PACIFIC_CLOCK_FMT.format(now).split(':').map(Number);
  return 86400000 - ((h * 60 + m) * 60 + s) * 1000 - (now % 1000);
}

const AI_MINUTE_MS = 60 * 1000;
const aiMinute = new Map(); // clave → [{ at, tokens }] de los últimos 60 s
const aiDay = new Map();    // clave → { day, requests, prompt, completion }
const aiStream = new Map(); // clave → { requests, prompt, completion }

// Se llama al enviar la petición (los intentos fallidos también gastan RPD); estTokens se afina con finishAiRequest
function startAiRequest(provider, model, estTokens = 0, now = Date.now()) {
  const key = `${provider}:${model}`;
  const window = aiMinute.get(key) || [];
  aiMinute.set(key, window);
  while (window.length && now - window[0].at > AI_MINUTE_MS) window.shift();
  const entry = { at: now, tokens: estTokens };
  window.push(entry);
  const dayKey = aiDayKey(provider, now);
  let day = aiDay.get(key);
  if (!day || day.day !== dayKey) { day = { day: dayKey, requests: 0, prompt: 0, completion: 0 }; aiDay.set(key, day); }
  day.requests++;
  const stream = aiStream.get(key) || { requests: 0, prompt: 0, completion: 0 };
  stream.requests++;
  aiStream.set(key, stream);
  return { key, entry, day, stream };
}
function finishAiRequest(handle, usage) {
  const prompt = Number(usage?.prompt_tokens) || 0;
  const completion = Number(usage?.completion_tokens) || 0;
  if (prompt + completion > 0) handle.entry.tokens = prompt + completion;
  handle.day.prompt += prompt; handle.day.completion += completion;
  handle.stream.prompt += prompt; handle.stream.completion += completion;
}
function getAiMinuteUsage(key, now = Date.now()) {
  const window = (aiMinute.get(key) || []).filter(e => now - e.at <= AI_MINUTE_MS);
  return { requests: window.length, tokens: window.reduce((sum, e) => sum + e.tokens, 0) };
}
function getAiDayUsage(key, now = Date.now()) {
  const day = aiDay.get(key);
  const [provider] = key.split(':');
  return day && day.day === aiDayKey(provider, now) ? { requests: day.requests, tokens: day.prompt + day.completion } : { requests: 0, tokens: 0 };
}
function getAiUsage(now = Date.now()) {
  const out = {};
  for (const key of new Set([...aiStream.keys(), ...aiDay.keys()])) {
    const st = aiStream.get(key) || { requests: 0, prompt: 0, completion: 0 };
    out[key] = { stream: { requests: st.requests, tokens: st.prompt + st.completion }, day: getAiDayUsage(key, now) };
  }
  return out;
}
function resetAiStreamUsage() { aiStream.clear(); }
function resetAiUsage() { aiStream.clear(); aiMinute.clear(); aiDay.clear(); }

// Nicks vistos en el chat (para seudonimizarlos en los prompts que se mandan a Groq)
const CHATTER_TTL_MS = 3 * 60 * 60 * 1000;
const CHATTER_MAX = 400;
const chatters = new Map();
function noteChatter(username, now = Date.now()) {
  const name = String(username || '').replace(/^@/, '').trim();
  if (!name) return;
  chatters.delete(name);
  chatters.set(name, now);
  if (chatters.size > CHATTER_MAX) chatters.delete(chatters.keys().next().value);
}
function getChatterNames(now = Date.now()) {
  return [...chatters].filter(([, at]) => now - at < CHATTER_TTL_MS).map(([name]) => name);
}
function resetChatters() { chatters.clear(); }
setInterval(() => { const now = Date.now(); for (const [n, at] of chatters) if (now - at >= CHATTER_TTL_MS) chatters.delete(n); }, 30 * 60 * 1000).unref();

// --- Quién juega ahora: Manu por defecto; un mod lo cambia con !juega pao|manu y vuelve a Manu al empezar cada stream ---
const PLAYERS = ['manu', 'pao', 'ambos'];
const PLAYER_ALIASES = { 'los dos': 'ambos', 'ambas': 'ambos', 'los 2': 'ambos' };
let currentPlayer = 'manu';
function getPlayer() { return currentPlayer; }
function setPlayer(name) {
  const raw = String(name || '').trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ');
  const p = PLAYER_ALIASES[raw] || raw;
  if (!PLAYERS.includes(p)) return false;
  currentPlayer = p;
  return true;
}
function resetPlayer() { currentPlayer = 'manu'; }

// --- Cohost libre en pausa (alguien pide al bot que se calle): hasta esa hora solo hablan los eventos y las menciones ---
let cohostPausedUntil = 0;
function pauseFreeCohost(ms, now = Date.now()) { cohostPausedUntil = now + ms; }
function isFreeCohostPaused(now = Date.now()) { return now < cohostPausedUntil; }
function resetFreeCohostPause() { cohostPausedUntil = 0; }

// --- Descartes del cohost en el stream (motivo → nº), para el resumen de fin de stream ---
const cohostDiscards = new Map();
function recordCohostDiscard(reason) {
  cohostDiscards.set(reason, (cohostDiscards.get(reason) || 0) + 1);
  recordFilterDiscard('cohost', String(reason || '').replace(/^quality:/, ''));
}
function getCohostDiscards() { return Object.fromEntries(cohostDiscards); }
function resetCohostDiscards() { cohostDiscards.clear(); }

// Intentos y envíos del cohost por tipo ('event' | 'free'), y 429 de Groq (límite del proveedor, no el interno)
const cohostAttempts = { event: 0, free: 0 };
const cohostSent = { event: 0, free: 0 };
let groq429Count = 0;
function recordCohostAttempt(kind) { cohostAttempts[kind === 'free' ? 'free' : 'event']++; }
function recordCohostSent(kind) { cohostSent[kind === 'free' ? 'free' : 'event']++; recordFilterSent('cohost'); }
function recordGroq429() { groq429Count++; }
function getCohostStats() {
  return { attempts: { ...cohostAttempts }, sent: { ...cohostSent }, discards: getCohostDiscards(), groq429: groq429Count };
}
function resetCohostStats() {
  cohostAttempts.event = cohostAttempts.free = cohostSent.event = cohostSent.free = 0;
  groq429Count = 0;
  cohostDiscards.clear();
}

// --- Usuarios que acaban de pedir ser olvidados: sin bienvenida de «primer mensaje» durante 10 min ---
const FORGOTTEN_TTL_MS = 10 * 60 * 1000;
const forgottenUsers = new Map(); // user_id → caduca
function markForgotten(userId, now = Date.now()) { if (userId) forgottenUsers.set(String(userId), now + FORGOTTEN_TTL_MS); }
function wasRecentlyForgotten(userId, now = Date.now()) {
  const exp = forgottenUsers.get(String(userId));
  return !!exp && exp > now;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of forgottenUsers) if (v < now) forgottenUsers.delete(k); }, 5 * 60 * 1000).unref();

// --- Cola del registro de chat (se vuelca a Supabase por lotes; ver utils/chatlog.js) ---
const CHATLOG_MAX_BUFFER = 1000;
let chatLogBuffer = [];

function pushChatLog(row) {
  chatLogBuffer.push(row);
  if (chatLogBuffer.length > CHATLOG_MAX_BUFFER) chatLogBuffer.splice(0, chatLogBuffer.length - CHATLOG_MAX_BUFFER);
  return chatLogBuffer.length;
}
function takeChatLog(n) { return chatLogBuffer.splice(0, n); }
// Devuelve al principio los que no se pudieron guardar, sin pasar del tope (se pierden los más antiguos)
function requeueChatLog(rows) {
  chatLogBuffer = [...rows, ...chatLogBuffer].slice(-CHATLOG_MAX_BUFFER);
}
function getChatLogSize() { return chatLogBuffer.length; }
// Privacidad: quita de la cola pendiente los mensajes de un usuario. Devuelve cuántos quitó.
function removeChatLogByUser(userId, login) {
  const before = chatLogBuffer.length;
  chatLogBuffer = chatLogBuffer.filter(r => !isSubject(r.user_id, r.username, userId, login));
  return before - chatLogBuffer.length;
}

module.exports = {
  pushChatLog, takeChatLog, requeueChatLog, getChatLogSize, removeChatLogByUser, removeLoreSampleByUser, markForgotten, wasRecentlyForgotten,
  recordGroqFallback, getGroqFallbackUse, resetGroqFallbackUse,
  recordGroqTokens, getGroqTokenUse, resetGroqTokenUse,
  blockAi, aiBlockedUntil, isAiBlocked, resetAiBlocks, aiDayKey,
  startAiRequest, finishAiRequest, getAiMinuteUsage, getAiDayUsage, getAiUsage, resetAiStreamUsage, resetAiUsage,
  noteChatter, getChatterNames, resetChatters,
  recordCohostDiscard, getCohostDiscards, resetCohostDiscards,
  getPlayer, setPlayer, resetPlayer, pauseFreeCohost, isFreeCohostPaused, resetFreeCohostPause,
  recordCohostAttempt, recordCohostSent, recordGroq429, getCohostStats, resetCohostStats,
  addLoreSample, getLoreSample, getLoreSampleIds, resetLoreSample,
  setTriviaActive, isTriviaActive,
  getTemplateLast, setTemplateLast,
  noteGroqLimits, getGroqLimits, resetGroqLimits,
  recordFilterDiscard, recordFilterSent, getFilterStats, resetFilterStats,
  setSilenceMode, isSilenced, setMuteUntil, getMuteUntil, setBotMode, getBotMode, isReactive,
  setBrbMode, isBrb, getBrbDuration, getBrbStart,
  setRaidActive, isRaidActive, getRaidUsername,
  markGiftBatch, isGiftBatch,
  setPersonalityMode, getPersonalityMode, getModeVariant, getModeSetAt,
  addNarrativeEvent, onNarrativeEvent, getStreamNarrative, resetStreamNarrative, setStreamNarrative, onNarrativeChange,
  recordCohost, getLastCohostTime, getCohostTimes, claimHookPause,
  addBotMessage, noteLusorums, getLusorumsHistory, noteMentionFua, getMentionFuaHistory, claimStartAnnouncement, resetStartAnnouncement, getBotHistory, resetBotHistory, addCohostText, getCohostTexts, markNamed, getNamedUsers, resetNamedUsers,
  getLastCohostContextHash, setLastCohostContextHash,
  tickReinforce, resetReinforceCounter,
  setGameContextFailed, getGameContextFailed,
  setLastCapsRageTime, getLastCapsRageTime,
  setStreamStartedAt, getStreamStartedAt,
  setStreamIsLive, getStreamIsLive, setStreamEndGraceUntil, getStreamEndGraceUntil,
  pushUserText, getRecentUserTexts, resetRecentUserTexts,
  setSessionStarting, getSessionStarting, clearSessionStarting,
  getDeathCount, incrementDeathCount, resetDeathCount, setDeathCount,
  getBossCount, setBossCount, resetBossCount, markStructure, getUsedStructures,
  getActivePrediction, setActivePrediction, clearActivePrediction,
  getTriviaStats, registrarAcierto, registrarFallo, resetTriviaStats,
  bumpTriviaStreak, getTriviaTopCache, setTriviaTopCache, invalidateTriviaTopCache,
};
