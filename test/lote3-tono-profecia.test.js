process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/ai/quality');
const { predictFromRows, refersToNextStream } = require('../src/ai/prophecy');
const { isRepeatedEvent } = require('../src/eventsub');
const channel = require('../config/channel.json');
const lore = require('../config/lore.json');

// Mensajes reales del directo del 29-10-2026 (logs/chat-2026-10-29.txt)
const REAL = {
  tia: '@ParLusorum ¡Gracias, tía! Soy la máquina de FUA, listo para sacarle brillo a cada momento de juego.',
  pocaAccion: 'Un stream caótico y prolongado con mucho chat y poca acción.',
  proximo: '🔮 ¡Atención, comunidad! El oráculo del FUA predice que en el próximo stream el héroe caerá 1 vez, justo cuando la sombra del Blade se alinee con la luna—¡prepárense para el revés! parlus1Esteeselrollo',
};

describe('ParLusorum sin género', () => {
  test('rechaza "tía" dirigido a @ParLusorum', () => {
    assert.equal(q.genderedParlusorum(REAL.tia), true);
    assert.equal(q.validateMention(REAL.tia).ok, false);
  });
  test('"tía" hablando de otra cosa o de otro usuario sigue valiendo', () => {
    assert.equal(q.validateMention('@gangar79 Esa tía te mató 9 veces, FUA').ok, true);
    assert.equal(q.validateMention('@ParLusorum ¡Gracias! El FUA os acompaña').ok, true);
  });
  test('la personalidad y el lore no dan género ni la creación del canal a vlxj97', () => {
    assert.match(channel.bot_personality, /creador del BOT, no del canal/);
    assert.doesNotMatch(channel.bot_personality, /amo creador|distinto de tu creador/);
    assert.match(lore.identity, /creador del bot \(no del canal\)/);
    assert.match(lore.identity, /nunca se le pone género/);
  });
});

describe('resumen de fin de stream en positivo', () => {
  test('descarta "poca acción" y similares', () => {
    assert.equal(q.negativeSummary(REAL.pocaAccion), true);
    assert.equal(q.negativeSummary('Stream aburrido y flojo'), true);
    assert.equal(q.negativeSummary('Stream épico con 12 muertes y el jefe por fin caído'), false);
  });
  test('el resumen de reserva usa los datos reales y es positivo', () => {
    const s = q.positiveSummaryFallback({ game: 'Blade', durationMinutes: 150, deathCount: 12 });
    assert.match(s, /12 muertes/);
    assert.match(s, /Blade/);
    assert.match(s, /150 minutos con 12 muertes/);
    assert.equal(q.negativeSummary(s), false);
    assert.equal(q.negativeSummary(q.positiveSummaryFallback({ durationMinutes: 20, deathCount: 0 })), false);
  });
});

describe('profecía', () => {
  const rows = [
    { game: 'Blade', death_count: 0 },
    { game: 'Elden Ring', death_count: 10 },
    { game: 'Blade', death_count: 0 },
    { game: 'Hollow Knight', death_count: 6 },
  ];
  test('ignora las sesiones con 0 muertes', () => {
    assert.deepEqual(predictFromRows(rows, 'Blade').history, [10, 6]);
  });
  test('sin historial del mismo juego usa la media de todas con muertes', () => {
    const p = predictFromRows(rows, 'Blade');
    assert.equal(p.deaths, 8);
    assert.match(p.basis, /otros juegos/);
  });
  test('con historial del mismo juego usa solo ese', () => {
    const p = predictFromRows([...rows, { game: 'Blade', death_count: 4 }], 'Blade');
    assert.equal(p.deaths, 4);
  });
  test('todo a 0 o sin filas: sin predicción', () => {
    assert.equal(predictFromRows([{ game: 'Blade', death_count: 0 }], 'Blade'), null);
    assert.equal(predictFromRows([], 'Blade'), null);
  });
  test('rechaza "el próximo stream", acepta "hoy"', () => {
    assert.equal(refersToNextStream(REAL.proximo), true);
    assert.equal(refersToNextStream('Hoy el héroe caerá 6 veces, el FUA lo ha dicho'), false);
  });
});

describe('dedupe de encuestas y predicciones por tipo + id', () => {
  test('el mismo evento con otro Message-Id se ignora; otro tipo o id no', () => {
    const seen = new Map();
    assert.equal(isRepeatedEvent(seen, 'channel.poll.begin', 'abc'), false);
    assert.equal(isRepeatedEvent(seen, 'channel.poll.begin', 'abc'), true);
    assert.equal(isRepeatedEvent(seen, 'channel.poll.end', 'abc'), false);
    assert.equal(isRepeatedEvent(seen, 'channel.prediction.begin', 'abc'), false);
    assert.equal(isRepeatedEvent(seen, 'channel.prediction.begin', 'xyz'), false);
  });
  test('otros tipos (follow, stream) no se deduplican por id', () => {
    const seen = new Map();
    assert.equal(isRepeatedEvent(seen, 'channel.follow', 'a'), false);
    assert.equal(isRepeatedEvent(seen, 'channel.follow', 'a'), false);
    assert.equal(isRepeatedEvent(seen, 'channel.poll.begin', undefined), false);
  });
});
