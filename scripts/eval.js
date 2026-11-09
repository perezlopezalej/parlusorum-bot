/**
 * eval.js — Batería de casos con la IA REAL (Groq + IGDB). Gasta llamadas: no forma parte de `npm test` ni de la CI.
 *
 * Pasa cada caso de test/eval-cases.json por los handlers reales (checkPatternMatch / handleQuestion):
 * prompts, buscar_juego, filtros de quality y factcheck. Solo cambia el cliente de chat (captura el say())
 * y las ESCRITURAS a Supabase (bloqueadas). No envía nada a Twitch.
 *
 * Casos con "filter": pasan una frase real del bot por los validadores de quality y por la revisión de sentido de factcheck
 * (cohost, timer_ia, hook o mention) y esperan que se descarte (expect.rejected) o que pase.
 *
 * Uso: npm run eval [-- --only id1,id2] [-- --verbose] [-- --repeat N]
 * Sale con código 1 si algún caso no cumple lo esperado.
 */

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const repeatIdx = args.indexOf('--repeat');
const repeat = repeatIdx >= 0 ? Math.max(1, parseInt(args[repeatIdx + 1], 10) || 1) : 1;
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

// Memoria simulada por caso (case.memory): se lee a través de este envoltorio
let simulatedMemory = null;
const realGetMemory = supabase.getRecentStreamMemory;
supabase.getRecentStreamMemory = async n => simulatedMemory || realGetMemory(n);

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
wrap(factcheck, 'evaluate', (a, r) => ({ filter: `factcheck(${a[2]?.source || 'stream'})`, hit: !!(r.discard || r.nonsense), reason: r.nonsense ? 'sin sentido o mal escrito (revisor)' : r.claim, text: a[0] }));

// Tiempos de cada llamada a Groq y 429 por caso (diagnóstico de latencia)
let aiCalls = [];
const chatlogMod = require('../src/utils/chatlog');
const origNoteAi = chatlogMod.noteAiCall;
chatlogMod.noteAiCall = (model, ms, ...rest) => { aiCalls.push({ model, ms }); return origNoteAi.call(chatlogMod, model, ms, ...rest); };

const state = require('../src/utils/state');
const messagesConfig = require('../config/messages.json');
const { classifyMessage } = require('../src/ai/patterns');
const ai = require('../src/ai/handler');

// ─── Ejecución de un caso ───
function fakeTags(i, rep = 0) {
  const name = `EvalUser${i + 1 + rep * 100}`;
  return { 'display-name': name, username: name.toLowerCase(), 'user-id': `eval-${i + 1 + rep * 100}`, mod: false, badges: {} };
}

function flattenPool(key) {
  const v = messagesConfig[key];
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v).map(String);
  return [];
}

const stripMention = s => String(s || '').replace(/^@\S+\s*/, '');

// Caso de filtro: no genera nada, comprueba que una frase real mala se descarta (o que una buena pasa)
async function runFilterCase(c) {
  const deaths = c.deaths ?? 5;
  const game = c.game || 'Phantom Blade Zero';
  const ctx = { deathCount: deaths, recent: c.recent || [], named: new Map(), currentGame: game, channelGames: [], usedStructures: new Set(c.usedStructures || []), lastCitedDeaths: !!c.lastCitedDeaths, player: c.player || 'manu' };
  const rules = {
    cohost: t => quality.validateCohost(t, ctx),
    timer_ia: t => quality.validateTimerIA(t, ctx),
    hook: t => quality.validateHook(t, ctx),
    mention: t => quality.validateMention(t, { question: c.question || '', player: ctx.player }),
    // Petición de silencio al bot (rejected = reconocida como tal) y resumen de fin de stream (reglas de src/memory/handler.js)
    shutup: t => (classifyMessage(t, {}, { botNames: [process.env.BOT_USERNAME || 'Dios_Fua'] }) === 'shutup' ? { ok: false, reason: 'petición de silencio' } : { ok: true }),
    summary: t => { const p = require('../src/memory/handler').summaryProblem(t); return p ? { ok: false, reason: p } : { ok: true }; },
  };
  if (!rules[c.filter]) throw new Error(`filtro desconocido: ${c.filter}`);
  const started = realNow();
  const n429 = state.getCohostStats().groq429;
  const v = rules[c.filter](c.input);
  let rejectedBy = v.ok ? null : `regla — ${v.reason}`;
  if (!rejectedBy && c.filter !== 'shutup') {
    const r = await factcheck.evaluate(c.input, `Juego: ${game}. Muertes anotadas: ${deaths}.`, { game, sense: true });
    if (r.discard) rejectedBy = 'revisión de datos del juego';
    else if (r.nonsense) rejectedBy = 'revisión de sentido (IA)';
  }
  const failures = [];
  if (c.expect?.rejected === true && !rejectedBy) failures.push('la frase mala pasó todos los filtros');
  if (c.expect?.rejected === false && rejectedBy) failures.push(`una frase buena se descartó (${rejectedBy})`);
  return { c, kind: `filtro ${c.filter}`, reply: rejectedBy ? `(descartada por ${rejectedBy})` : '(pasa los filtros)', answer: '', tool: null, discarded: null, retried: [], failures, ms: realNow() - started, calls: aiCalls.map(a => a.model.split('/').pop() + ' ' + (a.ms / 1000).toFixed(1) + 's'), rate429: state.getCohostStats().groq429 - n429, logs: currentLogs.slice() };
}

