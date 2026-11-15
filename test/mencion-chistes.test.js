// 15-11: stewar32 contó «van dos en una moto y se cae el de en medio» y el bot lo tomó en serio. Un chiste o una broma
// absurda se reconoce por sus moldes y el prompt pide reírse o seguirla.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../src/ai/quality');
const { buildToneText } = require('../src/ai/prompt-context');
const { loadExamples } = require('../src/ai/style');

describe('looksLikeJoke', () => {
  test('chistes y bromas absurdas', () => {
    for (const t of [
      'Si dios fua que no la piyas van dos en una moto y se cae el de enmedio',
      '@dios_fua van dos en una moto y se cae el de en medio',
      'dios fua qué le dice un jaguar a otro jaguar?',
      'dios fua esto son dos que van por el desierto y uno le dice al otro: sígueme',
      'dios_fua sabes cuál es el colmo de un electricista?',
      'dios fua toc toc',
      'Dios Fua te cuento un chiste: entra un hombre a un bar y dice...',
    ])
      assert.ok(quality.looksLikeJoke(t), t);
  });
  test('mensajes normales no son chistes', () => {
    for (const t of [
      'dios fua cuántas muertes llevamos?',
      '@dios_fua En los dos',
      'dios fua van dos horas de directo ya',
      'dios fua qué juego es este?',
      'hay dos jefes en este nivel, dios fua?',
      'van dos muertes y el chat sigue animando',
    ])
      assert.ok(!quality.looksLikeJoke(t), t);
  });
});

describe('tono de la mención con un chiste', () => {
  test('el prompt pide reírse o seguir la broma solo si es un chiste', () => {
    assert.match(buildToneText('van dos en una moto y se cae el de en medio'), /chiste|broma/);
    assert.doesNotMatch(buildToneText('cuántas muertes llevamos?'), /chiste|broma/);
  });
  test('los ejemplos de menciones incluyen chistes seguidos con gracia', () => {
    const jokes = loadExamples().mencion.filter((e) => quality.looksLikeJoke(e.contexto));
    assert.ok(jokes.length >= 3);
    for (const e of jokes) assert.ok(/jaja|rei|risa|chiste|sab[ií]a/i.test(e.texto), e.texto);
  });
});
