const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildRawgTemplate } = require('../src/ai/rawg-template');

process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
const factcheck = require('../src/ai/factcheck');

const info = { name: 'Hell is Us', genres: 'Action, Adventure', developers: 'Rogue Factor', released: '2025-09-03' };
const first = a => a[0];

describe('plantilla de reserva de RAWG', () => {
  test('usa nombre, género en español, estudio y año, más la frase', () => {
    assert.equal(buildRawgTemplate(info, ['Dale FUA.'], first), 'Hell is Us: acción, aventura, de Rogue Factor (2025). Dale FUA.');
  });
  test('omite lo que RAWG no trae', () => {
    assert.equal(buildRawgTemplate({ name: 'X', released: '2020-01-01' }, ['FUA.'], first), 'X (2020). FUA.');
    assert.equal(buildRawgTemplate({ name: 'X' }, [], first), 'X.');
  });
  test('sin datos devuelve vacío y no lleva nada inventado', () => {
    assert.equal(buildRawgTemplate(null, ['FUA.'], first), '');
    assert.doesNotMatch(buildRawgTemplate(info, ['FUA.'], first), /post|acertij/i);
  });
});

describe('parseClaim', () => {
  test('extrae la frase no respaldada', () => {
    assert.equal(factcheck.parseClaim('SÍ: "ambientación post-apocalíptica"'), 'ambientación post-apocalíptica');
    assert.equal(factcheck.parseClaim('Sí - acertijos'), 'acertijos');
  });
  test('NO o sin motivo → vacío', () => {
    assert.equal(factcheck.parseClaim('NO'), '');
    assert.equal(factcheck.parseClaim('SÍ'), '');
  });
});
