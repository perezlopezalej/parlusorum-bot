/**
 * lore/handler.js — Lore del canal: manual (config/lore.json) + aprendido entre streams.
 * Al acabar cada stream la IA propone candidatos; los conteos (apariciones, usuarios)
 * se calculan contra el chat real, no con lo que diga la IA. Un candidato pasa a activo
 * con >= 2 streams y >= 3 usuarios distintos; apodos/personas siempre requieren !lore aprobar.
 */

const loreConfig = require('../../config/lore.json');
const { getLoreRows, upsertLoreRows, updateLoreStatus, getCurrentSessionId } = require('../utils/supabase');
const { getLoreSample } = require('../utils/state');
const { sanitizeForAI } = require('../utils/filter');
const { groqWithRetry, GROQ_MODEL_FAST } = require('../utils/groq-utils');
const { classifyGameMatch, tokenize } = require('../utils/game-match');
const logger = require('../utils/logger');

const MIN_STREAMS = 2;
const MIN_USERS = 3;
const MAX_NEW_PER_STREAM = 10;
const DECAY_START = 4;        // streams sin aparecer antes de empezar a perder peso
const ARCHIVE_AT = 8;         // streams sin aparecer → archivado
const MAX_USERS_STORED = 50;
const MAX_PROMPT_CHARS = 500; // tope del lore aprendido inyectado en el prompt
const CACHE_TTL = 10 * 60 * 1000;
const KINDS = ['meme', 'frase', 'apodo', 'chiste', 'enemigo'];
const PERSON_KINDS = new Set(['apodo']);
const BOT_NAME = (process.env.BOT_USERNAME || 'dios_fua').toLowerCase();

