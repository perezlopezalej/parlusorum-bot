process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';
process.env.CHANNEL = process.env.CHANNEL || 'parlusorum';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// La API de Twitch (juego actual, ficha) se sustituye antes de cargar el handler: sin red
const apiPath = require.resolve('../src/twitch/api');
require(apiPath);
const api = require.cache[apiPath].exports;
api.getCurrentGame = async () => ({ game: 'Phantom Blade Zero' });
api.lookupGameInfo = async () => ({ info: null });
api.getGameInfo = async () => null;

const router = require('../src/utils/ai-router');
const state = require('../src/utils/state');
const style = require('../src/ai/style');
const quality = require('../src/ai/quality');
const ai = require('../src/ai/handler');

const FORBIDDEN_IN_PROMPT = [
  /\bt[ií]o\b/i, /\bt[ií]a\b/i, /\bcolega\b/i, /\bbro\b/i, /\bchaval\b/i, /pucha|qué onda|órale|chido|ahorita|\bwey\b|parcero|enojarse|concha/i,
  /la reina del FUA/i, /Lo siento/i, /como IA/i, /comentarista deportivo/i, /Manu lleva N/i, /tarde de martes/i,
  /PROHIBIDO|NUNCA|\bNO\b|TU INTENTO ANTERIOR|RECHAZADO|YA DIJISTE|NO repetir/,
];

let sent, prompts, replies;
const client = { say: (ch, msg) => { sent.push(msg); } };
function stubModels(fn) {
  const t = async p => { prompts.push(p.messages); return fn(p); };
  router.setTransport('groq', t);
  router.setTransport('gemini', t);
}
const json = (...c) => ({ choices: [{ message: { content: JSON.stringify({ candidatos: c }) }, finish_reason: 'stop' }] });
const text = c => ({ choices: [{ message: { content: c }, finish_reason: 'stop' }] });

beforeEach(() => {
  sent = []; prompts = []; replies = [];
  state.resetAiBlocks(); state.resetAiUsage();
  state.setStreamIsLive(true);
  state.setStreamStartedAt(Date.now() - 47 * 60000);
  ai.addToHistory('gangar79', 'Jajaja otra vez ese jefe');
  ai.addToHistory('markosssx', 'Manu no te rindas');
  ai.addToHistory('mujica90_', 'Va a tardar en pasárselo');
});

describe('prompts nuevos: sin prohibidas citadas', () => {
  test('provocación, cohost, mención, !dios_fua y alertas', () => {
    const all = [
      style.buildProvocationSystem(),
      style.buildCohostSystem({ game: 'X', minutes: 10, deathLine: '3 caídas anotadas.', form: style.COHOST_FORMS[0], emoteLine: 'Escribe solo texto.', nameLine: 'Dirígete a Manu.', loreBlock: '<lore>La comunidad del canal son los Lusorums.</lore>' }),
      style.buildMentionSystem({ context: 'Se está jugando a «X».', role: style.roleLine('creator'), emoteLine: 'Escribe solo texto.' }),
      style.buildQuestionSystem({ context: 'Se está jugando a «X».' }),
      ...['sub', 'raid', 'bienvenida', 'prediccion'].map(type => style.buildAlertSystem({ type, event: 'Evento.' })),
      style.buildSummaryPrompt({ game: 'X', durationMinutes: 60, deathCount: 3, peakViewers: 8, topCommands: [], chatSample: 'a: hola' }),
    ];
    for (const p of all) for (const re of FORBIDDEN_IN_PROMPT) assert.doesNotMatch(p, re, `${re} en: ${p.slice(0, 60)}`);
  });

  test('cohost: identidad corta y sin los últimos mensajes del bot', () => {
    const p = style.buildCohostSystem({ form: style.COHOST_FORMS[1], examples: style.pickStyleExamples('cohost', 4) });
    assert.ok(p.length / 3.6 < 600, `${Math.round(p.length / 3.6)} tokens`);
    assert.doesNotMatch(p, /TUS RESPUESTAS ANTERIORES/);
  });
});

