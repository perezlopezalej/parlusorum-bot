/**
 * compare-models.js — Compara modelos GRATUITOS (solo Groq) con los casos reales del bot. Gasta cupo: no va en `npm test`.
 *
 * Pasa los casos de test/eval-cases.json (!dios_fua y menciones) y unos escenarios de cohost sacados de los chatlogs
 * por los handlers reales (prompts, buscar_juego, filtros de quality, factcheck). Solo cambia el cliente de Groq:
 *   - generación (handlers)      → el modelo candidato
 *   - revisiones (factcheck.js)  → un revisor común para todos (--aux, por defecto groq-20b) para que la
 *                                  diferencia sea solo del generador y no se gaste el cupo de Groq del directo
 * Cada candidato corre en un proceso aparte (mismo estado inicial). No envía nada a Twitch ni escribe en Supabase.
 *
 * Uso:
 *   node scripts/compare-models.js                         # todos los candidatos
 *   node scripts/compare-models.js --models groq-20b,groq-qwen [--only id1,id2]
 *   node scripts/compare-models.js --filters --models groq-120b,groq-qwen   # el candidato hace de REVISOR en los casos "filter"
 *   node scripts/compare-models.js --report                 # solo regenera el informe con los JSON guardados
 * Salida: logs/compare/<candidato>.json y logs/comparativa-modelos.md (respuestas lado a lado).
 */

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'logs', 'compare');
const REPORT = path.join(ROOT, 'logs', 'comparativa-modelos.md');
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Límites del nivel gratuito (cabeceras reales de Groq). maxRequests/maxTokens = tope de ESTA prueba
const TARGETS = {
  'groq-120b': { model: 'openai/gpt-oss-120b', reasoning: 'low', headroom: 64, rpm: 30, tpm: 8000, maxTokens: 75000 },
  'groq-20b': { model: 'openai/gpt-oss-20b', reasoning: 'low', headroom: 64, rpm: 30, tpm: 8000, maxTokens: 75000 },
  'groq-qwen': { model: 'qwen/qwen3.8-27b', rpm: 30, tpm: 8000, maxTokens: 75000 },
};
// Escenarios de cohost con chat real (logs/chat-2026-11-01.txt y 11-02)
const COHOST_CASES = [
  { id: 'cohost-libre-bosses', deaths: 5, note: 'Libre: el chat habla de cuántos bosses tiene el juego.', chat: [
    ['mujica90_', 'Ya 58 me parecen buff'], ['mujica90_', 'Así...con enemigos normales ascienden un huevo'], ['mujica90_', 'El wukong'],
    ['mujica90_', 'Contando enemigos normales y bosses fijos y secundarios ascienden a 100 y pico'], ['mujica90_', 'Como pega...joer'],
    ['mujica90_', 'Que raro que no esté el ganga por aquí jajajaaj'], ['mujica90_', 'Facilito pues 😀']] },
  { id: 'cohost-libre-motor', deaths: 0, note: 'Libre: el chat critica el final y el motor gráfico (0 muertes: no puede hablar de muertes).', chat: [
    ['markosssx', 'Buenos días familia'], ['gangar79', 'El final a sido un flop'], ['markosssx', 'Estamos subiendo al máximo el nivel para el último boss'],
    ['gangar79', 'El problema no es la historia en si'], ['gangar79', 'Es por el motor gráfico'], ['gangar79', 'No, yo juego en rendimiento'],
    ['gangar79', 'En esta run lo estoy jugando en normal para hacer la exploración']] },
  { id: 'cohost-muerte', deaths: 5, note: 'Evento: quinta muerte.', moment: { kind: 'death', description: 'Manu acaba de morir: muerte #5 en este stream' }, chat: [
    ['mujica90_', 'Como pega...joer'], ['mujica90_', 'Facilito pues 😀']] },
  { id: 'cohost-boss', deaths: 5, note: 'Evento: cae el tercer boss.', moment: { kind: 'boss', description: 'Boss eliminado: 3 bosses derrotados este stream' }, chat: [
    ['mujica90_', 'Pero ya te lo as echo??'], ['mujica90_', 'Facilito pues 😀']] },
  { id: 'cohost-sub', deaths: 2, note: 'Evento: subs regaladas (puede nombrar a quien regala).', moment: { kind: 'sub', description: 'harocho3847 ha regalado 2 subs a la comunidad' }, chat: [
    ['harocho3847', 'Tu canal es muy bacano'], ['markosssx', 'parlus1PORELPODERDELFUAAAAA']] },
];

