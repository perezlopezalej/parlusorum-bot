process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const quality = require('../src/ai/quality');
const factcheck = require('../src/ai/factcheck');
const state = require('../src/utils/state');
const { runWithFallback } = require('../src/utils/groq-utils');
const { formatCohostStats } = require('../src/eventsub');

describe('mentionsGame', () => {
  test('mecánicas y datos del juego cuentan', () => {
    assert.equal(quality.mentionsGame('ese jefe tiene fase 2 y un combo brutal', 'Elden Ring'), true);
    assert.equal(quality.mentionsGame('la dificultad es una locura', ''), true);
    assert.equal(quality.mentionsGame('el DLC sale pronto', ''), true);
  });
  test('el nombre del juego cuenta (completo o con dos palabras distintivas)', () => {
    assert.equal(quality.mentionsGame('menudo viaje en Phantom Blade Zero', 'Phantom Blade Zero'), true);
    assert.equal(quality.mentionsGame('esa phantom blade se nota', 'Phantom Blade Zero'), true);
    assert.equal(quality.mentionsGame('Qué pasada de Zero', 'Phantom Blade Zero'), false);
  });
  test('hechos del stream y FUA no cuentan (jefe derrotado incluido)', () => {
    assert.equal(quality.mentionsGame('¡Otro boss al saco, el FUA no perdona!', 'Phantom Blade Zero'), false);
    assert.equal(quality.mentionsGame('Van 7 muertes y el chat sigue en pie', 'Phantom Blade Zero'), false);
  });
});

describe('factcheck selectivo', () => {
  test('un mensaje que no habla del juego se envía sin comprobar (sin llamar a Groq)', async () => {
    assert.equal(await factcheck.shouldDiscard('El FUA no perdona, 7 muertes ya.', 'Juego: Phantom Blade Zero. Muertes anotadas: 7.'), false);
  });
  test('gameFromData extrae el juego de los datos', () => {
    assert.equal(factcheck.gameFromData('Juego: Phantom Blade Zero. Muertes anotadas: 7.'), 'Phantom Blade Zero');
    assert.equal(factcheck.gameFromData('nada'), '');
  });
});

describe('validateCohost: leve vs grave', () => {
  const base = { deathCount: 3, recent: [], named: new Map(), now: Date.now() };
  test('lo grave no lleva soft', () => {
    for (const [text, rule] of [['Qué onda, chat, vamos con todo ahora', 'latam'], ['Este arma es la mejor del juego', 'juego'], ['Lo siento, no puedo ayudar con eso', 'robot']]) {
      const r = quality.validateCohost(text, base);
      assert.equal(r.ok, false);
      assert.equal(r.soft, undefined, text);
      assert.equal(r.rule, rule);
    }
    const d = quality.validateCohost('Ya van 12 muertes, qué barbaridad', base);
    assert.equal(d.rule, 'muertes');
    assert.equal(d.soft, undefined);
  });
  test('lo leve es soft: nombre repetido, fórmula repetida, parecido y juzgar el ambiente', () => {
    const named = new Map([['harocho', Date.now()]]);
    assert.deepEqual(pick(quality.validateCohost('Mira harocho con su flow gigante hoy', { ...base, named })), { soft: true, rule: 'nombre' });
    assert.deepEqual(pick(quality.validateCohost('La próxima caída ya se huele en el aire', { ...base, recent: ['Anda que la próxima caída viene fuerte'] })), { soft: true, rule: 'formula' });
    assert.deepEqual(pick(quality.validateCohost('Este chat está muy dormido hoy, qué calma', base)), { soft: true, rule: 'ambiente' });
  });
  test('un mensaje correcto sigue pasando', () => {
    assert.equal(quality.validateCohost('Tres muertes y el FUA ni se despeina, qué máquina.', base).ok, true);
  });
});
const pick = r => ({ soft: r.soft, rule: r.rule });

describe('contadores del cohost', () => {
  test('intentos, envíos, descartes y 429 de Groq quedan registrados aparte', () => {
    state.resetCohostStats();
    state.recordCohostAttempt('event'); state.recordCohostAttempt('event'); state.recordCohostAttempt('free');
    state.recordCohostSent('event');
    state.recordCohostDiscard('caducado'); state.recordCohostDiscard('skip');
    state.recordGroq429();
    const s = state.getCohostStats();
    assert.deepEqual(s.attempts, { event: 2, free: 1 });
    assert.deepEqual(s.sent, { event: 1, free: 0 });
    assert.deepEqual(s.discards, { caducado: 1, skip: 1 });
    assert.equal(s.groq429, 1);
    const line = formatCohostStats(s);
    assert.match(line, /3 comentarios intentados \(2 eventos, 1 libres\), 1 enviados/);
    assert.match(line, /caducado: 1, skip: 1/);
    assert.match(line, /429 de Groq: 1/);
    state.resetCohostStats();
    assert.equal(state.getCohostStats().groq429, 0);
  });

  test('un 429 de Groq se cuenta como tal (y no como fallo del modelo)', async () => {
    state.resetCohostStats();
    const err = Object.assign(new Error('rate limited'), { status: 429, headers: { 'retry-after': '0' } });
    let calls = 0;
    await assert.rejects(runWithFallback(async () => { calls++; throw err; }, { model: 'x' }, 0, []));
    assert.equal(calls, 1);
    assert.equal(state.getCohostStats().groq429, 1);
    state.resetCohostStats();
  });
});
