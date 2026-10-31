// Reacción del chat a los mensajes del bot (puro, sin I/O). Se usa al acabar el stream, sobre filas de chat_log.
// Solo se puntúan los mensajes generados por la IA: en un chat pequeño la risa es ruido y los timers fijos
// ("dale follow") la reciben igual que el cohost, así que cuenta lo ligado al bot (respuesta directa, nombrarlo,
// risa en los primeros segundos) y a la risa se le resta la de base del stream.

const AI_ORIGINS = new Set(['cohost', 'mencion', 'timer_ia', 'hook', 'quemeperdi', 'dios_fua']);
const WINDOW_MS = 60 * 1000;
const FAST_MS = 20 * 1000;

const LAUGH_RE = /(?:ja|je|ji|jo){2,}|\bjs(?:js)+|\bx+d+\b|\blol\b|\blul\b|kekw|omegalul|maxlol/i;
const NEGATIVE_RE = /qu[eé] dice(?:s)? (?:este|el bot|dios)|no viene al caso|(?:el )?bot (?:est[aá]|va) (?:lia(?:d|o)+[oa]?|fatal|mal|loco)|est[aá] lia(?:d|o)+[oa]? (?:el )?bot|qu[eé] (?:cojones|co[nñ]o) dice|calla(?:te)? (?:bot|dios)/i;
const BOT_NAME_RE = /dios\s*_?\s*fua/i;

const isLaugh = text => LAUGH_RE.test(String(text || ''));
const isNegative = text => NEGATIVE_RE.test(String(text || ''));
const namesBot = text => BOT_NAME_RE.test(String(text || ''));
const isAiMessage = row => !!row?.is_bot && AI_ORIGINS.has(row.origin);
const timeOf = row => new Date(row.created_at).getTime();
const loginOf = row => String(row?.username || '').toLowerCase();

// "@usuario ..." al principio: a quién va dirigido el mensaje (null si a nadie)
function addresseeOf(message) {
  const m = /^@(\w+)/.exec(String(message || '').trim());
  return m ? m[1].toLowerCase() : null;
}

// Media de usuarios distintos que se ríen en 60 s (ventanas de un minuto a lo largo del stream): la risa "normal" del chat
function chatBaseline(rows) {
  const users = rows.filter(r => !r.is_bot).map(r => ({ t: timeOf(r), u: loginOf(r), laugh: isLaugh(r.message) })).filter(r => Number.isFinite(r.t));
  if (users.length === 0) return 0;
  const start = users[0].t;
  const end = users[users.length - 1].t;
  let sum = 0;
  let windows = 0;
  for (let t = start; t <= end; t += WINDOW_MS) {
    const laughers = new Set(users.filter(r => r.laugh && r.t > t && r.t <= t + WINDOW_MS).map(r => r.u));
    sum += laughers.size;
    windows++;
  }
  return windows ? sum / windows : 0;
}

// Reacción a un mensaje del bot. next = filas de usuarios (no bot) posteriores, en orden.
function scoreReaction(bot, next, { baseline = 0, botName = 'dios_fua' } = {}) {
  const t0 = timeOf(bot);
  const addressee = addresseeOf(bot.message);
  const inWindow = next.filter(r => !r.is_bot && timeOf(r) > t0 && timeOf(r) - t0 <= WINDOW_MS);
  const reactors = new Set();
  const laughUsers = new Set();
  const negUsers = new Set();
  let addresseeAnswered = false;
  for (const r of inWindow) {
    const u = loginOf(r);
    const fast = timeOf(r) - t0 <= FAST_MS;
    const laugh = isLaugh(r.message);
    if (laugh) laughUsers.add(u);
    if (isNegative(r.message)) negUsers.add(u);
    if (addressee && u === addressee) addresseeAnswered = true;
    if (String(r.reply_parent_login || '').toLowerCase() === botName.toLowerCase() || namesBot(r.message) || (laugh && fast)) reactors.add(u);
  }
  const outsiders = [...reactors].filter(u => u !== addressee);
  const extraLaugh = Math.max(0, laughUsers.size - baseline);
  const score = Math.round((reactors.size + extraLaugh * 0.5 - negUsers.size * 2) * 100) / 100;
  return {
    reactors: [...reactors],
    outsiders,
    laughUsers: [...laughUsers],
    negUsers: [...negUsers],
    addressee,
    ignored: reactors.size === 0 && !addresseeAnswered && negUsers.size === 0,
    positive: reactors.size >= 2 && outsiders.length >= 1 && negUsers.size === 0,
    negative: negUsers.size > 0,
    score,
  };
}

// Puntúa todos los mensajes IA de las filas dadas (ordenadas por hora)
function scoreSession(rows, { botName = 'dios_fua' } = {}) {
  const sorted = [...rows].filter(r => Number.isFinite(timeOf(r))).sort((a, b) => timeOf(a) - timeOf(b));
  const baseline = chatBaseline(sorted);
  const scored = [];
  sorted.forEach((row, i) => {
    if (!isAiMessage(row)) return;
    scored.push({ row, ...scoreReaction(row, sorted.slice(i + 1), { baseline, botName }) });
  });
  return { baseline, scored };
}

// Cifras por origen y los mejores / negativos / ignorados
function summarize({ baseline, scored }) {
  const byOrigin = {};
  for (const s of scored) {
    const o = byOrigin[s.row.origin] ||= { sent: 0, positive: 0, negative: 0, ignored: 0 };
    o.sent++;
    if (s.positive) o.positive++;
    if (s.negative) o.negative++;
    if (s.ignored) o.ignored++;
  }
  const cut = s => ({ origin: s.row.origin, message: String(s.row.message).slice(0, 160), score: s.score, reactors: s.reactors, negUsers: s.negUsers });
  return {
    baseline: Math.round(baseline * 100) / 100,
    total: scored.length,
    positive: scored.filter(s => s.positive).length,
    negative: scored.filter(s => s.negative).length,
    ignored: scored.filter(s => s.ignored).length,
    byOrigin,
    best: scored.filter(s => s.positive).sort((a, b) => b.score - a.score).slice(0, 3).map(cut),
    worst: scored.filter(s => s.negative).map(cut),
  };
}

function formatSummary(sum) {
  const origins = Object.entries(sum.byOrigin).map(([k, o]) => `${k} ${o.positive}+/${o.negative}-/${o.ignored} ign de ${o.sent}`).join(', ');
  const best = sum.best.map(b => `"${b.message.slice(0, 60)}" (${b.score})`).join(' | ') || 'ninguno';
  const worst = sum.worst.map(b => `"${b.message.slice(0, 60)}" [${b.negUsers.join(',')}]`).join(' | ') || 'ninguno';
  return `Reacciones (${sum.total} mensajes IA, risa base ${sum.baseline}): ${sum.positive} bien, ${sum.negative} mal, ${sum.ignored} ignorados. Por origen: ${origins || '-'}. Mejores: ${best}. Negativos: ${worst}`;
}

module.exports = { AI_ORIGINS, WINDOW_MS, FAST_MS, isLaugh, isNegative, namesBot, addresseeOf, chatBaseline, scoreReaction, scoreSession, summarize, formatSummary };