// Rasgos de español de América (tono de España pedido) y de España
const LATAM_RE = /\b(ustedes|ahorita|chid[oa]s?|ch[eé]vere|platic\w*|celular|computadora|carnal|g[üu]ey|wey|parcer[oa]s?|parce|boludo|bac[aá]n\w*|chamba|qu[eé] onda|[oó]rale|neta|enoj\w*|lind[oa]s?|prep[aá]rense|divi[eé]rtanse|alist[eé]nse|agarr\w*|platita|plata|jugo|carro|vos)\b/gi;
const SPAIN_RE = /\b(t[ií]os?|t[ií]as?|mola\w*|flip\w*|guay|vale|vosotros|os|ten[eé]is|est[aá]is|sois|ya ver[eé]is|hostia|madre m[ií]a|currad\w*|chaval\w*|colega)\b/gi;

// Todos los textos de una clave de config/messages.json (listas, objetos de listas...)
const flattenTexts = v => Array.isArray(v) ? v.flatMap(flattenTexts) : v && typeof v === 'object' ? Object.values(v).flatMap(flattenTexts) : typeof v === 'string' ? [v] : [];

const args = process.argv.slice(2);
const argVal = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

if (args.includes('--worker')) runWorker(argVal('--worker')).catch(err => { console.error(err.stack || err.message); process.exit(1); });
else main();

// ─── Proceso principal: un worker por candidato y luego el informe ───
function main() {
  const filters = args.includes('--filters');
  const models = (argVal('--models') || Object.keys(TARGETS).join(',')).split(',').filter(Boolean);
  const unknown = models.filter(m => !TARGETS[m]);
  if (unknown.length) { console.error(`Candidatos desconocidos: ${unknown.join(', ')}. Disponibles: ${Object.keys(TARGETS).join(', ')}`); process.exit(2); }
  if (!args.includes('--report')) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const m of models) {
      console.log(`\n══ ${m} (${TARGETS[m].model})${filters ? ' como revisor' : ''} ══`);
      const pass = ['--worker', m, ...(filters ? ['--filters'] : []), ...(argVal('--only') ? ['--only', argVal('--only')] : []), ...(argVal('--aux') ? ['--aux', argVal('--aux')] : []), ...(argVal('--tag') ? ['--tag', argVal('--tag')] : [])];
      const r = spawnSync(process.execPath, [__filename, ...pass], { stdio: 'inherit', cwd: ROOT });
      if (r.status) console.error(`  el worker de ${m} terminó con código ${r.status}`);
    }
  }
  writeReport();
}

