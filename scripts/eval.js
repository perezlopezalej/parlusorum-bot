/**
 * eval.js — Batería de casos con la IA REAL (Groq + RAWG). Gasta llamadas: no forma parte de `npm test` ni de la CI.
 *
 * Pasa cada caso de test/eval-cases.json por los handlers reales (checkPatternMatch / handleQuestion):
 * prompts, buscar_juego, filtros de quality y factcheck. Solo cambia el cliente de chat (captura el say())
 * y las ESCRITURAS a Supabase (bloqueadas). No envía nada a Twitch.
 *
 * Uso: npm run eval [-- --only id1,id2] [-- --verbose]
 * Sale con código 1 si algún caso no cumple lo esperado.
 */

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? String(args[onlyIdx + 1] || '').split(',').filter(Boolean) : null;

if (!process.env.GROQ_API_KEY) {
  console.error('Falta GROQ_API_KEY en el entorno (.env).');
  process.exit(2);
}
process.env.BOT_USERNAME = process.env.BOT_USERNAME || 'dios_fua';

// ─── Aislamiento: se parchea ANTES de cargar los handlers (que desestructuran estos módulos) ───
let currentLogs = [];
const logger = require('../src/utils/logger');
for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = msg => currentLogs.push(`${level}: ${msg}`);

// Escrituras a Supabase bloqueadas; las lecturas (memoria, lore, hechos de usuario) siguen siendo reales
const supabase = require('../src/utils/supabase');
const WRITE_RE = /^(save|persist|delete|insert|upsert|update|increment|start|end|migrate)/;
const blockedWrites = new Set();
for (const [name, fn] of Object.entries(supabase)) {
  if (typeof fn === 'function' && WRITE_RE.test(name)) {
    supabase[name] = async () => { blockedWrites.add(name); };
  }
}

// El tiempo salta entre casos para que no choquen los cooldowns globales de las menciones
let skewMs = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + skewMs;

// Instrumentación de filtros (los handlers los llaman como quality.x / factcheck.x)
let events = [];
const quality = require('../src/ai/quality');
const factcheck = require('../src/ai/factcheck');
const wrap = (obj, name, describe) => {
  const orig = obj[name];
  obj[name] = (...a) => {
    const out = orig.apply(obj, a);
    if (out && typeof out.then === 'function') return out.then(r => { events.push(describe(a, r)); return r; });
    events.push(describe(a, out));
    return out;
  };
};
wrap(quality, 'leaksTech', (a, r) => ({ filter: 'leaksTech', hit: !!r, text: a[0] }));
wrap(quality, 'mentionsMechanics', (a, r) => ({ filter: 'mentionsMechanics', hit: !!r, text: a[0] }));
wrap(quality, 'validateMention', (a, r) => ({ filter: 'validateMention', hit: !r.ok, reason: r.reason, text: a[0] }));
wrap(factcheck, 'shouldDiscard', (a, r) => ({ filter: `factcheck(${a[2]?.source || 'stream'})`, hit: !!r, text: a[0] }));

const state = require('../src/utils/state');
const messagesConfig = require('../config/messages.json');
const { classifyMessage } = require('../src/ai/patterns');
const ai = require('../src/ai/handler');

// ─── Ejecución de un caso ───
function fakeTags(i) {
  const name = `EvalUser${i + 1}`;
  return { 'display-name': name, username: name.toLowerCase(), 'user-id': `eval-${i + 1}`, mod: false, badges: {} };
}

function flattenPool(key) {
  const v = messagesConfig[key];
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v).map(String);
  return [];
}

const stripMention = s => String(s || '').replace(/^@\S+\s*/, '');

async function runCase(c, i) {
  events = []; currentLogs = [];
  const said = [];
  const client = { say: (_ch, text) => { said.push(String(text)); } };
  const tags = fakeTags(i);
  state.setDeathCount(c.deaths || 0);

  const isCommand = /^!dios_fua\b/i.test(c.input);
  const kind = isCommand ? 'question' : classifyMessage(c.input, tags, { botNames: [process.env.BOT_USERNAME] });
  let ret;
  const started = realNow();
  if (isCommand) ret = await ai.handleQuestion(client, '#eval', tags, c.input.split(/\s+/));
  else ret = await ai.checkPatternMatch(client, '#eval', tags, c.input);
  const ms = realNow() - started;

  const toolLog = currentLogs.map(l => /buscar_juego: "(.*)" → (.*)$/.exec(l)).find(Boolean);
  const tool = toolLog ? { query: toolLog[1], result: toolLog[2], data: !/sin datos|\((none|maybe)\)$/.test(toolLog[2]) } : null;
  const reply = said.length ? said[said.length - 1] : '';
  const answer = stripMention(reply);

  // ¿Se descartó? !dios_fua sustituye por dios_fua_no_data; las menciones callan y no dicen nada
  const noDataPool = flattenPool('dios_fua_no_data');
  const sentNoData = isCommand && noDataPool.includes(answer);
  const hits = events.filter(e => e.hit);
  let discarded = null;
  if (sentNoData || (!isCommand && !said.length)) {
    const f = hits.find(e => e.filter !== 'mentionsMechanics') || hits[0];
    const candidate = events.find(e => e.filter === 'leaksTech')?.text;
    discarded = {
      by: f ? `${f.filter}${f.reason ? ` — ${f.reason}` : ''}` : (ret === 'blocked' ? 'cooldown/límite/tardía' : 'desconocido'),
      original: candidate || f?.text || '',
    };
  }
  // Intentos rechazados pero que luego se arreglaron (reintento de menciones)
  const retried = !discarded ? hits.map(e => `${e.filter}${e.reason ? ` — ${e.reason}` : ''}`) : [];

  const failures = check(c.expect || {}, { kind, tool, reply, answer, discarded, ret });
  return { c, kind, reply, answer, tool, discarded, retried, failures, ms, logs: currentLogs.slice() };
}

