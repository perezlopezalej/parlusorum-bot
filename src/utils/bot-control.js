// Controles en vivo para mods y streamers: !fua_callate <min> (silencio temporal) y !fua_modo reactivo|normal. Funciones puras.
const MAX_MUTE_MIN = 120;
const DEFAULT_MUTE_MIN = 10;

// "15" → 15; "0" → 0 (cancelar); sin argumento → 10; fuera de rango o texto → null (uso incorrecto)
function parseMinutes(arg, { def = DEFAULT_MUTE_MIN, max = MAX_MUTE_MIN } = {}) {
  if (arg === undefined || arg === null || String(arg).trim() === '') return def;
  const m = /^(\d{1,4})\s*(?:m|min|minutos?)?$/i.exec(String(arg).trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 0 && n <= max ? n : null;
}

function parseMode(arg) {
  const a = String(arg || '').trim().toLowerCase();
  if (['reactivo', 'reactiva', 'r'].includes(a)) return 'reactivo';
  if (['normal', 'n'].includes(a)) return 'normal';
  return null;
}

// En modo reactivo el bot no inicia nada: solo responde a menciones, comandos y eventos del canal (sub, raid, follow...)
const REACTIVE_BLOCKED = new Set(['cohost', 'hook', 'timer', 'timer_ia', 'highlight', 'emote_spam', 'caps_rage']);
// Con silencio solo salen las respuestas de comandos (p. ej. la del propio !silencio) y los mensajes sin origen
const SILENCE_ALLOWED = new Set(['comando', 'otro']);

// Respaldo en la cola de salida: motivo por el que un mensaje no debe salir, o null
function outboundBlock(origin, { silenced = false, reactive = false } = {}) {
  const o = origin || 'otro';
  if (silenced && !SILENCE_ALLOWED.has(o)) return 'silencio';
  if (reactive && REACTIVE_BLOCKED.has(o)) return 'reactivo';
  return null;
}

// Hora de vuelta en Madrid (HH:MM)
function clockMadrid(ts) {
  return new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts));
}

module.exports = { MAX_MUTE_MIN, DEFAULT_MUTE_MIN, REACTIVE_BLOCKED, SILENCE_ALLOWED, parseMinutes, parseMode, outboundBlock, clockMadrid };
