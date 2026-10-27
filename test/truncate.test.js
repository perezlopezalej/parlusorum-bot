process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { truncate, TWITCH_MAX_LENGTH } = require('../src/utils/groq-utils');
const { channel_emotes: emotes } = require('../config/channel.json');

describe('truncate', () => {
  test('vacío o nulo devuelve cadena vacía', () => {
    assert.equal(truncate(''), '');
    assert.equal(truncate(null), '');
    assert.equal(truncate(undefined), '');
  });

  test('quita asteriscos markdown y espacios repetidos', () => {
    assert.equal(truncate('  **hola**   mundo  '), 'hola mundo');
  });

  test('respeta el límite y añade "..."', () => {
    const out = truncate('a'.repeat(1000));
    assert.equal(out.length, TWITCH_MAX_LENGTH);
    assert.ok(out.endsWith('...'));
  });

  test('no toca textos dentro del límite', () => {
    const text = 'b'.repeat(TWITCH_MAX_LENGTH);
    assert.equal(truncate(text), text);
  });

  test('acepta un límite personalizado', () => {
    assert.equal(truncate('abcdefghij', 8), 'abcde...');
    assert.equal(truncate('abcdefghij', 10), 'abcdefghij');
  });

  test('separa los emotes del canal de la puntuación adyacente', () => {
    const e = emotes[0];
    assert.equal(truncate(`hola${e}`), `hola ${e}`);
    assert.equal(truncate(`${e}!`), `${e} !`);
  });
});