describe('ejemplos y formas', () => {
  test('los ejemplos del cohost salen del archivo editable y rotan', () => {
    const data = style.loadExamples();
    assert.equal(data.cohost.length, 13);
    const seen = new Set();
    for (let i = 0; i < 30; i++) seen.add(style.pickStyleExamples('cohost', 4).join('|'));
    assert.ok(seen.size > 3);
    for (const e of style.pickStyleExamples('cohost', 4)) assert.ok(data.cohost.includes(e));
  });
  test('la forma del cohost nunca repite la anterior', () => {
    let last = '';
    for (let i = 0; i < 200; i++) { const f = style.pickCohostForm(last); assert.notEqual(f.id, last); last = f.id; }
    assert.deepEqual(style.COHOST_FORMS.map(f => f.id).sort(), ['autoironia', 'exageracion', 'pregunta', 'reaccion', 'vacile']);
  });
  test('ningún ejemplo enseña muletillas ni la estructura del contador', () => {
    const data = style.loadExamples();
    for (const [k, list] of Object.entries(data)) {
      if (k.startsWith('_')) continue;
      for (const e of list) {
        const t = typeof e === 'string' ? e : e.texto;
        assert.doesNotMatch(t, /\bt[ií][oa]\b|\bcolega\b|\bbro\b|\bchaval\b/i, t);
        assert.doesNotMatch(t, /\blleva \d+ (muertes|ca[ií]das)/i, t);
      }
    }
  });
});

describe('candidatos', () => {
  test('parseCandidates: JSON, bloque ```json, array suelto, texto plano y JSON cortado', () => {
    assert.deepEqual(style.parseCandidates('{"candidatos":["a b","c d","e f","g h"]}'), ['a b', 'c d', 'e f']);
    assert.deepEqual(style.parseCandidates('```json\n{"candidatos":["uno"]}\n```'), ['uno']);
    assert.deepEqual(style.parseCandidates('["x y","z w"]'), ['x y', 'z w']);
    assert.deepEqual(style.parseCandidates('Una frase sin JSON.'), ['Una frase sin JSON.']);
    assert.deepEqual(style.parseCandidates('{"candidatos":["completo uno","cortado'), ['completo uno']);
    assert.deepEqual(style.parseCandidates('{"candidatos":[]}'), []);
  });
  test('rankCandidates: descarta los que fallan y deja primero el que menos se parece a lo reciente', () => {
    const recent = ['El jefe ya sabe el nombre de Manu y toca sacar el FUA.'];
    const { ranked, failures } = style.rankCandidates(
      ['El jefe ya sabe el nombre de Manu otra vez.', 'Pregunta seria: ¿quién abona el terreno hoy?', 'x'],
      { validate: t => (t.length < 8 ? { ok: false, rule: 'vacio', reason: 'corto' } : { ok: true }), recent }
    );
    assert.equal(ranked[0].text, 'Pregunta seria: ¿quién abona el terreno hoy?');
    assert.equal(failures.length, 1);
  });
});

describe('reintentos en positivo', () => {
  test('todos los motivos de quality.js se traducen sin citar lo rechazado', () => {
    const reasons = [
      'usa expresiones latinoamericanas; escribe español de España',
      'repite la estructura "Manu lleva N caídas y el FUA…" que ya usaste en este stream; cambia de enfoque y no cites el contador',
      'usa una comparación forzada ("igual que un despertador un lunes"); di la idea directa',
      'suena a autoayuda o motivación ("qué os da fuerzas…")',
      'habla de sí mismo como "el bot"; habla en primera persona o como el FUA',
      'nombra a gangar79, que ya se nombró hace poco; no lo repitas',
      'repite el género del juego ("juego de rol y acción"); no lo uses en cada mensaje',
      'afirma datos del juego sin respaldo; no hables del juego',
      'dices "es de Japón" y no lo sabes (país, personas, cifras); no lo afirmes',
    ];
    for (const r of reasons) {
      const note = style.retryNote(r);
      assert.match(note, /^\n<correccion>.+<\/correccion>$/, r);
      for (const re of [/Manu lleva N/, /despertador/, /fuerzas/, /rol y acción/, /gangar79/, /Japón/, /\bNO\b|\bno\b (lo|hables|cites|uses)/]) assert.doesNotMatch(note, re, r);
    }
    assert.equal(style.retryNote(''), '');
  });
});

