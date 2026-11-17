// 16-11: a «¿qué opinas de cómo está jugando hoy Manu?» el bot dijo «una caída y sigue a tope» con 8 caídas anotadas.
// Las menciones reciben los hechos del directo y no pueden citar una cifra de caídas distinta de la del contador.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../src/ai/quality');
const memory = require('../src/memory/handler');
const api = require('../src/twitch/api');
const state = require('../src/utils/state');

memory.getMemoryContext = async () => '';
api.getCurrentGame = async () => ({ game: 'Horizon Forbidden West' });
const { buildContextText } = require('../src/ai/prompt-context');

const MENTION_REAL =
  '@stewar32 Manu lleva la cabeza bien alta, una caída y sigue a tope, ¡el FUA no se rinde! parlus1PORELPODERDELFUAAAAA';
const TIMER_REAL =
  'Media hora de Horizon Forbidden West con una caída de Manu, pero el FUA sigue firme y el chat lo tiene bien sujeto.';
const QUESTION = '¿qué opinas de cómo está jugando hoy Manu?';

describe('citesWrongDeathCount', () => {
  test('cifras con palabras distintas del contador', () => {
    assert.equal(quality.citesWrongDeathCount(MENTION_REAL, 8), true);
    assert.equal(quality.citesWrongDeathCount('Ya van dos caídas, Manu.', 8), true);
    assert.equal(quality.citesWrongDeathCount('Un par de caídas y seguimos.', 8), true);
    assert.equal(quality.citesWrongDeathCount('Treinta y una muertes, qué barbaridad.', 8), true);
  });

  test('cifras con dígitos distintas del contador', () => {
    assert.equal(quality.citesWrongDeathCount('Lleva 3 caídas hoy.', 8), true);
    assert.equal(quality.citesWrongDeathCount('Lleva 8 caídas hoy.', 8), false);
  });

  test('la cifra correcta, con palabras o dígitos, pasa', () => {
    assert.equal(quality.citesWrongDeathCount('Lleva ocho caídas, Manu.', 8), false);
    assert.equal(quality.citesWrongDeathCount('Con una caída y sigue.', 1), false);
    assert.equal(quality.citesWrongDeathCount('Dos caídas ya, Manu.', 2), false);
  });

  test('lo que no es una cuenta no cuenta: «una caída más», «otra caída», sin cifra', () => {
    assert.equal(quality.citesWrongDeathCount('Otra caída más y Manu sigue.', 8), false);
    assert.equal(quality.citesWrongDeathCount('Una caída más, qué constancia.', 8), false);
    assert.equal(quality.citesWrongDeathCount('Manu cae y se levanta, esa es la gracia.', 8), false);
    assert.equal(quality.citesWrongDeathCount('Qué ánimo tiene Manu hoy.', 8), false);
  });

  test('las cifras que escribió quien pregunta se aceptan', () => {
    assert.equal(quality.citesWrongDeathCount('Eso de 5 caídas es mucho.', 8, [5]), false);
  });
});

describe('mentionsUnrecordedDeaths entiende las cifras con palabras (cohost, hook y timer)', () => {
  test('el resumen de media hora compara con las caídas de la ventana además de con el total', () => {
    // 16-11, 20:14: 8 en total, 1 en la última media hora → «una caída» es correcto
    assert.equal(quality.mentionsUnrecordedDeaths(TIMER_REAL, 8, [1, 0], { strictSingular: true }), false);
    // sin ninguna caída en la ventana (ni cifra que case) se rechaza
    assert.equal(quality.mentionsUnrecordedDeaths(TIMER_REAL, 8, [0, 0], { strictSingular: true }), true);
    assert.equal(quality.mentionsUnrecordedDeaths(TIMER_REAL, 1), false);
    assert.equal(quality.mentionsUnrecordedDeaths('Una sola caída en toda la tarde.', 1), false);
  });
});

describe('validateMention con el contador', () => {
  test('el timer real del 16-11 (una caída en la última media hora, 8 en total) pasa y sin caída en la ventana se rechaza', () => {
    const ctx = { deathCount: 8, currentGame: 'Horizon Forbidden West' };
    assert.equal(quality.validateTimerIA(TIMER_REAL, { ...ctx, extraDeathNumbers: [1, 0] }).ok, true);
    assert.equal(quality.validateTimerIA(TIMER_REAL, { ...ctx, extraDeathNumbers: [0, 0] }).ok, false);
  });

  test('la mención real del 16-11 se rechaza con 8 caídas y pasa con 1', () => {
    const bad = quality.validateMention(MENTION_REAL, { question: QUESTION, deathCount: 8 });
    assert.equal(bad.ok, false);
    assert.equal(bad.rule, 'cifra_caidas');
    assert.equal(quality.validateMention(MENTION_REAL, { question: QUESTION, deathCount: 1 }).ok, true);
  });

  test('sin contador no se comprueba (otros llamadores) y una respuesta sin cifras pasa', () => {
    assert.equal(quality.validateMention(MENTION_REAL, { question: QUESTION }).ok, true);
    const ok = quality.validateMention('@stewar32 Manu juega con garra, aunque el suelo lo quiere mucho.', {
      question: QUESTION,
      deathCount: 8,
    });
    assert.equal(ok.ok, true);
  });

  test('la cifra correcta pasa', () => {
    const r = quality.validateMention('@stewar32 Ocho caídas y Manu sigue con la sonrisa puesta.', {
      question: QUESTION,
      deathCount: 8,
    });
    assert.equal(r.ok, true);
  });
});

describe('contexto de las menciones con los hechos del directo', () => {
  test('lleva caídas, jefes y tiempo con su cifra exacta y la instrucción de no inventar cifras', async () => {
    state.setDeathCount(8);
    state.setBossCount(2);
    state.setStreamIsLive(true);
    state.setStreamStartedAt(Date.now() - 95 * 60000);
    const text = await buildContextText({ question: QUESTION });
    assert.match(text, /Se está jugando a «Horizon Forbidden West»/);
    assert.match(text, /Caídas anotadas hoy del streamer: 8 \(cifra exacta\)/);
    assert.match(text, /Jefes derrotados hoy: 2\./);
    assert.match(text, /Llevan una hora y media de directo\./);
    assert.match(text, /usa solo las de estos hechos/);
  });

  test('sin caídas ni jefes lo dice', async () => {
    state.setDeathCount(0);
    state.setBossCount(0);
    state.setStreamIsLive(false);
    const text = await buildContextText({ question: QUESTION });
    assert.match(text, /Aún sin caídas anotadas hoy\./);
    assert.match(text, /Aún sin jefes derrotados hoy\./);
    assert.doesNotMatch(text, /de directo\./);
  });
});

describe('cifras con palabras que no son la cuenta de hoy', () => {
  test('negaciones y apuestas no cuentan', () => {
    assert.equal(
      quality.citesWrongDeathCount('Media hora tranquila, sin una sola caída, y el FUA sospecha.', 3),
      false,
    );
    assert.equal(quality.citesWrongDeathCount('Apuesto por veinte caídas y el FUA por más.', 0), false);
    assert.equal(quality.citesWrongDeathCount('Ni una caída en una hora, Manu.', 5), false);
    assert.equal(
      quality.mentionsUnrecordedDeaths('Media hora tranquila, sin una sola caída, y el FUA sospecha.', 3),
      false,
    );
  });
});