// ─── Worker: aísla el bot y enruta las llamadas de IA ───
async function runWorker(name) {
  const target = { label: name, ...TARGETS[name] };
  const filters = args.includes('--filters');
  const auxName = argVal('--aux') || 'groq-20b';
  // En --filters el candidato es el revisor; si no, el revisor es común para todos
  const aux = filters ? target : { label: auxName, ...TARGETS[auxName] };
  const only = argVal('--only') ? argVal('--only').split(',') : null;

  // Una sola entrada en todas las cadenas del router: los reintentos no saltan de modelo y route() decide el destino
  // (el candidato o el revisor común). Así este script no depende de la seudonimización del router.
  for (const k of ['MENTION', 'PROVOCATION', 'DIOSFUA', 'TRIVIA', 'QUEMEPERDI', 'COMMAND', 'COHOST', 'TIMER', 'HOOK', 'ALERT', 'REACTION', 'ENDSTREAM', 'REVIEW', 'PICK']) process.env[`AI_CHAIN_${k}`] = 'groq:openai/gpt-oss-120b';
  process.env.BOT_USERNAME = process.env.BOT_USERNAME || 'dios_fua';

  let currentCase = null;
  const calls = [];
  const used = new Map(); // label → { requests, tokens }
  const windows = new Map(); // label → [{ at, tokens }] del último minuto (tiempo real)
  const realNow = Date.now.bind(Date);

  // La espera del limitador no cuenta en el reloj del bot (si no, las menciones se descartan "por tardía")
  let waitedMs = 0;
  async function throttle(t, estTokens) {
    const w = windows.get(t.label) || [];
    windows.set(t.label, w);
    const t0 = realNow();
    for (;;) {
      const now = realNow();
      while (w.length && now - w[0].at > 60000) w.shift();
      const tokens = w.reduce((s, e) => s + e.tokens, 0);
      if (w.length < t.rpm && tokens + estTokens <= t.tpm * 0.9) break;
      await new Promise(r => setTimeout(r, Math.max(500, 60000 - (now - w[0].at) + 200)));
    }
    const waited = realNow() - t0;
    if (waited > 0) { skewMs -= waited; waitedMs += waited; }
    const entry = { at: realNow(), tokens: estTokens };
    w.push(entry);
    return entry;
  }

  function buildBody(t, params) {
    // groq-utils ya sumó la holgura de razonamiento de gpt-oss: se quita y se aplica la del candidato
    const base = params.max_tokens ? params.max_tokens - (params.reasoning_effort ? 64 : 0) : undefined;
    const messages = params.messages.map(m => {
      const c = { ...m };
      if (c.role === 'assistant' && c.content == null) c.content = '';
      return c;
    });
    const body = { model: t.model, messages };
    if (base) body.max_tokens = base + (t.headroom || 0);
    if (params.temperature != null) body.temperature = params.temperature;
    if (params.tools) { body.tools = params.tools; if (params.tool_choice) body.tool_choice = params.tool_choice; }
    for (const k of ['frequency_penalty', 'presence_penalty']) if (params[k] != null) body[k] = params[k];
    if (t.reasoning) body.reasoning_effort = t.reasoning;
    return body;
  }

  async function route(params) {
    const role = /factcheck\.js/.test(new Error().stack) ? 'aux' : 'main';
    const t = role === 'aux' ? aux : target;
    const u = used.get(t.label) || { requests: 0, tokens: 0 };
    used.set(t.label, u);
    if ((t.maxRequests && u.requests >= t.maxRequests) || (t.maxTokens && u.tokens >= t.maxTokens)) {
      const err = new Error(`tope de la prueba alcanzado en ${t.label}`); err.status = 429; err.headers = {};
      calls.push({ case: currentCase, role, target: t.label, error: 'tope de la prueba' });
      throw err;
    }
    const body = buildBody(t, params);
    const est = Math.ceil(JSON.stringify(body.messages).length / 3.2) + (body.max_tokens || 100);
    const slot = await throttle(t, est);
    u.requests++;
    const t0 = realNow();
    const rec = { case: currentCase, role, target: t.label, model: t.model };
    try {
      const r = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
      });
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch { /* cuerpo no JSON */ }
      rec.ms = realNow() - t0;
      if (!r.ok) {
        const msg = (Array.isArray(j) ? j[0]?.error?.message : j?.error?.message) || text;
        rec.error = `HTTP ${r.status}: ${String(msg).slice(0, 160)}`;
        calls.push(rec);
        const err = new Error(`${t.label} ${rec.error}`); err.status = r.status; err.headers = { 'retry-after': r.headers.get('retry-after') };
        throw err;
      }
      const usage = j.usage || {};
      rec.prompt = usage.prompt_tokens; rec.completion = usage.completion_tokens; rec.total = usage.total_tokens;
      rec.finish = j.choices?.[0]?.finish_reason;
      u.tokens += usage.total_tokens || est;
      slot.tokens = usage.total_tokens || est;
      if (j.choices?.[0]?.message?.tool_calls?.length) rec.tool = true;
      calls.push(rec);
      return j;
    } catch (err) {
      if (!rec.ms) { rec.ms = realNow() - t0; rec.error = err.message.slice(0, 160); calls.push(rec); }
      if (!err.status) err.status = 0;
      throw err;
    }
  }

  // El SDK de Groq se sustituye ANTES de cargar groq-utils
  const sdkPath = require.resolve('groq-sdk');
  class RoutedGroq { constructor() { this.chat = { completions: { create: route } }; } }
  require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: RoutedGroq };

  // Aislamiento como en eval.js: logs capturados, escrituras a Supabase bloqueadas, juego fijo
  let currentLogs = [];
  const logger = require('../src/utils/logger');
  for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = msg => currentLogs.push(`${level}: ${msg}`);
  const supabase = require('../src/utils/supabase');
  for (const [k, fn] of Object.entries(supabase)) {
    if (typeof fn === 'function' && /^(save|persist|delete|insert|upsert|update|increment|start|end|migrate)/.test(k)) supabase[k] = async () => {};
  }
  const twitchApi = require('../src/twitch/api');
  twitchApi.getCurrentGame = async () => ({ game: 'Phantom Blade Zero', title: 'Phantom Blade Zero' });
  let skewMs = 0;
  Date.now = () => realNow() + skewMs;

  const quality = require('../src/ai/quality');
  const factcheck = require('../src/ai/factcheck');
  const state = require('../src/utils/state');
  const messagesConfig = require('../config/messages.json');
  const { classifyMessage } = require('../src/ai/patterns');
  const ai = require('../src/ai/handler');

  const pool = key => flattenTexts(messagesConfig[key]);
  const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/eval-cases.json'), 'utf8'));
  let cases = filters
    ? all.filter(c => c.filter)
    : [...all.filter(c => !c.filter), ...COHOST_CASES.map(c => ({ ...c, cohost: true, input: c.moment ? `[evento] ${c.moment.description}` : '[libre] ' + c.chat.map(([u, m]) => `${u}: ${m}`).join(' / ') }))];
  if (only) cases = cases.filter(c => only.includes(c.id));

  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    currentCase = c.id; currentLogs = []; waitedMs = 0;
    const said = [];
    const client = { say: (_ch, text) => { said.push(String(text)); } };
    const tags = { 'display-name': `EvalUser${i + 1}`, username: `evaluser${i + 1}`, 'user-id': `cmp-${i + 1}`, mod: false, badges: {} };
    const started = realNow();
    let kind = '', ret, error = null, rejectedBy = null;
    try {
      state.setDeathCount(c.deaths || 0);
      if (c.filter) {
        kind = `filtro ${c.filter}`;
        const ctx = { deathCount: c.deaths ?? 5, recent: [], named: new Map(), currentGame: c.game || 'Phantom Blade Zero', channelGames: [], usedStructures: new Set(c.usedStructures || []) };
        const rules = { cohost: quality.validateCohost, timer_ia: quality.validateTimerIA, hook: quality.validateHook, mention: (t) => quality.validateMention(t, { question: c.question || '' }) };
        const v = rules[c.filter](c.input, ctx);
        if (!v.ok) rejectedBy = 'regla';
        else {
          const r = await factcheck.evaluate(c.input, `Juego: ${c.game || 'Phantom Blade Zero'}. Muertes anotadas: ${c.deaths ?? 5}.`, { game: c.game || 'Phantom Blade Zero', sense: true });
          if (r.discard) rejectedBy = 'IA: datos'; else if (r.nonsense) rejectedBy = 'IA: sentido';
        }
      } else if (c.cohost) {
        kind = 'cohost';
        state.setStreamIsLive(true);
        state.setStreamStartedAt(Date.now() - 90 * 60000);
        for (const [u, m] of c.chat) ai.addToHistory(u, m);
        ret = await ai.runCohost(client, '#eval', c.moment || null);
        state.setStreamIsLive(false);
      } else if (/^!dios_fua\b/i.test(c.input)) {
        kind = 'dios_fua';
        ret = await ai.handleQuestion(client, '#eval', tags, c.input.split(/\s+/));
      } else {
        kind = `mencion (${classifyMessage(c.input, tags, { botNames: [process.env.BOT_USERNAME] })})`;
        ret = await ai.checkPatternMatch(client, '#eval', tags, c.input);
      }
    } catch (err) { error = err.message; }
    const ms = realNow() - started - waitedMs;
    skewMs += 15 * 60 * 1000;

    const reply = said.length ? said[said.length - 1] : '';
    const answer = reply.replace(/^@\S+\s*/, '');
    // Texto fijo de config/messages.json (reserva cuando la IA falla o se descarta): no cuenta como respuesta del modelo
    const fromPool = Object.keys(messagesConfig).find(k => pool(k).includes(answer)) || '';
    const template = currentLogs.some(l => /plantilla de juego/.test(l));
    const toolLog = currentLogs.map(l => /buscar_juego: "(.*)" → (.*)$/.exec(l) || /buscar_juego: (fuentes no disponibles) para "(.*)"$/.exec(l)).find(Boolean);
    const discards = currentLogs.filter(l => /descartad|SKIP|Descartad|calla/.test(l)).map(l => l.replace(/^\w+: /, '').slice(0, 200));
    const caseCalls = calls.filter(k => k.case === c.id);
    const main = caseCalls.filter(k => k.role === 'main');
    const res = {
      id: c.id, kind, input: c.input, note: c.note || '', informativo: !!c.informativo,
      reply, answer, fromPool, template, ret: typeof ret === 'string' ? ret : undefined, error,
      tool: toolLog ? `${toolLog[1]} → ${toolLog[2]}` : null,
      discards, ms,
      mainCalls: main.length, auxCalls: caseCalls.length - main.length,
      mainMs: main.map(k => k.ms), mainPrompt: main.map(k => k.prompt || 0), mainCompletion: main.map(k => k.completion || 0), mainTotal: main.map(k => k.total || 0),
      callErrors: caseCalls.filter(k => k.error).map(k => `${k.role}/${k.target}: ${k.error}`),
      thought: main.some(k => k.thought),
      latam: (answer.match(LATAM_RE) || []).map(s => s.toLowerCase()),
      spain: (answer.match(SPAIN_RE) || []).map(s => s.toLowerCase()),
      failures: c.filter ? filterCheck(c, rejectedBy) : (c.cohost ? [] : check(c.expect || {}, { kind, tool: toolLog, answer, reply, fromPool, isCommand: kind === 'dios_fua' })),
      rejectedBy,
    };
    results.push(res);
    console.log(`[${i + 1}/${cases.length}] ${res.failures.length ? 'FALLA' : 'OK   '} ${c.id} · ${(ms / 1000).toFixed(1)} s · ${res.mainCalls}+${res.auxCalls} llamadas${c.filter ? ` · ${rejectedBy || 'pasa'}` : ''}\n    ${reply || (error ? `ERROR ${error}` : `(sin respuesta${discards.length ? `: ${discards[0]}` : ''})`)}${res.failures.length ? `\n    ✘ ${res.failures.join('; ')}` : ''}`);
  }
  const file = path.join(OUT_DIR, `${filters ? 'revisor-' : ''}${name}${argVal('--tag') ? '-' + argVal('--tag') : ''}.json`);
  let merged = { results, calls };
  // Con --only se sustituyen esos casos en el resultado anterior (p. ej. repetir los que dependen de IGDB)
  if (only && fs.existsSync(file)) {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ids = new Set(results.map(r => r.id));
    merged = { results: [...prev.results.filter(r => !ids.has(r.id)), ...results], calls: [...prev.calls.filter(c => !ids.has(c.case)), ...calls] };
  }
  fs.writeFileSync(file, JSON.stringify({ candidate: name, model: target.model, aux: aux.label, filters, at: new Date().toISOString(), used: Object.fromEntries(used), ...merged }, null, 1));
  console.log(`→ ${path.relative(ROOT, file)} · peticiones/tokens: ${JSON.stringify(Object.fromEntries(used))}`);
  process.exit(0);
}

