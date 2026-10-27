// Estado compartido entre módulos — evita dependencias circulares

// --- Trivia ---
let triviaActive = false;
function setTriviaActive(value) { triviaActive = value; }
function isTriviaActive() { return triviaActive; }

// --- Silencio ---
let silenceMode = false;
function setSilenceMode(active) { silenceMode = active; }
function isSilenced() { return silenceMode; }

// --- BRB ---
let brbMode = false;
let brbStart = null;
let brbInterval = null;

function setBrbMode(active, client, channel) {
  brbMode = active;
  brbStart = active ? Date.now() : null;

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
function getBrbDuration() {
  if (!brbStart) return 0;
  return Math.floor((Date.now() - brbStart) / 60000);
}

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
const MAX_NARRATIVE_EVENTS = 5;
let streamNarrative = [];

function addNarrativeEvent(type, description) {
  streamNarrative.push({ type, description, ts: Date.now() });
  if (streamNarrative.length > MAX_NARRATIVE_EVENTS) streamNarrative.shift();
}
function getStreamNarrative() { return [...streamNarrative]; }
function resetStreamNarrative() { streamNarrative = []; }

// --- Modo de personalidad ---
let currentMode = 'normal';
let modeSetAt = 0;

function setPersonalityMode(mode) {
  currentMode = mode;
  modeSetAt = Date.now();
}
function getPersonalityMode() { return currentMode; }
function getModeSetAt() { return modeSetAt; }

// --- Historial de mensajes propios del bot ---
const MAX_BOT_HISTORY = 3;
let botMessageHistory = [];

function addBotMessage(msg) {
  botMessageHistory.push({ msg, ts: Date.now() });
  if (botMessageHistory.length > MAX_BOT_HISTORY) botMessageHistory.shift();
}

function getBotHistory() { return [...botMessageHistory]; }
function resetBotHistory() { botMessageHistory = []; }

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
function setSessionStarting(promise) { _sessionStarting = promise; }
function getSessionStarting() { return _sessionStarting; }
function clearSessionStarting() { _sessionStarting = null; }

// --- Contador de muertes ---
let deathCount = 0;
function getDeathCount() { return deathCount; }
function incrementDeathCount() { deathCount++; return deathCount; }
function resetDeathCount() { deathCount = 0; }
function setDeathCount(n) { deathCount = Math.max(0, Math.floor(n) || 0); }

// --- Profecía de muertes del stream ({ deaths, text, game, ts } o null) ---
let streamProphecy = null;
function getProphecy() { return streamProphecy ? { ...streamProphecy } : null; }
function setProphecy(val) { streamProphecy = val; }
function clearProphecy() { streamProphecy = null; }

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

function addLoreSample(username, message) {
  const idx = loreSampleSeen++;
  const entry = { idx, username, message };
  if (loreSample.length < LORE_SAMPLE_SIZE) { loreSample.push(entry); return; }
  const j = Math.floor(Math.random() * (idx + 1));
  if (j < LORE_SAMPLE_SIZE) loreSample[j] = entry;
}
function getLoreSample() {
  return [...loreSample].sort((a, b) => a.idx - b.idx).map(m => `${m.username}: ${m.message}`).join('\n');
}
function resetLoreSample() { loreSample = []; loreSampleSeen = 0; }

module.exports = {
  addLoreSample, getLoreSample, resetLoreSample,
  setTriviaActive, isTriviaActive,
  setSilenceMode, isSilenced,
  setBrbMode, isBrb, getBrbDuration,
  setRaidActive, isRaidActive, getRaidUsername,
  markGiftBatch, isGiftBatch,
  setPersonalityMode, getPersonalityMode, getModeSetAt,
  addNarrativeEvent, getStreamNarrative, resetStreamNarrative,
  addBotMessage, getBotHistory, resetBotHistory,
  getLastCohostContextHash, setLastCohostContextHash,
  tickReinforce, resetReinforceCounter,
  setGameContextFailed, getGameContextFailed,
  setLastCapsRageTime, getLastCapsRageTime,
  setStreamStartedAt, getStreamStartedAt,
  setStreamIsLive, getStreamIsLive,
  setSessionStarting, getSessionStarting, clearSessionStarting,
  getDeathCount, incrementDeathCount, resetDeathCount, setDeathCount,
  getProphecy, setProphecy, clearProphecy,
  getActivePrediction, setActivePrediction, clearActivePrediction,
  getTriviaStats, registrarAcierto, registrarFallo, resetTriviaStats,
  bumpTriviaStreak, getTriviaTopCache, setTriviaTopCache, invalidateTriviaTopCache,
};
