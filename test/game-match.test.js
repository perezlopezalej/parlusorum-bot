const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { classifyGameMatch, nameSimilarity } = require('../src/utils/game-match');

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

describe('classifyGameMatch: títulos parecidos y números', () => {
  test('caso real Hell is Us: "Hell-Hell" es otro juego', () => {
    assert.equal(classifyGameMatch('Hell is Us', 'Hell-Hell'), 'none');
    assert.equal(classifyGameMatch('Hell ... ...', 'Hell-Hell'), 'maybe');
    assert.equal(classifyGameMatch('Hell', 'Hell-Hell'), 'maybe');
    assert.equal(classifyGameMatch('Hell is Us', 'Hell Is Us'), 'match');
  });
  test('caso real phantom blade 0 = Phantom Blade Zero', () => {
    assert.equal(classifyGameMatch('phantom blade 0', 'Phantom Blade Zero'), 'match');
    assert.equal(classifyGameMatch('Phantom Blade Zero', 'Phantom Blade 0'), 'match');
    assert.equal(classifyGameMatch('phantom blade 1', 'Phantom Blade Zero'), 'maybe');
  });
  test('números en cifra, romano y palabra son lo mismo', () => {
    assert.equal(classifyGameMatch('Portal two', 'Portal 2'), 'match');
    assert.equal(classifyGameMatch('Dark Souls II', 'Dark Souls 2'), 'match');
    assert.equal(classifyGameMatch('dark souls 2', 'Dark Souls II'), 'match');
    assert.equal(classifyGameMatch('Dark Souls three', 'Dark Souls III'), 'match');
  });
  test('nameSimilarity: el nombre completo gana a una palabra suelta', () => {
    assert.ok(nameSimilarity('Hell is Us', 'Hell Is Us') > nameSimilarity('Hell is Us', 'Hell-Hell'));
    assert.equal(nameSimilarity('', 'x'), 0);
  });
});

describe('recoverTruncatedName: nombre cortado por el modelo ("Hell ...")', () => {
  const { recoverTruncatedName } = require('../src/utils/game-match');
  test('caso real: "Hell ..." se recupera de la pregunta', () => {
    const r = recoverTruncatedName('Hell ... ...', 'qué opinas de Hell is Us');
    assert.deepEqual(r, { name: 'Hell is Us', truncated: false, recovered: true });
  });
  test('corta en la puntuación o en la conjunción', () => {
    assert.equal(recoverTruncatedName('Dark …', 'qué tal Dark Souls 3, es difícil?').name, 'Dark Souls 3');
    assert.equal(recoverTruncatedName('Hell ...', 'Hell is Us y Dark Souls').name, 'Hell is Us');
  });
  test('sin el principio en la pregunta: truncated y nunca "match"', () => {
    const r = recoverTruncatedName('Hell ...', 'qué opinas de ese juego');
    assert.equal(r.truncated, true);
    assert.equal(r.name, 'Hell');
  });
  test('un nombre normal no se toca', () => {
    assert.deepEqual(recoverTruncatedName('Hell is Us', 'x'), { name: 'Hell is Us', truncated: false });
  });
});