// Lo esperado en eval-cases.json (mismo criterio que scripts/eval.js)
function check(exp, r) {
  const f = [];
  const re = p => new RegExp(p, 'i');
  if (exp.discarded === false && (r.fromPool === 'dios_fua_no_data' || (!r.isCommand && !r.reply))) f.push('descartada / sin respuesta');
  if (exp.reply && !r.reply) f.push('no hubo respuesta');
  if (exp.tool === 'none' && r.tool) f.push(`llamó a buscar_juego("${r.tool[1]}")`);
  if (exp.tool === 'buscar_juego' && !r.tool) f.push('no llamó a buscar_juego');
  if (!r.reply) return f;
  if (exp.maxChars && r.answer.length > exp.maxChars) f.push(`larga: ${r.answer.length} > ${exp.maxChars}`);
  if (exp.matchAny && !exp.matchAny.some(p => re(p).test(r.answer))) f.push(`no cumple ninguno de: ${exp.matchAny.join(' | ')}`);
  for (const p of exp.matchAll || []) if (!re(p).test(r.answer)) f.push(`falta /${p}/`);
  for (const p of exp.matchNone || []) if (re(p).test(r.answer)) f.push(`contiene /${p}/`);
  for (const key of exp.notFromPool || []) if (r.fromPool === key) f.push(`respuesta de reserva (${key})`);
  return f;
}

