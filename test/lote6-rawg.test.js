process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.RAWG_API_KEY = 'test-key';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/ai/quality');
const { lookupGameInfo } = require('../src/twitch/api');

const NO_DATA = 'SIN DATOS: no hay información de "Phantom Blade Zero".';
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

describe('inventedCompany (sin datos de RAWG)', () => {
  test('descarta editoras conocidas y nacionalidad de compañía', () => {
    assert.equal(q.inventedCompany('El estudio que creó Phantom Blade Zero es Sega. Es una compañía japonesa.', NO_DATA), 'sega');
    assert.equal(q.inventedCompany('Es una compañía japonesa, creo', NO_DATA), 'japonesa');
    assert.equal(q.inventedCompany('Lo ha hecho el estudio S-Game', NO_DATA), 's-game');
  });
  test('deja pasar lo que no nombra a nadie', () => {
    assert.equal(q.inventedCompany('No tengo ni idea de quién lo hizo, ¡ni el FUA!', NO_DATA), '');
    assert.equal(q.inventedCompany('Un juego de acción chulo, con mucho FUA.', NO_DATA), '');
  });
  test('si los datos lo respaldan, no lo marca', () => {
    assert.equal(q.inventedCompany('Es de Sega', 'Nombre: X\nDesarrolladora: Sega'), '');
  });
});

describe('lookupGameInfo: RAWG caído vs no encontrado', () => {
  const unique = () => `Juego Test ${Math.random().toString(36).slice(2)}`;
  test('5xx → error', async () => {
    global.fetch = async () => ({ ok: false, status: 522, json: async () => { throw new Error('html'); } });
    assert.deepEqual(await lookupGameInfo(unique()), { info: null, error: true });
  });
  test('timeout / fallo de red → error', async () => {
    global.fetch = async () => { throw new Error('The operation was aborted due to timeout'); };
    assert.deepEqual(await lookupGameInfo(unique()), { info: null, error: true });
  });
  test('sin resultados → no encontrado, sin error', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) });
    assert.deepEqual(await lookupGameInfo(unique()), { info: null, error: false });
  });
  test('si falla después de un acierto sirve la caché', async () => {
    const name = unique();
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [{ name, genres: [{ name: 'Action' }] }] }) });
    const first = await lookupGameInfo(name);
    assert.equal(first.info.name, name);
    global.fetch = async () => { throw new Error('boom'); };
    assert.equal((await lookupGameInfo(name)).info.name, name);
  });
});
