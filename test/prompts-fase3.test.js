process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';
process.env.CHANNEL = process.env.CHANNEL || 'parlusorum';
process.env.HOOK_INTERVAL_MS = '0';
process.env.HOOK_SILENCE_MS = '0';
process.env.COHOST_BOSS_SETTLE_MS = '40';
process.env.AI_TIMER_INTERVAL_MS = '80';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Sin red: Twitch/IGDB, viewers y Supabase se sustituyen antes de cargar el handler
const apiPath = require.resolve('../src/twitch/api');
require(apiPath);
const api = require.cache[apiPath].exports;
let igdb = { info: null };
let currentGame = 'Phantom Blade Zero';
api.getCurrentGame = async () => ({ game: currentGame });
api.lookupGameInfo = async () => igdb;
api.getGameInfo = async () => null;
api.getChannelInfo = async () => ({ game_name: 'Hades' });
const eventsub = require('../src/eventsub');
eventsub.getViewersWithAppToken = async () => 20;
const supabase = require('../src/utils/supabase');
let sessions = 1;
supabase.countSessionsOfGame = async () => sessions;

const router = require('../src/utils/ai-router');
const state = require('../src/utils/state');
const q = require('../src/ai/quality');
const style = require('../src/ai/style');
const narrative = require('../src/utils/narrative');
const ai = require('../src/ai/handler');
const messages = require('../config/messages.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const FORBIDDEN = [/\bt[ií]o\b/i, /\bcolega\b/i, /PROHIBIDO|NUNCA|\bNO\b|TU INTENTO ANTERIOR|RECHAZADO|YA DIJISTE/, /comentarista deportivo/i, /tarde de martes/i];
let said, prompts;
const client = { say: (ch, msg) => { said.push(msg); } };
function stubModels(fn) {
  const t = async p => { prompts.push(p.messages); return fn(p); };
  router.setTransport('groq', t);
  router.setTransport('gemini', t);
}
const text = c => ({ choices: [{ message: { content: c }, finish_reason: 'stop' }] });

beforeEach(() => {
  said = []; prompts = [];
  state.resetAiBlocks(); state.resetAiUsage();
  state.setStreamIsLive(true);
  state.setStreamStartedAt(Date.now() - 90 * 60000);
  igdb = { info: null };
});

describe('prompts de hook, timer, !so y !quemeperdi', () => {
  test('etiquetas, ejemplos propios y tarea al final, sin prohibidas citadas', () => {
    const all = {
      hook: style.buildHookSystem({ game: 'X' }),
      timer: style.buildTimerSystem({ game: 'X' }),
      shoutout: style.buildShoutoutSystem(),
      quemeperdi: style.buildQueMePerdiSystem({ game: 'X' }),
    };
    for (const [k, p] of Object.entries(all)) {
      assert.match(p, /<forma>/, k);
      assert.match(p, /<ejemplos>[\s\S]*<example>/, k);
      assert.match(p, /<tarea>.+<\/tarea>$/, k);
      const n = p.split('<example>').length - 1;
      assert.ok(n >= 3 && n <= 5, `${k}: ${n} ejemplos`);
      for (const re of FORBIDDEN) assert.doesNotMatch(p, re, k);
    }
    assert.match(all.hook, /Hoy es (lunes|martes|miércoles|jueves|viernes|sábado|domingo) por la (mañana|tarde|noche)\./);
    assert.match(all.hook, /termina en «\?»/);
    assert.match(all.timer, /última media hora/);
  });
  test('los ejemplos nuevos están en el archivo editable y no enseñan muletillas', () => {
    const data = style.loadExamples();
    for (const k of ['hook', 'timer', 'shoutout', 'quemeperdi']) {
      assert.ok(data[k].length >= 3, k);
      for (const e of data[k]) assert.doesNotMatch(e, /\bt[ií][oa]\b|\bcolega\b|\bbro\b|\bchaval\b/i, e);
    }
    for (const e of data.hook) assert.match(e, /\?/);
  });
  test('día real: dayLine usa Madrid', () => {
    assert.equal(style.dayLine(new Date('2026-11-07T16:00:00Z')), 'Hoy es sábado por la tarde.');
    assert.equal(style.dayLine(new Date('2026-11-09T07:30:00Z')), 'Hoy es lunes por la mañana.');
    assert.equal(style.dayLine(new Date('2026-11-09T23:30:00Z')), 'Hoy es martes por la noche.'); // 00:30 en Madrid
  });
  test('el cohost recibe el día real', () => {
    const p = style.buildCohostSystem({ form: style.COHOST_FORMS[0], now: new Date('2026-11-07T16:00:00Z') });
    assert.match(p, /Hoy es sábado por la tarde\./);
  });
});

describe('quality: día de la semana, etnias, latinismos, citas', () => {
  const sab = new Date('2026-11-07T16:00:00Z');
  test('un día de la semana que no es hoy se rechaza ("tarde de martes" un sábado)', () => {
    assert.equal(q.wrongWeekday('Qué tarde de martes tan épica', sab), true);
    assert.equal(q.wrongWeekday('Qué tarde de sábado tan épica', sab), false);
    assert.equal(q.wrongWeekday('El lunes por la mañana vuelve el directo', sab), true);
    assert.equal(q.wrongWeekday('El FUA no mira el calendario', sab), false);
    assert.equal(q.styleProblem('Una tarde de martes de lo más FUA', { now: sab }).rule, 'dia');
  });
  test('payo y otras expresiones con etnias', () => {
    for (const t of ['Menudo payo el jefe', 'Eso es una gitanada', 'Trabajar como un negro en este nivel']) assert.equal(q.styleProblem(t).rule, 'etnia', t);
    assert.equal(q.styleProblem('Manu pelea contra el jefe sin descanso'), null);
  });
  test('"bravo" enfadado y "te queda chico" son latinismos; "¡bravo!" y "chico" sustantivo, no', () => {
    for (const t of ['El FUA te queda chico', 'A Manu le queda chica la zona', 'Está bravo el jefe hoy', 'Se puso bravo el chat', 'Estoy muy bravo con esto']) assert.equal(q.hasLatam(t), true, t);
    for (const t of ['¡Bravo, Manu, qué partida!', 'Ese chico del chat sabe mucho', 'Un toro bravo en la pantalla', 'Los chicos del chat vienen con ganas']) assert.equal(q.hasLatam(t), false, t);
  });
  test('!quemeperdi: una cita que no está en el chat se rechaza, una real no', () => {
    const source = 'gangar79: eso se esquiva con calma\nmarkosssx: vamos Manu';
    assert.ok(q.inventedQuote('El chat dijo "Manu es un crack total" a lo grande', source));
    assert.equal(q.inventedQuote('El chat dijo "eso se esquiva con calma" y Manu lo hizo', source), '');
    assert.equal(q.inventedQuote('Sin comillas ni citas, solo cuento lo ocurrido', source), '');
    assert.match(q.validateQueMePerdi('El chat gritó «Manu es un crack total» al terminar la pelea.', { deathCount: 0, bosses: 0, source }), /cita un mensaje del chat/);
    assert.equal(q.validateQueMePerdi('El chat animó a Manu mientras el jefe caía por fin.', { deathCount: 0, bosses: 0, source }), null);
  });
  test('la corrección en positivo cubre los motivos nuevos', () => {
    assert.match(style.retryNote('cita un día de la semana que no es hoy; habla del momento sin inventar el día'), /sin nombrar el día de la semana/);
    assert.match(style.retryNote('no es una pregunta al chat'), /pregunta al chat/);
    assert.match(style.retryNote('cita un mensaje del chat que no existe (entrecomillado inventado)'), /propias palabras/);
    assert.match(style.retryNote('usa una expresión con etnias o pueblos; haz la broma sobre la partida o el FUA'), /partida o el FUA/);
  });
});

describe('consulta de juegos en menciones', () => {
  test('extractGameQuery: nombre del juego tras la frase que lo introduce', () => {
    const cases = [
      ['dios fua cuéntame de qué va Silent Hill F', 'Silent Hill F', true],
      ['dios fua qué tal es Hades?', 'Hades', true],
      ['@dios_fua has jugado a Celeste, por favor?', 'Celeste', true],
      ['dios fua qué opinas de Hollow Knight', 'Hollow Knight', false],
    ];
    for (const [t, name, strict] of cases) assert.deepEqual(q.extractGameQuery(t), { name, strict }, t);
    assert.equal(q.extractGameQuery('dios fua de qué va esto'), null);
    assert.equal(q.extractGameQuery('dios fua qué hora es'), null);
  });
  const tags = n => ({ 'display-name': `user${n}`, 'user-id': `g${n}`, username: `user${n}`, badges: {} });
  async function ask(n, msg) {
    const realNow = Date.now;
    Date.now = () => realNow() + n * 3600e3; // fuera de los cooldowns de la mención anterior
    try { return await ai.checkPatternMatch(client, '#parlusorum', tags(n), msg); } finally { Date.now = realNow; }
  }
  test('juego encontrado: responde con los datos de IGDB, sin llamar a la IA', async () => {
    igdb = { info: { name: 'Silent Hill f', released: '2025-09-25', genres: 'Horror, Adventure', developers: 'NeoBards Entertainment' } };
    stubModels(() => { throw new Error('no debería llamar a la IA'); });
    assert.equal(await ask(1, 'dios fua cuéntame de qué va Silent Hill f'), true);
    assert.equal(prompts.length, 0);
    assert.match(said[0], /^@user1 Silent Hill f/);
    assert.match(said[0], /NeoBards/);
    assert.match(said[0], /2025/);
  });
  test('juego que IGDB no conoce: lo dice con humor', async () => {
    igdb = { info: null };
    stubModels(() => { throw new Error('no debería llamar a la IA'); });
    assert.equal(await ask(2, 'dios fua cuéntame de qué va Zxqwv Mnbrt'), true);
    assert.ok(messages.mention_not_understood.some(m => said[0].includes(m)), said[0]);
  });
  test('IGDB caído: redirige a !dios_fua', async () => {
    igdb = { info: null, error: true };
    stubModels(() => { throw new Error('no debería llamar a la IA'); });
    await ask(3, 'dios fua qué tal es Hades?');
    assert.ok(messages.mention_game_redirect.some(m => said[0].includes(m)), said[0]);
  });
  test('una opinión sobre algo que no es un juego sigue al camino normal con IA', async () => {
    igdb = { info: null };
    stubModels(() => text('Manu es un crack y el FUA lo sabe de memoria.'));
    await ask(4, 'dios fua qué opinas de Manu');
    assert.ok(prompts.some(m => /<tarea>Responde al mensaje/.test(m[0].content)));
    assert.match(said[0], /crack/);
  });
});

describe('hooks', () => {
  async function runHook() {
    await sleep(5);
    ai.addToHistory('gangar79', `mensaje ${Math.random()}`);
    await sleep(5);
    await ai.checkChatHook(client, '#parlusorum');
  }
  test('sin sucesos: hook fijo, sin IA; los fijos del juego solo en los 2 primeros streams del juego', async () => {
    state.resetStreamNarrative();
    stubModels(() => { throw new Error('sin sucesos no se llama a la IA'); });
    sessions = 5;
    for (let i = 0; i < 12; i++) await runHook();
    assert.equal(prompts.length, 0);
    assert.ok(said.length >= 5, `${said.length} hooks`);
    for (const m of said) assert.doesNotMatch(m, /Phantom Blade Zero|conoc[ií]a|Qué os parece/, m);
  });
  test('juego nuevo (1.er stream): pueden salir los fijos del juego', async () => {
    state.resetStreamNarrative();
    stubModels(() => { throw new Error('sin IA'); });
    sessions = 1;
    currentGame = 'Juego Nuevo Total'; // la caché de permisos es por juego
    // el estado de "hooks usados" se rellena con los fijos: se recorren todos
    for (let i = 0; i < 40; i++) await runHook();
    assert.ok(said.some(m => /Juego Nuevo Total/.test(m)), 'algún hook del juego en un juego nuevo');
  });
  test('con sucesos: pregunta al chat por IA basada en lo ocurrido; si no es pregunta, reintenta con corrección', async () => {
    state.resetStreamNarrative();
    state.addNarrativeEvent('death', 'Manu ha muerto', 2);
    state.addNarrativeEvent('boss', 'Jefe derrotado (#1 de este stream)');
    let n = 0;
    stubModels(() => text(n++ === 0 ? 'Qué jefe tan duro ha sido ese.' : '¿Cuál ha sido el momento más tenso de esa pelea contra el jefe?'));
    await runHook();
    const hookPrompts = prompts.filter(m => /<tarea>Escribe una pregunta al chat/.test(m[0].content));
    assert.equal(hookPrompts.length, 2);
    assert.match(hookPrompts[0][1].content, /<suceso>2 caídas del streamer; 1 jefe superado/);
    assert.match(hookPrompts[1][0].content, /<correccion>Termina con una pregunta al chat\.<\/correccion>/);
    assert.match(said.at(-1), /momento más tenso/);
  });
});

describe('jefes seguidos', () => {
  test('mergeBossMoments y bossInBatch (puros)', () => {
    const m = narrative.mergeBossMoments({ kind: 'boss', n: 1 }, { kind: 'boss', n: 2 }, 4);
    assert.equal(m.n, 3);
    assert.match(m.description, /3 jefes seguidos.*4 en este stream/);
    assert.equal(narrative.bossInBatch(1000, 1000 + 119000), true);
    assert.equal(narrative.bossInBatch(1000, 1000 + 121000), false);
    assert.equal(narrative.bossInBatch(0, 5000), false);
  });
  test('classifyCohostMoment lleva las unidades del jefe', () => {
    const e = { type: 'boss', description: 'Jefes', ts: Date.now(), n: 3 };
    assert.deepEqual(narrative.classifyCohostMoment(e, { events: [e] }), { kind: 'boss', description: 'Jefes', n: 3 });
  });
  test('tres !boss en pocos segundos → un solo comentario del cohost para todos', async () => {
    stubModels(() => text(JSON.stringify({ candidatos: ['Tres jefes del tirón y el FUA aún pide más.', 'Racha de jefes a lo grande, Manu en estado de gracia.', 'El FUA se pone el casco para el siguiente jefe.'] })));
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) ai.enqueueCohostMoment(client, '#parlusorum', { kind: 'boss', description: `Jefe derrotado (#${i + 1} de este stream)`, n: 1 }, t0 + i);
    await sleep(900);
    const cohostPrompts = prompts.filter(m => /<suceso>/.test(m[1].content));
    assert.equal(cohostPrompts.length, 1, 'un solo comentario');
    assert.match(cohostPrompts[0][1].content, /<suceso>Han caído 3 jefes seguidos/);
    assert.equal(said.length, 1);
  });
});