function filterCheck(c, rejectedBy) {
  if (c.expect?.rejected === true && !rejectedBy) return ['la frase mala pasó'];
  if (c.expect?.rejected === false && rejectedBy) return [`frase buena descartada (${rejectedBy})`];
  return [];
}

// ─── Informe lado a lado ───
function writeReport() {
  if (!fs.existsSync(OUT_DIR)) { console.error('No hay resultados en logs/compare/.'); return; }
  // Textos fijos de config/messages.json: se recalculan aquí para que valgan también para resultados guardados antes
  const msgs = require('../config/messages.json');
  const fixedKey = answer => Object.keys(msgs).find(k => flattenTexts(msgs[k]).includes(answer)) || '';
  const load = prefix => fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.json') && (prefix ? f.startsWith(prefix) : !f.startsWith('revisor-')))
    .map(f => JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8')))
    .map(g => { for (const x of g.results) if (!x.fromPool && x.answer) x.fromPool = fixedKey(x.answer); return g; })
    .sort((a, b) => Object.keys(TARGETS).indexOf(a.candidate) - Object.keys(TARGETS).indexOf(b.candidate));
  const gen = load('');
  const rev = load('revisor-');
  const med = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const p90 = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : 0; };
  const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
  const L = [];
  L.push('# Comparativa de modelos gratuitos — respuestas lado a lado', '', `Generado por \`scripts/compare-models.js\` el ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Revisor común (factcheck/sentido) en la generación: ${[...new Set(gen.map(g => g.aux))].join(', ') || '—'}.`, '');
  if (gen.length) {
    // Latencia y tokens solo de las llamadas de generación que respondieron; los fallos van aparte
    const okMain = g => g.calls.filter(c => c.role === 'main' && !c.error && c.total);
    const mainAll = g => g.calls.filter(c => c.role === 'main' && c.error !== 'tope de la prueba');
    L.push('## Resumen por candidato (medido)', '', '| Candidato | Modelo | Casos | Con respuesta del modelo** | Cumple lo esperado* | Texto fijo / plantilla | Llamadas de generación con error | Latencia por llamada correcta (mediana / p90 / máx.) | Tokens entrada / salida / total por llamada | Rasgos latinos |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const g of gen) {
      const r = g.results;
      const scored = r.filter(x => !x.kind.startsWith('cohost') && !x.informativo);
      const ok = okMain(g);
      const ms = ok.map(c => c.ms);
      const all = mainAll(g);
      L.push(`| ${g.candidate} | ${g.model} | ${r.length} | ${r.filter(x => x.reply && x.mainCalls && !x.fromPool && !x.template).length} | ${scored.filter(x => !x.failures.length).length}/${scored.length} | ${r.filter(x => x.fromPool || x.template).length} | ${all.length - ok.length}/${all.length} | ${(med(ms) / 1000).toFixed(1)} s / ${(p90(ms) / 1000).toFixed(1)} s / ${((Math.max(0, ...ms)) / 1000).toFixed(1)} s | ${avg(ok.map(c => c.prompt))} / ${avg(ok.map(c => c.completion))} / ${avg(ok.map(c => c.total))} | ${r.reduce((s, x) => s + x.latam.length, 0)} |`);
    }
    L.push('', '\\* Expectativas automáticas de `test/eval-cases.json` (sin cohost ni casos informativos).', '\\*\\* Sin contar textos fijos de `config/messages.json` (reservas), plantillas de juego ni lo que responde el código sin IA (muertes, qué juego, dificultad). Los cohost que responden SKIP no tienen respuesta y es correcto.', '');
    L.push('## Tokens medidos por tipo de llamada (generación, solo llamadas correctas)', '', '| Candidato | Tipo | Llamadas | Entrada media | Salida media | Total medio (con razonamiento) |', '|---|---|---|---|---|---|');
    for (const g of gen) {
      const kindOf = Object.fromEntries(g.results.map(x => [x.id, x.kind.split(' ')[0]]));
      const byKind = {};
      for (const c of okMain(g)) (byKind[kindOf[c.case]] ||= []).push(c);
      for (const [k, cs] of Object.entries(byKind)) L.push(`| ${g.candidate} | ${k} | ${cs.length} | ${avg(cs.map(c => c.prompt))} | ${avg(cs.map(c => c.completion))} | ${avg(cs.map(c => c.total))} |`);
    }
    const auxCalls = gen.flatMap(g => g.calls.filter(c => c.role === 'aux' && c.total));
    if (auxCalls.length) L.push('', `Revisiones (factcheck/sentido, revisor común): ${auxCalls.length} llamadas, entrada media ${avg(auxCalls.map(c => c.prompt))}, total medio ${avg(auxCalls.map(c => c.total))} tokens.`);
    L.push('', '## Respuestas lado a lado', '');
    const ids = [...new Set(gen.flatMap(g => g.results.map(x => x.id)))];
    for (const id of ids) {
      const first = gen.flatMap(g => g.results).find(x => x.id === id);
      L.push(`### ${id} — ${first.kind.split(' ')[0]}`, '', `> ${first.input.replace(/\n/g, ' ')}`, '', `_Esperado: ${first.note || '—'}_`, '', '| Candidato | Respuesta | Notas |', '|---|---|---|');
      for (const g of gen) {
        const x = g.results.find(y => y.id === id);
        if (!x) { L.push(`| ${g.candidate} | _(no se probó)_ | |`); continue; }
        const notes = [
          `${(x.ms / 1000).toFixed(1)} s`, `${x.mainCalls} llam.`,
          x.tool ? `buscar_juego: ${x.tool.slice(0, 60)}` : '',
          x.fromPool ? `reserva (${x.fromPool})` : '', x.template ? 'plantilla de juego' : '',
          x.thought ? 'devolvió <thought>' : '',
          x.latam.length ? `latino: ${x.latam.join(',')}` : '',
          ...x.failures.map(f => `✘ ${f}`),
          ...(x.reply ? [] : x.discards.slice(0, 2).map(d => `descarte: ${d.slice(0, 90)}`)),
          ...x.callErrors.slice(0, 2).map(e => `API ${e.slice(0, 90)}`),
          x.error ? `excepción: ${x.error.slice(0, 80)}` : '',
        ].filter(Boolean).join(' · ');
        L.push(`| ${g.candidate} | ${(x.reply || '_(sin respuesta)_').replace(/\|/g, '/').replace(/\n/g, ' ')} | ${notes.replace(/\|/g, '/')} |`);
      }
      L.push('');
    }
  }
  if (rev.length) {
    L.push('## Revisión de sentido/datos con cada modelo como revisor (casos "filter")', '', '| Revisor | Casos | Aciertos | Frases malas que pasan | Buenas descartadas | Latencia mediana | Errores API |', '|---|---|---|---|---|---|---|');
    for (const g of rev) {
      const r = g.results;
      L.push(`| ${g.candidate} | ${r.length} | ${r.filter(x => !x.failures.length).length} | ${r.filter(x => x.failures.some(f => f.startsWith('la frase mala'))).length} | ${r.filter(x => x.failures.some(f => f.startsWith('frase buena'))).length} | ${(med(g.calls.filter(c => c.ms).map(c => c.ms)) / 1000).toFixed(1)} s | ${g.calls.filter(c => c.error).length} |`);
    }
    L.push('', '| Caso | Frase | ' + rev.map(g => g.candidate).join(' | ') + ' |', '|---|---|' + rev.map(() => '---|').join(''));
    for (const x0 of rev[0].results) {
      L.push(`| ${x0.id} | ${x0.input.slice(0, 70).replace(/\|/g, '/')} | ${rev.map(g => { const x = g.results.find(y => y.id === x0.id); return x ? `${x.rejectedBy || 'pasa'}${x.failures.length ? ' ✘' : ''}` : '—'; }).join(' | ')} |`);
    }
  }
  fs.writeFileSync(REPORT, L.join('\n') + '\n');
  console.log(`\nInforme: ${path.relative(ROOT, REPORT)}`);
}
