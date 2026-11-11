process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/utils/bot-control');
const state = require('../src/utils/state');
const { buildSnapshot, restorableState } = require('../src/utils/bot-state');
const { wrapClientSay, _testHooks } = require('../src/utils/irc-ratelimit');

describe('parseMinutes / parseMode', () => {
  test('minutos válidos, por defecto y cancelar', () => {
    assert.equal(C.parseMinutes('15'), 15);
    assert.equal(C.parseMinutes('5min'), 5);
    assert.equal(C.parseMinutes(undefined), 10);
    assert.equal(C.parseMinutes('0'), 0);
    assert.equal(C.parseMinutes('120'), 120);
  });
  test('fuera de rango o texto: null', () => {
    for (const bad of ['121', '-3', 'mucho', '1.5', '99999']) assert.equal(C.parseMinutes(bad), null, bad);
  });
  test('modos', () => {
    assert.equal(C.parseMode('Reactivo'), 'reactivo');
    assert.equal(C.parseMode('normal'), 'normal');
    assert.equal(C.parseMode('otro'), null);
    assert.equal(C.parseMode(undefined), null);
  });
});

describe('outboundBlock', () => {
  test('silencio deja pasar solo comandos y sin origen', () => {
    assert.equal(C.outboundBlock('comando', { silenced: true }), null);
    assert.equal(C.outboundBlock(undefined, { silenced: true }), null);
    for (const o of ['cohost', 'hook', 'timer', 'mencion', 'alerta', 'highlight']) assert.equal(C.outboundBlock(o, { silenced: true }), 'silencio', o);
  });
  test('reactivo corta lo espontáneo y deja menciones, comandos y alertas', () => {
    for (const o of ['cohost', 'hook', 'timer', 'timer_ia', 'highlight', 'emote_spam', 'caps_rage']) assert.equal(C.outboundBlock(o, { reactive: true }), 'reactivo', o);
    for (const o of ['mencion', 'dios_fua', 'comando', 'alerta', 'trivia', 'chiste', 'quemeperdi']) assert.equal(C.outboundBlock(o, { reactive: true }), null, o);
  });
  test('modo normal no bloquea nada', () => {
    assert.equal(C.outboundBlock('cohost', {}), null);
  });
});

describe('estado: silencio temporal y modo', () => {
  afterEach(() => { state.setMuteUntil(0); state.setBotMode('normal'); });
  test('!fua_callate silencia hasta la hora y se levanta solo', () => {
    state.setMuteUntil(Date.now() + 60_000);
    assert.equal(state.isSilenced(), true);
    state.setMuteUntil(Date.now() - 1);
    assert.equal(state.isSilenced(), false);
    assert.equal(state.getMuteUntil(), 0);
  });
  test('modo reactivo', () => {
    state.setBotMode('reactivo');
    assert.equal(state.isReactive(), true);
    state.setBotMode('loquesea');
    assert.equal(state.isReactive(), false);
  });
});

describe('persistencia entre reinicios', () => {
  const T = 1_700_000_000_000;
  const live = { live: true, streamStartedAt: T, silenced: false, deaths: 1, bosses: 0 };
  test('silencio temporal vigente y modo se restauran; el caducado no', () => {
    const snap = buildSnapshot({ ...live, muteUntil: T + 600_000, mode: 'reactivo' }, T);
    const r = restorableState(snap, { live: true, streamStartedAt: T }, T + 1000);
    assert.equal(r.muteUntil, T + 600_000);
    assert.equal(r.mode, 'reactivo');
    const late = restorableState(snap, { live: true, streamStartedAt: T }, T + 700_000);
    assert.equal(late.muteUntil, 0);
    assert.equal(late.mode, 'reactivo');
  });
  test('un silencio ya caducado ni se guarda', () => {
    assert.equal(buildSnapshot({ ...live, muteUntil: T - 5 }, T).muteUntil, 0);
  });
});

describe('respaldo en la cola de salida', () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await wait(5); };
  beforeEach(() => { _testHooks({ gapMs: 5, sayTimeoutMs: 80, reset: true }); state.setStreamIsLive(true); state.setStreamEndGraceUntil(0); state.resetRecentUserTexts(); });
  afterEach(() => { state.setMuteUntil(0); state.setBotMode('normal'); });
  test('con !fua_callate solo salen los comandos; en reactivo se cortan cohost y timers', async () => {
    const sent = [];
    const client = { say: async (c, m) => { sent.push(m); }, readyState: () => 'OPEN' };
    wrapClientSay(client);
    state.setMuteUntil(Date.now() + 60_000);
    client.say('#c', 'comentario del cohost', { origin: 'cohost' });
    client.say('#c', 'respuesta de comando', { origin: 'comando' });
    await until(() => sent.length >= 1);
    await wait(30); // margen para que el mensaje bloqueado, de haber salido, se vea
    assert.deepEqual(sent, ['respuesta de comando']);
    state.setMuteUntil(0);
    state.setBotMode('reactivo');
    client.say('#c', 'timer fijo', { origin: 'timer' });
    client.say('#c', 'una mención', { origin: 'mencion' });
    await until(() => sent.length >= 2);
    await wait(30);
    assert.deepEqual(sent, ['respuesta de comando', 'una mención']);
  });
});