function norm(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasPhrase(normText, key) {
  return ` ${normText} `.includes(` ${key} `);
}

// ─── FILTROS DE CANDIDATOS (puros) ───────────────────────────────────────────

const NOISE_WORDS = new Set(['xd', 'xdd', 'lol', 'lul', 'kek', 'kekw', 'omg', 'wtf', 'jsjs', 'haha', 'hehe', 'ufff', 'ostia']);

// Risas y onomatopeyas ("Jajajaja", "jsjsjs", "yiyiyiyi", "Wauuuu"): no son lore
function isNoiseTerm(term) {
  const compact = norm(term).replace(/\s/g, '');
  if (!compact) return true;
  if (NOISE_WORDS.has(compact)) return true;
  if (/^[aeiou]?(?:[jh][aeiou])+[jh]?$/.test(compact)) return true; // jaja, jeje, ajaj, haha
  if (/^(?:js)+$/.test(compact)) return true;
  if (/^(.{1,4}?)\1{2,}$/.test(compact)) return true;                 // unidad corta repetida
  if (/(.)\1{2,}/.test(compact)) return true;                         // letra alargada (vamooo, wauuu)
  return false;
}

// "people" de lore.json: { "nombre o apodo": "usuario" }; las claves que empiezan por EJEMPLO se ignoran
function buildPeopleWords(people) {
  const words = new Set();
  for (const [name, user] of Object.entries(people || {})) {
    if (/^\s*EJEMPLO/i.test(name)) continue;
    for (const w of [...norm(name).split(' '), ...norm(user).split(' ')]) if (w.length >= 2) words.add(w);
  }
  return words;
}
const PEOPLE_WORDS = buildPeopleWords(loreConfig.people);

// El término nombra a una persona: usuario del chat, nombre del mapa "people" o apodo oficial
function isPersonTerm(key, chatters, peopleWords = PEOPLE_WORDS) {
  return key.split(' ').some(w => chatters.has(w) || peopleWords.has(w));
}

// El término es (casi) el nombre de alguno de los juegos dados
function matchesGameName(term, games) {
  const n = tokenize(term).length;
  return games.some(g => tokenize(g).length <= n + 2 && classifyGameMatch(term, g) === 'match');
}

// Juegos de sesiones anteriores + RAWG como segunda opinión (coste: 1 consulta por candidato)
async function isGameTerm(term, playedGames) {
  if (matchesGameName(term, playedGames)) return true;
  try {
    const { getGameInfo } = require('../twitch/api');
    const info = await getGameInfo(term);
    return !!info?.name && matchesGameName(term, [info.name]);
  } catch {
    return false;
  }
}

async function loadPlayedGames() {
  try {
    const { getRecentSessionDeaths } = require('../utils/supabase');
    return [...new Set((await getRecentSessionDeaths(60)).map(r => r.game).filter(Boolean))];
  } catch {
    return [];
  }
}

// ─── LORE MANUAL ─────────────────────────────────────────────────────────────

const AVOID = (loreConfig.avoid || []).map(a => ({
  topic: String(a.topic || '').replace(/^EJEMPLO:\s*/i, ''),
  keywords: (a.keywords || []).map(norm).filter(Boolean)
}));

function touchesAvoidedTopic(text) {
  const n = norm(text);
  return AVOID.some(a => a.keywords.some(k => hasPhrase(n, k)));
}

// Siempre primero en el prompt, sin tope ni decaimiento
function getManualLore() {
  const avoid = AVOID.map(a => a.topic).filter(Boolean).join('; ');
  return [
    loreConfig.identity,
    loreConfig.inside_jokes,
    avoid ? `Temas a evitar (no los menciones ni bromees con ellos): ${avoid}.` : ''
  ].filter(Boolean).join(' ');
}

// Apodo oficial del lore manual (config/lore.json, "nicknames": { "nick": "apodo" }); null si no hay
function getNickname(username) {
  const nick = (loreConfig.nicknames || {})[String(username || '').toLowerCase()];
  const clean = nick ? sanitizeForAI(String(nick)) : '';
  return clean && !touchesAvoidedTopic(clean) ? clean : null;
}

// ─── LORE APRENDIDO: INYECCIÓN EN EL PROMPT ──────────────────────────────────

let loreCache = null;
let loreCacheTime = 0;

function weightOf(row) {
  const missed = row.missed_streams || 0;
  return missed <= DECAY_START ? 1 : Math.max(0, 1 - (missed - DECAY_START) * 0.25);
}

async function getLoreContext() {
  if (loreCache !== null && Date.now() - loreCacheTime < CACHE_TTL) return loreCache;
  try {
    const rows = await getLoreRows(['active']);
    const sorted = rows
      .map(r => ({ r, w: weightOf(r) }))
      .filter(x => x.w > 0)
      .sort((a, b) => b.w - a.w || (b.r.users_count || 0) - (a.r.users_count || 0));

    const parts = [];
    let used = 0;
    for (const { r } of sorted) {
      const term = sanitizeForAI(r.term);
      if (!term || touchesAvoidedTopic(term)) continue;
      const piece = `"${term}" (${r.kind})`;
      if (used + piece.length + 2 > MAX_PROMPT_CHARS) break;
      parts.push(piece);
      used += piece.length + 2;
    }
    loreCache = parts.length
      ? `\nLORE APRENDIDO DEL CANAL (úsalo solo si encaja, sin explicarlo ni inventar su origen): ${parts.join(', ')}.`
      : '';
    loreCacheTime = Date.now();
    return loreCache;
  } catch (e) {
    logger.error(`getLoreContext: ${e.message}`);
    return '';
  }
}

function invalidateLoreCache() {
  loreCache = null;
  loreCacheTime = 0;
}

// ─── APRENDIZAJE AL ACABAR EL STREAM ─────────────────────────────────────────

function parseChat(chatSample) {
  const lines = [];
  for (const line of String(chatSample || '').split('\n')) {
    const sep = line.indexOf(': ');
    if (sep < 1) continue;
    const user = line.slice(0, sep).toLowerCase();
    if (user === BOT_NAME) continue;
    lines.push({ user, norm: norm(line.slice(sep + 2)) });
  }
  return lines;
}

function statsFor(key, lines) {
  const users = new Set();
  let count = 0;
  for (const l of lines) {
    if (hasPhrase(l.norm, key)) { count++; users.add(l.user); }
  }
  return { count, users };
}

// Reduce la muestra al presupuesto del prompt quitando líneas alternas (conserva todo el arco del stream)
function fitSample(text, maxChars = 6000) {
  let lines = text.split('\n');
  while (lines.length > 1 && lines.join('\n').length > maxChars) lines = lines.filter((_, i) => i % 2 === 0);
  return lines.join('\n').slice(0, maxChars);
}

async function extractCandidates(chatSample, memory, existingTerms) {
  const avoid = AVOID.map(a => a.topic).filter(Boolean).join('; ') || 'ninguno';
  const prompt = `Analizas el chat de un stream de Twitch en español para detectar LORE del canal: memes, frases recurrentes, apodos, chistes internos y enemigos jurados (jefes o juegos que el chat odia).
Resumen del stream: ${memory?.summary || 'sin datos'}
Momentos: ${JSON.stringify(memory?.highlights || [])}
Frases recurrentes: ${JSON.stringify(memory?.recurringPhrases || [])}
Ya conocidos (no repetir): ${JSON.stringify(existingTerms.slice(0, 60))}
Temas prohibidos (no propongas nada que los toque): ${avoid}
Chat:
${fitSample(chatSample)}

Propón como máximo ${MAX_NEW_PER_STREAM} candidatos. El "term" debe aparecer TAL CUAL (1 a 5 palabras) en el chat. Marca "about_person": true si es un apodo o se refiere a una persona concreta.
NO propongas risas ni onomatopeyas (jajaja, xd, yiyiyi), ni nombres de videojuegos (ni los que se juegan ni los que solo se mencionan), ni nombres de pila o usuarios sueltos. Clasifica cada candidato en "category": "lore" | "juego" | "persona" | "risa".
Responde SOLO con un JSON array: [{"term":"...","kind":"meme|frase|apodo|chiste|enemigo","about_person":false,"category":"lore"}]`;

  const response = await groqWithRetry({
    model: GROQ_MODEL_FAST,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });
  const text = (response.choices[0].message.content || '').replace(/```json|```/g, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  const parsed = JSON.parse(text.slice(start, end + 1));
  return Array.isArray(parsed) ? parsed : [];
}

async function onStreamEndLore(memory) {
  try {
    const chatSample = getLoreSample();
    const lines = parseChat(chatSample);
    // Sin chat no hay evidencia: no sumar ni penalizar a nadie
    if (lines.length === 0) return;

    const streamId = String(getCurrentSessionId() ?? new Date().toISOString().slice(0, 10));
    const now = new Date().toISOString();
    const rows = await getLoreRows();
    const byKey = new Map(rows.map(r => [r.term_key, r]));
    const toSave = [];

    const chatters = new Set(lines.map(l => l.user));
    const playedGames = await loadPlayedGames();

    // 1. Lore ya conocido: contar apariciones reales en el chat y decaer lo que no sale
    for (const row of rows) {
      if (row.status !== 'pending' && row.status !== 'active') continue;
      // Limpieza de lo aprendido antes de existir los filtros
      if (isNoiseTerm(row.term) || matchesGameName(row.term, playedGames)) {
        const rejected = { ...row, status: 'rejected' };
        delete rejected.id; delete rejected.created_at; delete rejected.channel;
        toSave.push(rejected);
        logger.info(`📖 Lore descartado por filtro: "${row.term}"`);
        continue;
      }
      const { count, users } = statsFor(row.term_key, lines);
      const next = { ...row };
      delete next.id; delete next.created_at; delete next.channel;
      if (count > 0) {
        const merged = [...new Set([...(row.users || []), ...users])].slice(0, MAX_USERS_STORED);
        next.streams_count = (row.streams_count || 0) + (row.last_stream_id === streamId ? 0 : 1);
        next.total_count = (row.total_count || 0) + count;
        next.users = merged;
        next.users_count = merged.length;
        next.missed_streams = 0;
        next.last_seen = now;
        next.last_stream_id = streamId;
        // Una persona nunca queda activa sin !lore aprobar
        if (!next.needs_approval && isPersonTerm(row.term_key, chatters)) {
          next.needs_approval = true;
          if (next.status === 'active') next.status = 'pending';
        }
        if (next.status === 'pending' && !next.needs_approval
            && next.streams_count >= MIN_STREAMS && next.users_count >= MIN_USERS) {
          next.status = 'active';
          logger.info(`📖 Lore activado: "${next.term}"`);
        }
      } else {
        next.missed_streams = (row.missed_streams || 0) + 1;
        if (next.missed_streams >= ARCHIVE_AT) next.status = 'archived';
      }
      toSave.push(next);
    }

    // 2. Candidatos nuevos propuestos por la IA
    const existingTerms = rows.filter(r => r.status !== 'archived').map(r => r.term);
    let candidates = [];
    try {
      candidates = await extractCandidates(chatSample, memory, existingTerms);
    } catch (e) {
      logger.warn(`Lore: extracción IA fallida: ${e.message}`);
    }

    let added = 0;
    const seenKeys = new Set();
    for (const c of candidates) {
      if (added >= MAX_NEW_PER_STREAM) break;
      const term = sanitizeForAI(typeof c?.term === 'string' ? c.term : '');
      if (!term || term.length < 3 || term.length > 60) continue;
      if (touchesAvoidedTopic(term)) continue;
      const key = norm(term);
      if (key.length < 3 || seenKeys.has(key)) continue;
      seenKeys.add(key);
      const existing = byKey.get(key);
      if (existing && existing.status !== 'archived') continue; // ya tratado arriba (o rechazado)

      const { count, users } = statsFor(key, lines);
      if (count === 0) continue; // la IA lo inventó o no está literalmente en el chat
      if (isNoiseTerm(term) || c.category === 'risa' || c.category === 'juego') continue;
      if (await isGameTerm(term, playedGames)) continue;

      const kind = KINDS.includes(c.kind) ? c.kind : 'meme';
      const aboutPerson = c.about_person === true || c.category === 'persona' || PERSON_KINDS.has(kind)
        || term.includes('@') || isPersonTerm(key, chatters);
      const userList = [...users].slice(0, MAX_USERS_STORED);
      toSave.push({
        term, term_key: key, kind,
        status: 'pending',
        needs_approval: aboutPerson,
        streams_count: 1,
        total_count: count,
        users: userList,
        users_count: userList.length,
        missed_streams: 0,
        last_seen: now,
        last_stream_id: streamId
      });
      added++;
    }

    if (toSave.length && await upsertLoreRows(toSave)) {
      invalidateLoreCache();
      logger.info(`📖 Lore: ${added} candidatos nuevos, ${toSave.length - added} actualizados`);
    }
  } catch (e) {
    logger.error(`Error en onStreamEndLore: ${e.message}`);
  }
}

// ─── COMANDO !lore ───────────────────────────────────────────────────────────

async function getLoreOverview() {
  const rows = await getLoreRows(['active', 'pending']);
  const fmt = r => `#${r.id} ${sanitizeForAI(r.term) || '?'}${r.status === 'pending' && r.needs_approval ? '*' : ''}`;
  const take = status => rows
    .filter(r => r.status === status)
    .sort((a, b) => weightOf(b) - weightOf(a))
    .slice(0, 6)
    .map(fmt);
  return { active: take('active'), pending: take('pending'), total: rows.length };
}

async function approveLore(id) {
  const row = await updateLoreStatus(id, 'active', ['pending', 'archived']);
  if (row) invalidateLoreCache();
  return row;
}

async function deleteLore(id) {
  const row = await updateLoreStatus(id, 'rejected', ['pending', 'active', 'archived']);
  if (row) invalidateLoreCache();
  return row;
}

module.exports = {
  getManualLore,
  getNickname,
  touchesAvoidedTopic,
  getLoreContext,
  invalidateLoreCache,
  onStreamEndLore,
  isNoiseTerm, isPersonTerm, matchesGameName, buildPeopleWords,
  getLoreOverview,
  approveLore,
  deleteLore
};
