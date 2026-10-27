// Lógica pura de la narrativa del stream y del disparo del cohost (sin estado ni I/O)

const MAX_NARRATIVE_EVENTS = 12;
const HOUR_MS = 60 * 60 * 1000;

// Qué eventos se conservan primero cuando hay que podar (mayor = más importante)
const EVENT_PRIORITY = { sub: 3, raid: 3, boss: 3, milestone: 3, death: 2, victory: 2, rage: 1 };
const priorityOf = type => EVENT_PRIORITY[type] ?? 1;

// Poda hasta `max` eventos: descarta el de menor prioridad y, a igualdad, el más antiguo. Conserva el orden cronológico.
function pruneNarrative(events, max = MAX_NARRATIVE_EVENTS) {
  const out = [...events];
  while (out.length > max) {
    let drop = 0;
    for (let i = 1; i < out.length; i++) {
      if (priorityOf(out[i].type) < priorityOf(out[drop].type)) drop = i;
    }
    out.splice(drop, 1);
  }
  return out;
}

// Normaliza lo leído de Supabase: solo eventos válidos, ordenados y con tope
function restoreNarrative(raw, max = MAX_NARRATIVE_EVENTS) {
  if (!Array.isArray(raw)) return [];
  const valid = raw
    .filter(e => e && typeof e.type === 'string' && typeof e.description === 'string' && Number.isFinite(e.ts))
    .map(e => ({ type: e.type.slice(0, 20), description: e.description.slice(0, 200), ts: e.ts }))
    .sort((a, b) => a.ts - b.ts);
  return pruneNarrative(valid, max);
}

function relativeTime(ts, now) {
  const mins = Math.max(0, Math.round((now - ts) / 60000));
  return mins < 1 ? 'ahora' : `hace ${mins}min`;
}

// Bloque <stream_story> para los prompts; '' si no hay eventos
function buildStoryBlock(events, now = Date.now()) {
  if (!events || events.length === 0) return '';
  return `\n<stream_story>${events.map(e => `[${relativeTime(e.ts, now)}] [${e.type}] ${e.description}`).join(' | ')}</stream_story>`;
}

const STOPWORDS = new Set(['para', 'pero', 'como', 'esto', 'esta', 'este', 'esos', 'esas', 'solo', 'muy', 'que', 'por', 'con', 'una', 'uno', 'los', 'las', 'del', 'porque', 'cuando', 'donde', 'ahora', 'tambien', 'también', 'todo', 'todos', 'pues', 'bien', 'jaja', 'jajaja']);

// Condensa líneas de chat en una frase de contexto sin llamar a la IA
function condenseChat(lines, { topUsers = 3, topWords = 4, lastN = 3, maxLast = 80 } = {}) {
  if (!lines || lines.length === 0) return '';
  const users = new Map();
  const words = new Map();
  for (const { username, message } of lines) {
    users.set(username, (users.get(username) || 0) + 1);
    for (const w of new Set(String(message).toLowerCase().split(/[^\p{L}\p{N}_]+/u))) {
      if (w.length >= 4 && !STOPWORDS.has(w)) words.set(w, (words.get(w) || 0) + 1);
    }
  }
  const top = (map, n, min) => [...map.entries()].filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1]).slice(0, n);
  const userPart = top(users, topUsers, 1).map(([u, c]) => `${u}(${c})`).join(', ');
  const wordPart = top(words, topWords, 2).map(([w]) => w).join(', ');
  const last = lines.slice(-lastN).map(m => `${m.username}: ${String(m.message).slice(0, maxLast)}`).join(' / ');
  return `${lines.length} mensajes de ${users.size} usuarios. Más activos: ${userPart}.`
    + (wordPart ? ` Se repite: ${wordPart}.` : '')
    + ` Últimos: ${last}`;
}

// Probabilidad por mensaje: 0 dentro del cooldown; `base` justo al salir y crece con el silencio del cohost hasta `cap`
function cohostProbability({ base, multiplier = 1, elapsedMs, cooldownMs, cap = 0.9 }) {
  if (elapsedMs < cooldownMs) return 0;
  const ramp = 1 + 3 * ((elapsedMs - cooldownMs) / Math.max(cooldownMs, 1));
  return Math.min(cap, base * multiplier * ramp);
}

// Descarta marcas de más de 1 h y dice si se alcanzó el tope por hora
function pruneHourly(stamps, now = Date.now()) {
  return stamps.filter(t => now - t < HOUR_MS);
}
function hourlyCapReached(stamps, max, now = Date.now()) {
  return pruneHourly(stamps, now).length >= max;
}

module.exports = {
  MAX_NARRATIVE_EVENTS, pruneNarrative, restoreNarrative, buildStoryBlock, condenseChat,
  cohostProbability, pruneHourly, hourlyCapReached,
};
