process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isNoiseTerm, isPersonTerm, matchesGameName, buildPeopleWords } = require('../src/lore/handler');

describe('isNoiseTerm', () => {
  test('risas y onomatopeyas', () => {
    for (const t of ['Jajajaja', 'jajaja jajaja', 'jsjsjs', 'XD', 'LUL', 'yiyiyiyiyi', 'Wauuuuu', 'Vamooooo', 'jeje', 'ajaj']) {
      assert.equal(isNoiseTerm(t), true, t);
    }
  });
  test('lore real no se filtra', () => {
    for (const t of ['dios fua', 'reina del fua', 'canalla', 'el rollo', 'tus muertos']) {
      assert.equal(isNoiseTerm(t), false, t);
    }
  });
});

describe('matchesGameName', () => {
  test('nombre de juego con errata o mayúsculas', () => {
    assert.equal(matchesGameName('hell is us', ['Hell Is Us']), true);
    assert.equal(matchesGameName('phanton', ['Phantom Blade Zero']), true);
  });
  test('no confunde una palabra suelta con un título largo', () => {
    assert.equal(matchesGameName('dios', ['Dios del Fuego y la Ceniza Remastered']), false);
    assert.equal(matchesGameName('canalla', ['Final Fantasy XVI']), false);
  });
});

describe('isPersonTerm / people', () => {
  test('usuarios del chat', () => {
    assert.equal(isPersonTerm('gangar79', new Set(['gangar79']), new Set()), true);
    assert.equal(isPersonTerm('la reina', new Set(['gangar79']), new Set()), false);
  });
  test('mapa people: nombres propios y usuario asociado', () => {
    const words = buildPeopleWords({ pao: 'ParLusorum' });
    assert.equal(isPersonTerm('pao', new Set(), words), true);
    assert.equal(isPersonTerm('castigado pao', new Set(), words), true);
  });
  test('las entradas EJEMPLO se ignoran', () => {
    const words = buildPeopleWords({ 'EJEMPLO: pao': 'parlusorum' });
    assert.equal(words.size, 0);
  });
});
