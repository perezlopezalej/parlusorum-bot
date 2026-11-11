/**
 * bot-state.js — Conserva entre reinicios lo que cambia a mano durante un directo:
 * !silencio, !brb, !juega y los contadores de muertes y jefes.
 *
 * Se guarda en Supabase (tabla bot_state, migración 009) y solo se restaura si pertenece al directo
 * en curso (mismo started_at). Sin directo no hay nada que conservar: se guarda vacío.
 */
const logger = require('./logger');
const state = require('./state');

const PLAYERS = ['manu', 'pao', 'ambos'];
const SAVE_DEBOUNCE_MS = 1000;
const STARTED_AT_TOLERANCE_MS = 5000;

const count = n => (Number.isInteger(n) && n >= 0 ? n : 0);

// Lo que se guarda. Sin directo: nada (así un estado viejo nunca se restaura en el siguiente stream)
function buildSnapshot({ live, streamStartedAt, silenced, brbStart, player, deaths, bosses, muteUntil, mode }, now = Date.now()) {
  if (!live || !streamStartedAt) return { v: 1, live: false, savedAt: now };
  return { v: 1, live: true, streamStartedAt, silenced: !!silenced, brbStart: brbStart || null, player: player || null, deaths: count(deaths), bosses: count(bosses), muteUntil: Number.isFinite(muteUntil) && muteUntil > now ? muteUntil : 0, mode: mode === 'reactivo' ? 'reactivo' : 'normal', savedAt: now };
}

// Lo que se aplica al arrancar, o null si no procede (no hay directo, o lo guardado era de otro directo)
function restorableState(saved, { live, streamStartedAt }, now = Date.now()) {
  if (!live || !streamStartedAt || !saved || saved.v !== 1 || !saved.live) return null;
  if (!Number.isFinite(saved.streamStartedAt) || Math.abs(saved.streamStartedAt - streamStartedAt) > STARTED_AT_TOLERANCE_MS) return null;
  return {
    silenced: !!saved.silenced,
    brbStart: Number.isFinite(saved.brbStart) && saved.brbStart > 0 ? saved.brbStart : null,
    player: PLAYERS.includes(saved.player) ? saved.player : null,
    deaths: count(saved.deaths),
    bosses: count(saved.bosses),
    // El silencio temporal solo se restaura si aún no ha caducado
    muteUntil: Number.isFinite(saved.muteUntil) && saved.muteUntil > now ? saved.muteUntil : 0,
    mode: saved.mode === 'reactivo' ? 'reactivo' : 'normal',
  };
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
  });
}

let saveTimer = null;
// Guarda el estado actual (con un pequeño retraso para agrupar cambios seguidos). Nunca lanza.
function persistBotState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    require('./supabase').saveBotState(currentSnapshot()).catch(() => {});
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

// Al arrancar, tras comprobar con Twitch si el directo sigue. Los contadores ganan por el mayor valor
// (la sesión de Supabase puede ir un paso por detrás).
async function restoreBotState(client, channel) {
  try {
    const saved = await require('./supabase').loadBotState();
    const r = restorableState(saved, { live: state.getStreamIsLive(), streamStartedAt: state.getStreamStartedAt() });
    if (!r) {
      if (saved?.live) logger.info('♻️ Estado guardado del bot descartado (no hay directo o es de otro directo)');
      return null;
    }
    if (r.silenced) state.setSilenceMode(true);
    if (r.muteUntil) state.setMuteUntil(r.muteUntil);
    if (r.mode === 'reactivo') state.setBotMode('reactivo');
    if (r.brbStart) state.setBrbMode(true, client, channel, r.brbStart);
    if (r.player) state.setPlayer(r.player);
    if (r.deaths > state.getDeathCount()) state.setDeathCount(r.deaths);
    if (r.bosses > state.getBossCount()) state.setBossCount(r.bosses);
    logger.info(`♻️ Estado restaurado: silencio=${r.silenced}, callado_hasta=${r.muteUntil || '-'}, modo=${r.mode}, brb=${!!r.brbStart}, juega=${r.player || '-'}, muertes=${state.getDeathCount()}, jefes=${state.getBossCount()}`);
    return r;
  } catch (e) {
    logger.warn(`Estado del bot no restaurado: ${e.message}`);
    return null;
  }
}

module.exports = { buildSnapshot, restorableState, currentSnapshot, persistBotState, restoreBotState };
