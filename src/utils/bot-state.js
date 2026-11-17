/**
 * bot-state.js — Conserva entre reinicios lo que cambia a mano durante un directo:
 * !silencio, !brb, !juega y los contadores de muertes y jefes, y los contadores del stream
 * (cohost, filtros, uso de la IA, control de repetición) que alimentan el resumen de fin de directo.
 *
 * Se guarda en Supabase (tabla bot_state, migración 009) y solo se restaura si pertenece al directo
 * en curso (mismo started_at). Sin directo no hay nada que conservar de ese directo: se guarda vacío,
 * salvo el consumo diario de Groq (`groqDay`), que vale mientras sea el mismo día UTC.
 */
const logger = require('./logger');
const state = require('./state');
const metrics = require('./metrics');
const { sanitizePendingEnd } = require('./stream-session');

const PLAYERS = ['manu', 'pao', 'ambos'];
const SAVE_DEBOUNCE_MS = 1000;
// Los contadores cambian con cada llamada a la IA: como mucho un guardado cada 30 s (se pierde ese margen en un reinicio)
const COUNTERS_SAVE_MS = 30 * 1000;
const STARTED_AT_TOLERANCE_MS = 5000;

const count = (n) => (Number.isInteger(n) && n >= 0 ? n : 0);
const isObject = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const dayKeyOf = (now) => new Date(now).toISOString().slice(0, 10);

// Lo que se guarda. Sin directo: nada del directo (así un estado viejo nunca se restaura en el siguiente stream)
function buildSnapshot(
  {
    live,
    streamStartedAt,
    silenced,
    brbStart,
    player,
    deaths,
    bosses,
    muteUntil,
    mode,
    pendingEnd,
    counters,
    restarts,
    groqDay,
  },
  now = Date.now(),
) {
  const day = isObject(groqDay) ? { groqDay } : {};
  // Sin directo solo se conserva un corte pendiente de confirmar (para cerrarlo tras un reinicio)
  if (!live || !streamStartedAt) {
    const pending = sanitizePendingEnd(pendingEnd);
    return pending
      ? { v: 1, live: false, pendingEnd: pending, ...day, savedAt: now }
      : { v: 1, live: false, ...day, savedAt: now };
  }
  return {
    v: 1,
    live: true,
    streamStartedAt,
    silenced: !!silenced,
    brbStart: brbStart || null,
    player: player || null,
    deaths: count(deaths),
    bosses: count(bosses),
    muteUntil: Number.isFinite(muteUntil) && muteUntil > now ? muteUntil : 0,
    mode: mode === 'reactivo' ? 'reactivo' : 'normal',
    ...(isObject(counters) ? { counters } : {}),
    restarts: count(restarts),
    ...day,
    savedAt: now,
  };
}

// Lo que se aplica al arrancar, o null si no procede (no hay directo, o lo guardado era de otro directo)
function restorableState(saved, { live, streamStartedAt }, now = Date.now()) {
  if (!live || !streamStartedAt || !saved || saved.v !== 1 || !saved.live) return null;
  if (
    !Number.isFinite(saved.streamStartedAt) ||
    Math.abs(saved.streamStartedAt - streamStartedAt) > STARTED_AT_TOLERANCE_MS
  )
    return null;
  return {
    silenced: !!saved.silenced,
    brbStart: Number.isFinite(saved.brbStart) && saved.brbStart > 0 ? saved.brbStart : null,
    player: PLAYERS.includes(saved.player) ? saved.player : null,
    deaths: count(saved.deaths),
    bosses: count(saved.bosses),
    // El silencio temporal solo se restaura si aún no ha caducado
    muteUntil: Number.isFinite(saved.muteUntil) && saved.muteUntil > now ? saved.muteUntil : 0,
    mode: saved.mode === 'reactivo' ? 'reactivo' : 'normal',
    counters: isObject(saved.counters) ? saved.counters : null,
    restarts: count(saved.restarts),
  };
}

// El consumo diario de Groq no depende del directo: vale si es del mismo día UTC (el cupo se repone a las 00:00 UTC)
function restorableGroqDay(saved, now = Date.now()) {
  const day = saved?.groqDay;
  return isObject(day) && day.dayKey === dayKeyOf(now) ? day : null;
}