describe('cohost con tres candidatos', () => {
  test('envía el que pasa los filtros y no se parece a lo reciente; el prompt lleva etiquetas y ejemplos', async () => {
    stubModels(() => json('Chavales, qué grande sois Lusorums, tío.', 'El jefe ya sabe el camino a casa de Manu de memoria.', 'Hacer caso al chat con ese historial es jugársela.'));
    const out = await ai.runCohost(client, '#parlusorum', null);
    assert.equal(out, 'sent');
    assert.equal(sent.length, 1);
    const sys = prompts[0][0].content;
    assert.match(sys, /<stream>/);
    assert.match(sys, /<ejemplos>[\s\S]*<example>/);
    assert.match(sys, /<forma>/);
    assert.match(sys, /\{"candidatos"/);
    assert.match(prompts[0][1].content, /<chat>/);
    assert.match(prompts[0][1].content, /<tema>/);
    for (const re of FORBIDDEN_IN_PROMPT) assert.doesNotMatch(sys, re);
  });

  test('si los tres candidatos fallan, reintenta con la corrección en positivo y después se calla', async () => {
    const bad = json('Ese jefe lleva dos años sin descanso por su aire latino ahorita.', 'Qué onda con el wey ese del chat, órale.', 'Pucha, esto está chido de verdad.');
    stubModels(() => bad);
    const out = await ai.runCohost(client, '#parlusorum', null);
    assert.equal(out, 'dropped');
    assert.equal(sent.length, 0);
    assert.equal(prompts.length, 2, 'un intento y un reintento');
    const retrySys = prompts[1][0].content;
    assert.match(retrySys, /<correccion>Escríbelo como lo diría alguien de Madrid\.<\/correccion>/);
    assert.doesNotMatch(retrySys, /pucha|ahorita|órale|wey|chido/i);
  });

  test('suceso: la forma cambia entre llamadas y no se repite', async () => {
    const forms = [];
    stubModels(p => { forms.push((/<forma>([^.]*\.)/.exec(p.messages[0].content) || [])[1]); return json('Buen intento de Manu, el FUA aplaude desde su nube.', 'El FUA se levanta antes que el propio jefe de la zona.', 'Otra para el álbum de caídas con más estilo del canal.'); });
    for (let i = 0; i < 4; i++) {
      state.resetCohostTexts?.();
      await ai.runCohost(client, '#parlusorum', { kind: 'death', description: 'Manu ha caído contra un jefe' });
    }
    for (let i = 1; i < forms.length; i++) assert.notEqual(forms[i], forms[i - 1]);
  });
});

describe('menciones, !dios_fua y provocaciones', () => {
  test('mención: prompt con etiquetas, ejemplos y rol; reintento solo con la corrección', async () => {
    let n = 0;
    stubModels(() => text(n++ === 0 ? 'Claro tío, ahorita te lo cuento.' : 'Apuesto por veinte caídas y el FUA por más.'));
    const tags = { 'display-name': 'gangar79', 'user-id': '1', username: 'gangar79', badges: {} };
    const out = await ai.checkPatternMatch(client, '#parlusorum', tags, 'dios fua tú qué opinas del stream de hoy?');
    assert.equal(out, true);
    const mentionPrompts = prompts.filter(m => /<tarea>Responde al mensaje/.test(m[0].content)); // la revisión de sentido es otra llamada
    assert.equal(mentionPrompts.length, 2);
    const sys = mentionPrompts[0][0].content;
    assert.match(sys, /<contexto>/);
    assert.match(sys, /<ejemplos>[\s\S]*<mensaje>/);
    assert.match(sys, /<tarea>/);
    assert.match(mentionPrompts[1][0].content, /<correccion>/);
    assert.doesNotMatch(mentionPrompts[1][0].content, /ahorita/);
    assert.match(sent[0], /veinte caídas/);
  });

  test('!dios_fua: prompt con etiquetas y herramienta; la respuesta se envía', async () => {
    stubModels(() => text('La luz azul rebota más en el aire y por eso el cielo es azul.'));
    const tags = { 'display-name': 'gangar79', 'user-id': '2', username: 'gangar79', badges: {} };
    await ai.handleQuestion(client, '#parlusorum', tags, ['!dios_fua', 'por', 'qué', 'el', 'cielo', 'es', 'azul']);
    const sys = prompts[0][0].content;
    assert.match(sys, /<forma>[\s\S]*buscar_juego/);
    assert.match(sys, /<tarea>Responde a la pregunta del usuario; si nombra un videojuego, consulta antes buscar_juego\.<\/tarea>$/);
    for (const re of FORBIDDEN_IN_PROMPT) assert.doesNotMatch(sys, re);
    assert.match(sent[0], /cielo es azul/);
  });

  test('provocación: prompt corto con ejemplos de réplica', async () => {
    stubModels(() => text('Qué arte tienes para el insulto, así da gusto.'));
    const tags = { 'display-name': 'trol', 'user-id': '3', username: 'trol', badges: {} };
    const realNow = Date.now;
    Date.now = () => realNow() + 3600e3; // fuera de los cooldowns de la mención anterior
    try { await ai.checkPatternMatch(client, '#parlusorum', tags, 'dios fua eres un idiota'); } finally { Date.now = realNow; }
    const sys = prompts[0]?.[0].content || '';
    assert.match(sys, /<ejemplos>/);
    assert.ok(sys.length / 3.6 < 450);
  });
});
