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

module.exports = {
  setTriviaActive, isTriviaActive,
  setSilenceMode, isSilenced,
  setBrbMode, isBrb, getBrbDuration,
  setRaidActive, isRaidActive, getRaidUsername
};
