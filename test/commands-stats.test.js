const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseMuertesArgs, sumGameDeaths, formatSince, findUserByName, MAX_DEATHS_ADD } = require('../src/commands/stats');

const A = (...a) => ['muertes', ...a];

describe('parseMuertesArgs', () => {
  test('sin argumentos muestra el contador', () => {
    assert.deepEqual(parseMuertesArgs(A()), { type: 'show' });
  });
  test('+N dentro del máximo suma N', () => {
    assert.deepEqual(parseMuertesArgs(A('+1')), { type: 'add', n: 1 });
    assert.deepEqual(parseMuertesArgs(A('+5')), { type: 'add', n: 5 });
    assert.deepEqual(parseMuertesArgs(A(`+${MAX_DEATHS_ADD}`)), { type: 'add', n: MAX_DEATHS_ADD });
  });
  test('+0, por encima del máximo o mal formado explica el formato', () => {
    for (const bad of ['+0', `+${MAX_DEATHS_ADD + 1}`, '-2', '5', '+', '+x']) {
      assert.equal(parseMuertesArgs(A(bad)).type, 'bad_format', bad);
    }
    assert.equal(parseMuertesArgs(A('+', '5')).type, 'bad_format');
  });
  test('reset y consulta por juego', () => {
    assert.deepEqual(parseMuertesArgs(A('reset')), { type: 'reset' });
    assert.deepEqual(parseMuertesArgs(A('Dark', 'Souls', '3')), { type: 'game', game: 'Dark Souls 3' });
  });
});

describe('sumGameDeaths', () => {
  const rows = [
    { id: 1, game: 'Elden Ring', death_count: 10 },
    { id: 2, game: 'Elden Ring', death_count: 4 },
    { id: 3, game: 'Dark Souls III', death_count: 7 },
    { id: 4, game: 'Hades', death_count: 0 },
  ];
  test('suma las sesiones del juego', () => {
    const r = sumGameDeaths('elden ring', rows);
    assert.equal(r.total, 14);
    assert.equal(r.streams, 2);
    assert.equal(r.game, 'Elden Ring');
  });
  test('la secuela solo cuenta si se pide el número, y no con otro', () => {
    assert.equal(sumGameDeaths('dark souls 2', rows).total, 0);
    assert.equal(sumGameDeaths('dark souls 3', rows).total, 7);
  });
  test('la sesión en directo usa el contador vivo', () => {
    const r = sumGameDeaths('elden ring', rows, { id: 2, deaths: 9 });
    assert.equal(r.total, 19);
  });
  test('sin datos devuelve 0', () => {
    assert.equal(sumGameDeaths('zelda', rows).total, 0);
    assert.equal(sumGameDeaths('zelda', null).total, 0);
  });
});

describe('formatSince', () => {
  const now = Date.UTC(2026, 9, 29);
  const ago = ms => formatSince(now - ms, now);
  const MIN = 60000, DAY = 24 * 60 * MIN;
  test('unidades y plurales', () => {
    assert.equal(ago(1 * MIN), '1 minuto');
    assert.equal(ago(5 * 60 * MIN), '5 horas');
    assert.equal(ago(1 * DAY), '1 día');
    assert.equal(ago(45 * DAY), '1 mes y 15 días');
    assert.equal(ago(400 * DAY), '1 año y 1 mes');
  });
  test('fechas futuras no dan negativos', () => {
    assert.equal(formatSince(now + DAY, now), '0 minutos');
  });
});

describe('findUserByName', () => {
  const users = { 1: { username: 'Gangar79', firstSeen: 'x' }, 2: { username: 'vlxj97' } };
  test('ignora @ y mayúsculas', () => {
    assert.equal(findUserByName(users, '@gangar79').firstSeen, 'x');
  });
  test('desconocido o vacío → null', () => {
    assert.equal(findUserByName(users, 'nadie'), null);
    assert.equal(findUserByName(users, ''), null);
  });
});
