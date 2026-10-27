const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { classifyGameMatch } = require('../src/utils/game-match');

describe('classifyGameMatch', () => {
  test('juego inexistente: caso real Fuaventura Legends 3', () => {
    assert.equal(classifyGameMatch('Fuaventura Legends 3', 'Eventide 3: Legacy of Legends'), 'none');
  });
  test('nombres reales escritos distinto', () => {
    assert.equal(classifyGameMatch('elden ring', 'Elden Ring'), 'match');
    assert.equal(classifyGameMatch('Hollow knight', 'Hollow Knight'), 'match');
    assert.equal(classifyGameMatch('clair obscur', 'Clair Obscur: Expedition 33'), 'match');
    assert.equal(classifyGameMatch('hollow knigth', 'Hollow Knight'), 'match');
    assert.equal(classifyGameMatch('zelda', 'The Legend of Zelda: Tears of the Kingdom'), 'match');
  });
  test('abreviaturas habituales', () => {
    assert.equal(classifyGameMatch('gta 5', 'Grand Theft Auto V'), 'match');
    assert.equal(classifyGameMatch('bg3', "Baldur's Gate 3"), 'match');
    assert.equal(classifyGameMatch('rdr2', 'Red Dead Redemption 2'), 'match');
    assert.equal(classifyGameMatch('dark souls III', 'Dark Souls 3'), 'match');
  });
  test('número distinto o palabras a medias → quizá', () => {
    assert.equal(classifyGameMatch('Dark Souls 4', 'Dark Souls'), 'maybe');
    assert.equal(classifyGameMatch('Super Mario Odyssey Deluxe', 'Super Mario Odyssey'), 'maybe');
    assert.equal(classifyGameMatch('Super Mario Kart Deluxe', 'Super Mario Odyssey'), 'none');
  });
  test('entradas vacías', () => {
    assert.equal(classifyGameMatch('', 'Elden Ring'), 'none');
    assert.equal(classifyGameMatch('Elden Ring', ''), 'none');
  });
});
