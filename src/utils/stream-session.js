// Cortes del directo: decisiones puras (sin estado ni I/O).
// Un stream.offline no cierra el directo: si vuelve dentro de REJOIN_MS es la misma sesión.

const MIN_SUMMARY_MINUTES = 20; // por debajo, sin resumen con IA ni entrada en stream_memory (como MIN_MINUTES de moment-facts)
const MIN_FAREWELL_MINUTES = 5; // por debajo, ni siquiera despedida

// Margen tras el cierre REAL para el resumen de fin de stream (memoria IA incluida): cuenta desde el cierre, no desde el offline
const END_GRACE_MS = 15 * 60 * 1000;
function endGraceUntil(closedAt = Date.now()) {
  return closedAt + END_GRACE_MS;
}

function rejoinMs(env = process.env) {
  const n = Number(env.STREAM_REJOIN_MS);
  return Number.isFinite(n) && n >= 0 ? n : 15 * 60 * 1000;
}

// ¿Un stream.online continúa el directo anterior (rejoin) o abre uno nuevo (new)?
function decideStreamTransition({ pendingEnd, now = Date.now(), rejoinMs: window = rejoinMs() } = {}) {
  if (!pendingEnd || !Number.isFinite(pendingEnd.endedAt)) return 'new';
  return now - pendingEnd.endedAt <= window ? 'rejoin' : 'new';
}

// Minutos de directo en antena: primer inicio → último fin, sin los huecos de los cortes
function liveMinutes({ startedAt, endedAt, gapMs = 0 }) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return 0;
  const ms = endedAt - startedAt - (Number.isFinite(gapMs) ? gapMs : 0);
  return ms > 0 ? Math.floor(ms / 60000) : 0;
}

// Qué hacer al cierre real: 'resumen' (IA + memoria) | 'despedida' (frase fija) | 'nada'
function closingPlan(minutes) {
  if (!Number.isFinite(minutes) || minutes < MIN_FAREWELL_MINUTES) return 'nada';
  return minutes < MIN_SUMMARY_MINUTES ? 'despedida' : 'resumen';
}

// Estado guardado válido (sobrevive a un reinicio de Render)
function sanitizePendingEnd(p) {
  if (!p || !Number.isFinite(p.endedAt) || !Number.isFinite(p.startedAt)) return null;
  return { endedAt: p.endedAt, startedAt: p.startedAt, gapMs: Number.isFinite(p.gapMs) && p.gapMs > 0 ? p.gapMs : 0 };
}

// Día (YYYY-MM-DD) en la hora de Madrid: la memoria se fecha por el día en que EMPEZÓ el directo, no por el cierre en UTC
function madridDateKey(ts = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts));
}

const MONTHS_ES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
const dayNumber = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ''));
  return m ? { y: +m[1], m: +m[2], d: +m[3], n: Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 } : null;
};

// Días entre una fecha guardada y hoy (Madrid); null si la fecha no es válida
function daysAgo(dateKey, now = Date.now()) {
  const then = dayNumber(dateKey);
  const today = dayNumber(madridDateKey(now));
  return then && today ? today.n - then.n : null;
}

// «ayer, 12 de noviembre», «hace 3 días, 10 de noviembre», «hoy, en un directo anterior, 13 de noviembre»: así el modelo no
// tiene que calcular qué día fue «ayer» a partir de una fecha suelta
function relativeDayLabel(dateKey, now = Date.now()) {
  const then = dayNumber(dateKey);
  if (!then) return String(dateKey || '');
  const date = `${then.d} de ${MONTHS_ES[then.m - 1]}`;
  const days = daysAgo(dateKey, now);
  const rel =
    days === 0
      ? 'hoy, en un directo anterior'
      : days === 1
        ? 'ayer'
        : days === 2
          ? 'anteayer'
          : days > 2 && days <= 6
            ? `hace ${days} días`
            : '';
  if (rel) return `${rel}, ${date}`;
  return dayNumber(madridDateKey(now)).y === then.y ? date : `${date} de ${then.y}`;
}

module.exports = {
  madridDateKey,
  daysAgo,
  relativeDayLabel,
  MIN_SUMMARY_MINUTES,
  MIN_FAREWELL_MINUTES,
  END_GRACE_MS,
  endGraceUntil,
  rejoinMs,
  decideStreamTransition,
  liveMinutes,
  closingPlan,
  sanitizePendingEnd,
};