describe('timer IA: resumen de la última media hora', () => {
  const timers = require('../src/timers/handler');
  const cfg = { timers: [{ message: 'fijo', interval: 999 }] };
  test('sin sucesos no se envía; con sucesos cuenta la última media hora y no repite al cohost', async () => {
    state.resetStreamNarrative();
    let calls = 0;
    stubModels(() => { calls++; return text('En la última media hora Manu cayó dos veces y se llevó un jefe por delante, y el FUA hoy trabaja de sobra.'); });
    timers.start(client, cfg);
    try {
      await sleep(250);
      assert.equal(calls, 0, 'nada relevante: no se llama a la IA');
      assert.equal(said.length, 0);
      state.addNarrativeEvent('death', 'Manu ha muerto', 2);
      state.addNarrativeEvent('boss', 'Jefe derrotado (#1 de este stream)');
      await sleep(400);
    } finally { timers.stop(); }
    const timerPrompts = prompts.filter(m => /<tarea>Cuenta la última media hora/.test(m[0].content));
    assert.ok(timerPrompts.length >= 1, 'se pidió el resumen');
    assert.match(timerPrompts[0][1].content, /<resumen>Última media hora: 2 caídas del streamer; 1 jefe superado\./);
    assert.doesNotMatch(timerPrompts[0][0].content, /YA DIJISTE|TUS RESPUESTAS/);
    assert.ok(said.some(m => /última media hora/.test(m)), 'se envió el resumen');
  });
});
