// Utilidades puras de !muertes y !tiempo (sin estado ni I/O) + formato de mensajes.
const { classifyGameMatch } = require('../utils/game-match');

const MAX_DEATHS_ADD = 10;

// Interpreta los argumentos de !muertes (args[0] es el comando)
// → { type: 'show' | 'reset' | 'add' | 'bad_format' | 'game', n?, game? }
function parseMuertesArgs(args) {
  const rest = args.slice(1).map(a => String(a).trim()).filter(Boolean);
  if (rest.length === 0) return { type: 'show' };
  const first = rest[0].toLowerCase();
  if (first === 'reset' && rest.length === 1) return { type: 'reset' };
  if (/^[+-]/.test(first) || /^\d+$/.test(first)) {
    const m = rest.length === 1 && first.match(/^\+(\d+)$/);
    const n = m ? parseInt(m[1], 10) : 0;
    return n >= 1 && n <= MAX_DEATHS_ADD ? { type: 'add', n } : { type: 'bad_format' };
  }
  return { type: 'game', game: rest.join(' ') };
}

// Total de muertes de un juego sumando sesiones. rows: [{ id, game, death_count }].
// liveSession: { id, deaths } para usar el contador en directo en vez del último guardado.
function sumGameDeaths(query, rows, liveSession = null) {
  const counts = new Map();
  let total = 0;
  let streams = 0;
  let seenLive = false;
  for (const r of rows || []) {
    if (!r.game || classifyGameMatch(query, r.game) !== 'match') continue;
    const live = liveSession && r.id === liveSession.id;
    if (live) seenLive = true;
    const deaths = live ? liveSession.deaths : (r.death_count || 0);
    if (deaths <= 0) continue;
    total += deaths;
    streams++;
    counts.set(r.game, (counts.get(r.game) || 0) + deaths);
  }
  const name = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || query;
  return { game: name, total, streams, seenLive };
}

// "3 días", "2 meses y 5 días", "1 año y 2 meses", "4 horas", "12 minutos"
function formatSince(fromMs, nowMs = Date.now()) {
  const mins = Math.max(0, Math.floor((nowMs - fromMs) / 60000));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (mins < 60) return plural(mins, 'minuto', 'minutos');
  const hours = Math.floor(mins / 60);
  if (hours < 24) return plural(hours, 'hora', 'horas');
  const days = Math.floor(hours / 24);
  if (days < 30) return plural(days, 'día', 'días');
  if (days < 365) {
    const months = Math.floor(days / 30);
    const d = days % 30;
    return d ? `${plural(months, 'mes', 'meses')} y ${plural(d, 'día', 'días')}` : plural(months, 'mes', 'meses');
  }
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  return months ? `${plural(years, 'año', 'años')} y ${plural(months, 'mes', 'meses')}` : plural(years, 'año', 'años');
}

// Busca un usuario por nombre en el mapa { userId: { username, firstSeen } }
function findUserByName(users, name) {
  const target = String(name || '').replace(/^@/, '').trim().toLowerCase();
  if (!target) return null;
  return Object.values(users || {}).find(u => String(u.username || '').toLowerCase() === target) || null;
}

module.exports = { MAX_DEATHS_ADD, parseMuertesArgs, sumGameDeaths, formatSince, findUserByName };