// ─── Comprobación de lo esperado ───
function check(exp, r) {
  const f = [];
  const re = p => new RegExp(p, 'i');
  if (exp.route) {
    const ok = exp.route === 'natural_or_direct' ? ['natural', 'direct'].includes(r.kind) : r.kind === exp.route;
    if (!ok) f.push(`ruta: esperaba ${exp.route}, salió ${r.kind}`);
  }
  if (exp.discarded === false && r.discarded) f.push(`se descartó (${r.discarded.by})`);
  if (exp.reply && !r.reply) f.push('no hubo respuesta');
  if (exp.tool === 'none' && r.tool) f.push(`llamó a buscar_juego("${r.tool.query}")`);
  if (exp.tool === 'buscar_juego' && !r.tool) f.push('no llamó a buscar_juego');
  if (r.tool && typeof exp.toolData === 'boolean' && r.tool.data !== exp.toolData) {
    f.push(`buscar_juego ${r.tool.data ? 'devolvió datos' : 'no devolvió datos'} (${r.tool.result})`);
  }
  if (!r.reply) return f;
  if (exp.maxChars && r.answer.length > exp.maxChars) f.push(`demasiado larga: ${r.answer.length} > ${exp.maxChars}`);
  if (exp.matchAny && !exp.matchAny.some(p => re(p).test(r.answer))) f.push(`no cumple ninguno de: ${exp.matchAny.join(' | ')}`);
  for (const p of exp.matchAll || []) if (!re(p).test(r.answer)) f.push(`falta /${p}/`);
  for (const p of exp.matchNone || []) if (re(p).test(r.answer)) f.push(`contiene /${p}/`);
  if (exp.fromPool && !flattenPool(exp.fromPool).includes(r.answer)) {
    const squash = s => s.replace(/\s+/g, '');
    const altered = flattenPool(exp.fromPool).some(p => squash(p) === squash(r.answer));
    f.push(altered ? `texto de messages.json → ${exp.fromPool} alterado por un filtro (espacios)` : `no es de config/messages.json → ${exp.fromPool}`);
  }
  for (const key of exp.notFromPool || []) if (flattenPool(key).includes(r.answer)) f.push(`es una respuesta de reserva (${key})`);
  return f;
}

// ─── Informe ───
(async () => {
  const all = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/eval-cases.json'), 'utf8'));
  const cases = only ? all.filter(c => only.includes(c.id)) : all;
  if (!cases.length) { console.error('Ningún caso coincide con --only.'); process.exit(2); }

  const out = [];
  const log = s => { out.push(s); console.log(s); };
  let failed = 0;

  for (let i = 0; i < cases.length; i++) {
    let r;
    try { r = await runCase(cases[i], i); }
    catch (err) { r = { c: cases[i], kind: '?', reply: '', answer: '', tool: null, discarded: null, retried: [], failures: [`excepción: ${err.message}`], ms: 0, logs: currentLogs.slice() }; }
    skewMs += 15 * 60 * 1000;

    const ok = r.failures.length === 0;
    if (!ok) failed++;
    log(`\n[${i + 1}/${cases.length}] ${ok ? 'OK  ' : 'FALLA'} ${r.c.id} — ${r.c.input}`);
    log(`  esperado : ${r.c.note || '(sin nota)'}`);
    log(`  ruta     : ${r.kind || 'ninguna'} · ${(r.ms / 1000).toFixed(1)} s${r.tool ? ` · buscar_juego("${r.tool.query}") → ${r.tool.result}` : ''}`);
    log(`  respuesta: ${r.reply || '(ninguna)'}`);
    if (r.discarded) log(`  DESCARTADA por ${r.discarded.by}${r.discarded.original ? `\n  original : ${r.discarded.original}` : ''}`);
    else if (r.retried.length) log(`  reintentos por: ${r.retried.join('; ')}`);
    else log('  filtros  : ninguno');
    for (const msg of r.failures) log(`  ✘ ${msg}`);
    if (verbose) for (const l of r.logs) log(`    · ${l}`);
  }

  log(`\n${cases.length - failed}/${cases.length} casos cumplen lo esperado.${blockedWrites.size ? ` (escrituras Supabase bloqueadas: ${[...blockedWrites].join(', ')})` : ''}`);
  try {
    const dir = path.join(__dirname, '../logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'eval.txt'), out.join('\n') + '\n');
  } catch { /* el informe ya salió por consola */ }
  process.exit(failed ? 1 : 0);
})();
