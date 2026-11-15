// 14-11: «!dios_fua que me puedes decir de este titulo ?» respondió «No sé a qué título te refieres». «Este título/juego» sin
// nombre es el del directo. 15-11: «de qué va, cuál es el lore» salió con la plantilla de datos; ahora, el resumen en español.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../src/ai/quality');
const { buildPremiseReply } = require('../src/ai/game-template');

describe('refersToCurrentGame', () => {
  test('«este título / este juego» pidiendo información', () => {
    for (const q of [
      'que me puedes decir de este titulo ?',
      '¿Qué me puedes decir de este juego?',
      'háblame del juego',
      'de qué va este juego',
      'cuéntame algo de este título',
      'qué opinas de este juego?',
    ])
      assert.ok(quality.refersToCurrentGame(q), q);
  });
  test('sin petición de información o sin referencia no cuenta', () => {
    for (const q of ['este juego está difícil', 'qué tal el chat?', 'cuántas muertes llevamos', 'cuéntame un chiste'])
      assert.ok(!quality.refersToCurrentGame(q), q);
  });
});

describe('asksPremise y buildPremiseReply', () => {
  test('de qué va, lore, historia, trama', () => {
    for (const q of [
      'de que va horizon forbidden west, cual es el lore?',
      'de qué trata este juego',
      'cuál es la historia?',
    ])
      assert.ok(quality.asksPremise(q), q);
    for (const q of ['quién desarrolló Hades', 'cuándo sale Hades 2', 'de qué género es'])
      assert.ok(!quality.asksPremise(q), q);
  });
  test('el resumen con el título, y vacío sin resumen (entonces vale la plantilla)', () => {
    const info = { name: 'Horizon Forbidden West' };
    assert.equal(
      buildPremiseReply(info, 'Aloy viaja al oeste para detener una plaga que  acaba con la vida.'),
      'Horizon Forbidden West: Aloy viaja al oeste para detener una plaga que acaba con la vida.',
    );
    assert.equal(buildPremiseReply(info, ''), '');
    assert.equal(buildPremiseReply(null, 'algo'), '');
  });
});

test('buildPremiseReply no repite el título si el resumen ya empieza por él', () => {
  const info = { name: 'Silent Hill f' };
  assert.equal(
    buildPremiseReply(info, 'Silent Hill f es un survival horror ambientado en el Japón rural.'),
    'Silent Hill f es un survival horror ambientado en el Japón rural.',
  );
  assert.equal(buildPremiseReply(info, 'silent hill F  es un survival.'), 'silent hill F es un survival.');
  assert.equal(
    buildPremiseReply(info, 'Un survival horror en el Japón rural.'),
    'Silent Hill f: Un survival horror en el Japón rural.',
  );
});