async function runCase(c, i, rep = 0) {
  events = []; currentLogs = []; aiCalls = [];
  if (c.filter) return runFilterCase(c);
  const n429 = state.getCohostStats().groq429;
  const said = [];
  const client = { say: (_ch, text) => { said.push(String(text)); } };
  const tags = fakeTags(i, rep);
  state.setDeathCount(c.deaths || 0);
  simulatedMemory = c.memory || null;
  if (c.memory) require('../src/memory/handler').invalidateMemoryCache();

  const isCommand = /^!dios_fua\b/i.test(c.input);
  const kind = isCommand ? 'question' : classifyMessage(c.input, tags, { botNames: [process.env.BOT_USERNAME] });
  let ret;
  const started = realNow();
  if (isCommand) ret = await ai.handleQuestion(client, '#eval', tags, c.input.split(/\s+/));
  else ret = await ai.checkPatternMatch(client, '#eval', tags, c.input);
  const ms = realNow() - started;
  const calls = aiCalls.map(c => c.model.split('/').pop() + ' ' + (c.ms / 1000).toFixed(1) + 's');
  const rate429 = state.getCohostStats().groq429 - n429;

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
      by: f ? `${f.filter}${f.reason ? ` — ${f.reason}` : ''}` : (rate429 > 0 ? `Groq 429 (${rate429}×, cupo agotado)` : ret === 'blocked' ? 'cooldown/límite/tardía' : 'desconocido'),
      original: candidate || f?.text || '',
    };
  }
  // Intentos rechazados pero que luego se arreglaron (reintento de menciones)
  const retried = !discarded ? hits.map(e => `${e.filter}${e.reason ? ` — ${e.reason}` : ''}`) : [];

  const failures = check(c.expect || {}, { kind, tool, reply, answer, discarded, ret });
  return { c, kind, reply, answer, tool, discarded, retried, failures, ms, calls, rate429, logs: currentLogs.slice() };
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
  const total = cases.filter(c => !c.informativo).length;
  if (!cases.length) { console.error('Ningún caso coincide con --only.'); process.exit(2); }

  const out = [];
  const log = s => { out.push(s); console.log(s); };
  let failed = 0;

  const stability = [];
  for (let i = 0; i < cases.length; i++) {
    let passes = 0;
    for (let n = 1; n <= repeat; n++) {
      let r;
      try { r = await runCase(cases[i], i, n - 1); }
      catch (err) { r = { c: cases[i], kind: '?', reply: '', answer: '', tool: null, discarded: null, retried: [], failures: [`excepción: ${err.message}`], ms: 0, logs: currentLogs.slice() }; }
      skewMs += 15 * 60 * 1000;

      const ok = r.failures.length === 0;
      if (ok) passes++;
      log(`\n[${i + 1}/${cases.length}${repeat > 1 ? ` · ${n}/${repeat}` : ''}] ${ok ? 'OK  ' : r.c.informativo ? 'AVISO' : 'FALLA'} ${r.c.id} — ${r.c.input}`);
      log(`  esperado : ${r.c.note || '(sin nota)'}`);
      log(`  ruta     : ${r.kind || 'ninguna'} · ${(r.ms / 1000).toFixed(1)} s${r.tool ? ` · buscar_juego("${r.tool.query}") → ${r.tool.result}` : ''}`);
      if (verbose || r.ms > 10000) log(`  tiempos  : ${(r.calls || []).join(', ') || 'sin llamadas'}${r.rate429 ? ` · ${r.rate429} × 429` : ''}`);
      log(`  respuesta: ${r.reply || '(ninguna)'}`);
      if (r.discarded) log(`  DESCARTADA por ${r.discarded.by}${r.discarded.original ? `\n  original : ${r.discarded.original}` : ''}`);
      else if (r.retried.length) log(`  reintentos por: ${r.retried.join('; ')}`);
      else log('  filtros  : ninguno');
      for (const msg of r.failures) log(`  ✘ ${msg}`);
      if (verbose) for (const l of r.logs) log(`    · ${l}`);
    }
    if (passes < repeat && !cases[i].informativo) failed++;
    stability.push(`${passes === repeat ? 'estable  ' : cases[i].informativo ? 'AVISO    ' : passes === 0 ? 'FALLA    ' : 'INESTABLE'} ${cases[i].id}: ${passes}/${repeat}${cases[i].informativo ? ' (informativo, no cuenta)' : ''}`);
  }
  if (repeat > 1) log(`\nRepeticiones por caso:\n  ${stability.join('\n  ')}`);

  log(`\n${total - failed}/${total} casos cumplen lo esperado (sin contar los informativos)${repeat > 1 ? ` en las ${repeat} repeticiones` : ''}.${blockedWrites.size ? ` (escrituras Supabase bloqueadas: ${[...blockedWrites].join(', ')})` : ''}`);
  try {
    const dir = path.join(__dirname, '../logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'eval.txt'), out.join('\n') + '\n');
  } catch { /* el informe ya salió por consola */ }
  process.exit(failed ? 1 : 0);
})();
