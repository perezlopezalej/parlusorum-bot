/**
 * live-status.js — Funciones puras sobre el estado del directo y la salud del bot.
 */

const OFFLINE_CONFIRMATIONS = 3; // consultas seguidas (1 por minuto) diciendo "offline" antes de dar el directo por terminado

// Compara lo que cree el bot (flagLive) con lo que dice Twitch (check: { live, startedAt } o null si la consulta falló).
// Un fallo de la consulta nunca cambia nada. Para apagar hacen falta varias lecturas seguidas (Helix va con retraso
// al empezar un directo); para encender basta una.
// → { action: 'none' | 'set_offline' | 'set_online', misses }
function reconcileLive({ flagLive, check, misses = 0 }) {
  if (!check || typeof check.live !== 'boolean') return { action: 'none', misses };
  if (check.live) return { action: flagLive ? 'none' : 'set_online', misses: 0 };
  if (!flagLive) return { action: 'none', misses: 0 };
  const next = misses + 1;
  return next >= OFFLINE_CONFIRMATIONS ? { action: 'set_offline', misses: 0 } : { action: 'none', misses: next };
}

// Cuerpo de /health: siempre responde 200 (Render lo usa para saber que el proceso vive), pero el estado
// pasa a "degraded" si el chat no está conectado
function buildHealth({ connected, uptime, live = false, lastConnectedAt = null, lastError = null }) {
  return {
    status: connected ? 'ok' : 'degraded',
    chat: connected ? 'connected' : 'disconnected',
    live: !!live,
    uptime,
    lastConnectedAt,
    ...(connected ? {} : { lastError }),
  };
}

module.exports = { reconcileLive, buildHealth, OFFLINE_CONFIRMATIONS };
