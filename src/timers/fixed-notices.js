// Avisos fijos del canal (recordatorio del follow, redes y «¡Llevamos X de stream!»): un solo reloj los reparte.
// 17-11: en 3,5 horas salieron 12 y el follow y el tiempo coincidieron con un minuto de diferencia. Ahora, como mucho uno cada
// 20 minutos, nunca el mismo aviso dos veces seguidas y cada tipo con su propio intervalo (follow y redes 60 min, tiempo 90 min).
// Módulo puro: sin estado ni I/O. El último envío de cada aviso lo guarda el llamador (state.markFactUse, clave `aviso:<tipo>`).

const MIN_GAP_MS = 20 * 60 * 1000; // entre dos avisos fijos cualesquiera
const TIME_INTERVAL_MS = 90 * 60 * 1000; // «¡Llevamos X de stream!»
const CHECK_INTERVAL_MS = 60 * 1000; // cada cuánto se comprueba si toca alguno

const useKey = (kind) => `aviso:${kind}`;

// notices: [{ kind, intervalMs }] en orden de preferencia; lastAt: kind → ms del último envío (0 = nunca en este stream);
// startedAt: inicio del directo (un aviso que no ha salido aún cuenta desde ahí: el primero sale tras su intervalo completo).
// → kind a enviar ahora, o null
function nextFixedNotice({ now = Date.now(), notices = [], lastAt = () => 0, startedAt = 0, gapMs = MIN_GAP_MS } = {}) {
  if (!notices.length || !startedAt) return null;
  const sentAt = (kind) => lastAt(kind) || 0;
  let lastAny = 0;
  let lastKind = null;
  for (const { kind } of notices) {
    if (sentAt(kind) > lastAny) {
      lastAny = sentAt(kind);
      lastKind = kind;
    }
  }
  if (lastAny && now - lastAny < gapMs) return null;

  let best = null;
  for (const n of notices) {
    if (notices.length > 1 && n.kind === lastKind) continue; // nunca el mismo aviso dos veces seguidas
    const since = Math.max(sentAt(n.kind), startedAt);
    const overdue = (now - since) / n.intervalMs;
    if (overdue < 1) continue;
    if (!best || overdue > best.overdue) best = { kind: n.kind, overdue };
  }
  return best ? best.kind : null;
}

module.exports = { nextFixedNotice, useKey, MIN_GAP_MS, TIME_INTERVAL_MS, CHECK_INTERVAL_MS };
