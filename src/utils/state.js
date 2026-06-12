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

module.exports = {
  setTriviaActive, isTriviaActive,
  setSilenceMode, isSilenced,
  setBrbMode, isBrb, getBrbDuration,
  setRaidActive, isRaidActive, getRaidUsername,
  setPersonalityMode, getPersonalityMode, getModeSetAt,
  addNarrativeEvent, getStreamNarrative, resetStreamNarrative,
  addBotMessage, getBotHistory, resetBotHistory,
  tickReinforce, resetReinforceCounter,
  setGameContextFailed, getGameContextFailed,
  setLastCapsRageTime, getLastCapsRageTime,
  setStreamStartedAt, getStreamStartedAt,
  setStreamIsLive, getStreamIsLive,
  setSessionStarting, getSessionStarting, clearSessionStarting,
  getDeathCount, incrementDeathCount, resetDeathCount,
  getActivePrediction, setActivePrediction, clearActivePrediction,
  getTriviaStats, registrarAcierto, registrarFallo, resetTriviaStats,
};