function currentSnapshot() {
  return buildSnapshot({
    live: state.getStreamIsLive(),
    streamStartedAt: state.getStreamStartedAt(),
    silenced: state.isSilenced(),
    brbStart: state.isBrb() ? state.getBrbStart() : null,
    player: state.getPlayer(),
    deaths: state.getDeathCount(),
    bosses: state.getBossCount(),
    muteUntil: state.getMuteUntil(),
    mode: state.getBotMode(),
    pendingEnd: state.getPendingEnd(),
    counters: { ...state.exportStreamCounters(), metrics: metrics.exportMetrics() },
    restarts: state.getStreamRestarts(),
    groqDay: state.exportGroqDay(),
  });
}

let saveTimer = null;
let countersTimer = null;
let lastSaveAt = 0;

function save() {
  lastSaveAt = Date.now();
  require('./supabase')
    .saveBotState(currentSnapshot())
    .catch(() => {});
}

// Guarda el estado actual (con un pequeño retraso para agrupar cambios seguidos). Nunca lanza.
function persistBotState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

// Guardado de los contadores: como mucho uno cada 30 s (cualquier guardado reciente cuenta). Nunca lanza.
function persistCounters(now = Date.now()) {
  if (countersTimer) return;
  const wait = Math.max(SAVE_DEBOUNCE_MS, lastSaveAt + COUNTERS_SAVE_MS - now);
  countersTimer = setTimeout(() => {
    countersTimer = null;
    save();
  }, wait);
  countersTimer.unref?.();
}

// Al arrancar, tras comprobar con Twitch si el directo sigue. Los contadores ganan por el mayor valor
// (la sesión de Supabase puede ir un paso por detrás) y se fusionan con lo que ya haya en memoria.
async function restoreBotState(client, channel) {
  const live = state.getStreamIsLive();
  try {
    const saved = await require('./supabase').loadBotState();
    const dayRestored = state.mergeGroqDay(restorableGroqDay(saved));
    const r = restorableState(saved, { live, streamStartedAt: state.getStreamStartedAt() });
    if (!r) {
      if (saved?.live) logger.info('♻️ Estado guardado del bot descartado (no hay directo o es de otro directo)');
      logger.info(
        `♻️ Arranque: reinicio con directo en curso=${live ? 'sí (estado distinto o sin guardar)' : 'no'}, contadores del stream restaurados=0, uso diario de Groq restaurado=${dayRestored}`,
      );
      return null;
    }
    if (r.silenced) state.setSilenceMode(true);
    if (r.muteUntil) state.setMuteUntil(r.muteUntil);
    if (r.mode === 'reactivo') state.setBotMode('reactivo');
    if (r.brbStart) state.setBrbMode(true, client, channel, r.brbStart);
    if (r.player) state.setPlayer(r.player);
    if (r.deaths > state.getDeathCount()) state.setDeathCount(r.deaths);
    if (r.bosses > state.getBossCount()) state.setBossCount(r.bosses);
    const countersRestored = state.mergeStreamCounters(r.counters) + metrics.mergeMetrics(r.counters?.metrics);
    state.setStreamRestarts(r.restarts + 1);
    logger.info(
      `♻️ Estado restaurado: silencio=${r.silenced}, callado_hasta=${r.muteUntil || '-'}, modo=${r.mode}, brb=${!!r.brbStart}, juega=${r.player || '-'}, muertes=${state.getDeathCount()}, jefes=${state.getBossCount()}`,
    );
    logger.info(
      `♻️ Arranque: reinicio con directo en curso=sí (n.º ${r.restarts + 1}), contadores del stream restaurados=${countersRestored}, uso diario de Groq restaurado=${dayRestored}`,
    );
    persistBotState();
    return r;
  } catch (e) {
    logger.warn(`Estado del bot no restaurado: ${e.message}`);
    return null;
  }
}

module.exports = {
  buildSnapshot,
  restorableState,
  restorableGroqDay,
  currentSnapshot,
  persistBotState,
  persistCounters,
  restoreBotState,
};
