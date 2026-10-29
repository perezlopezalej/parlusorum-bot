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

// --- Modo de personalidad: se decide con la narrativa y caduca por la hora de cada evento ---
const MODE_WINDOWS = { victory: 5 * 60 * 1000, hype: 3 * 60 * 1000, deaths: 10 * 60 * 1000, chat: 5 * 60 * 1000 };
const MIN_MODE_DWELL_MS = 60 * 1000;   // permanencia mínima, salvo subida a victory/hype/BRB
const DEATHS_FOR_FOCUS = 3;
const CALM_CHAT_MAX_MSGS = 5;          // menos mensajes que esto en MODE_WINDOWS.chat = chat tranquilo

const latestTs = (events, types, now, windowMs) =>
  events.reduce((max, e) => (types.includes(e.type) && now - e.ts < windowMs && e.ts > max ? e.ts : max), 0);

// prev = { mode, variant, setAt } del modo actual. Devuelve { mode, variant } (variant solo en focus: 'brb' | 'deaths').
function decideMode({ now = Date.now(), events = [], raidActive = false, brb = false, capsRageAt = 0, recentChatCount = 0, prev = null } = {}) {
  const celebrationTs = latestTs(events, ['victory', 'boss', 'milestone'], now, MODE_WINDOWS.victory);
  const deathTs = latestTs(events, ['death'], now, MODE_WINDOWS.deaths);
  const deaths = events.filter(e => e.type === 'death' && now - e.ts < MODE_WINDOWS.deaths).length;

  let next;
  if (brb) next = { mode: 'focus', variant: 'brb' };
  else if (celebrationTs && celebrationTs >= deathTs) next = { mode: 'victory', variant: null };
  else if (raidActive || now - capsRageAt < MODE_WINDOWS.hype || latestTs(events, ['sub', 'raid'], now, MODE_WINDOWS.hype)) next = { mode: 'hype', variant: null };
  else if (deaths >= DEATHS_FOR_FOCUS) next = { mode: 'focus', variant: 'deaths' };
  else if (recentChatCount < CALM_CHAT_MAX_MSGS) next = { mode: 'chill', variant: null };
  else next = { mode: 'normal', variant: null };

  const changed = !prev || prev.mode !== next.mode || (prev.variant ?? null) !== next.variant;
  const urgent = next.mode === 'victory' || next.mode === 'hype' || next.variant === 'brb';
  if (changed && prev && !urgent && now - prev.setAt < MIN_MODE_DWELL_MS) return { mode: prev.mode, variant: prev.variant ?? null };
  return next;
}

// Config del modo; las variantes (p. ej. focus/brb) sobrescriben al modo base
function resolveModeConfig(modes, mode, variant = null) {
  const base = (modes && (modes[mode] || modes.normal)) || {};
  return variant && base.variants && base.variants[variant] ? { ...base, ...base.variants[variant] } : base;
}

// --- Cohost por eventos: solo momentos destacados, con freno ---
const EVENT_COHOST_MIN_GAP_MS = 5 * 60 * 1000;
const EVENT_COHOST_MAX_PER_HOUR = 6;
const RANDOM_COHOST_GAP_MS = HOUR_MS;      // como mucho un comentario al azar por hora
const DEATH_STREAK_WINDOW_MS = 10 * 60 * 1000;
const DEATH_STREAK_SIZE = 3;
const STREAK_BREAKERS = ['boss', 'victory', 'milestone'];

// Muertes seguidas (eventos 'death' sin boss/victoria por medio) dentro de la ventana, contando hasta `now`
function deathStreakLength(events, now = Date.now(), windowMs = DEATH_STREAK_WINDOW_MS) {
  let n = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (now - e.ts >= windowMs) break;
    if (STREAK_BREAKERS.includes(e.type)) break;
    if (e.type === 'death') n++;
  }
  return n;
}

// ¿Merece comentario el evento recién añadido? Devuelve { kind, description } o null.
// Muertes: solo la primera, cada racha de 3 seguidas y el récord (supera la sesión con más muertes anotadas); no cada muerte.
function classifyCohostMoment(event, { events = [], deathCount = 0, recordToBeat = 0, now = Date.now() } = {}) {
  if (!event) return null;
  const { type, description } = event;
  if (['boss', 'sub', 'raid', 'milestone', 'victory'].includes(type)) return { kind: type, description };
  if (type !== 'death') return null;
  if (recordToBeat > 0 && deathCount === recordToBeat + 1) return { kind: 'record', description: `${description}. Es un récord de muertes: supera a cualquier otro stream anotado` };
  if (deathCount === 1) return { kind: 'first_death', description };
  const streak = deathStreakLength(events, now);
  if (streak >= DEATH_STREAK_SIZE && streak % DEATH_STREAK_SIZE === 0) return { kind: 'streak', description: `Racha de muertes seguidas sin superar un jefe (${deathCount} en total hoy)` };
  return null;
}

// Freno del cohost por eventos: 5 min desde cualquier cohost y tope por hora
function eventCohostAllowed({ now = Date.now(), lastAt = 0, stamps = [], minGapMs = EVENT_COHOST_MIN_GAP_MS, max = EVENT_COHOST_MAX_PER_HOUR } = {}) {
  if (lastAt && now - lastAt < minGapMs) return false;
  return !hourlyCapReached(stamps, max, now);
}

// Comentario al azar: máx. 1 por hora, solo con el chat tranquilo y sin haber hablado el cohost hace poco
function randomCohostAllowed({ now = Date.now(), lastRandomAt = 0, lastAnyAt = 0, mode = 'normal', minGapMs = EVENT_COHOST_MIN_GAP_MS } = {}) {
  if (mode !== 'chill') return false;
  if (lastRandomAt && now - lastRandomAt < RANDOM_COHOST_GAP_MS) return false;
  return !(lastAnyAt && now - lastAnyAt < minGapMs);
}

module.exports = {
  MAX_NARRATIVE_EVENTS, pruneNarrative, restoreNarrative, buildStoryBlock, condenseChat,
  cohostProbability, pruneHourly, hourlyCapReached,
  EVENT_COHOST_MIN_GAP_MS, EVENT_COHOST_MAX_PER_HOUR, RANDOM_COHOST_GAP_MS, deathStreakLength, classifyCohostMoment, eventCohostAllowed, randomCohostAllowed,
  MODE_WINDOWS, MIN_MODE_DWELL_MS, DEATHS_FOR_FOCUS, CALM_CHAT_MAX_MSGS, decideMode, resolveModeConfig,
};
