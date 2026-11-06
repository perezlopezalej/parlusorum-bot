process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.CLIENT_ID = 'cid';
process.env.CLIENT_SECRET = 'secret';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/ai/quality');
const { lookupGameInfo } = require('../src/twitch/api');

const NO_DATA = 'SIN DATOS: no hay información de "Phantom Blade Zero".';
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

describe('inventedCompany (sin datos de IGDB)', () => {
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

describe('lookupGameInfo (solo IGDB)', () => {
  const unique = () => `Juego Test ${Math.random().toString(36).slice(2)}`;
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  const http = status => ({ ok: false, status, json: async () => { throw new Error('html'); } });
  // igdb: respuesta o Error (fallo de red)
  function mockFetch({ igdb }) {
    global.fetch = async url => {
      const u = String(url);
      if (u.includes('id.twitch.tv')) return ok({ access_token: 'tok', expires_in: 5000000 });
      if (igdb instanceof Error) throw igdb;
      return igdb;
    };
  }
  const igdbGame = name => ({ name, genres: [{ name: 'Adventure' }], first_release_date: 1756944000 });

  test('IGDB encuentra: devuelve la ficha y marca la fuente', async () => {
    const name = unique();
    mockFetch({ igdb: ok([igdbGame(name)]) });
    const { info, error } = await lookupGameInfo(name);
    assert.equal(error, false);
    assert.equal(info.source, 'igdb');
    assert.equal(info.released, '2025-09-04');
  });
  test('IGDB sin el juego → no encontrado, sin error', async () => {
    mockFetch({ igdb: ok([]) });
    assert.deepEqual(await lookupGameInfo(unique()), { info: null, error: false });
  });
  test('IGDB caído (5xx) → error', async () => {
    mockFetch({ igdb: http(500) });
    assert.deepEqual(await lookupGameInfo(unique()), { info: null, error: true });
  });
  test('timeout / fallo de red → error', async () => {
    mockFetch({ igdb: new Error('aborted due to timeout') });
    assert.deepEqual(await lookupGameInfo(unique()), { info: null, error: true });
  });
  test('si IGDB falla después de un acierto sirve la caché', async () => {
    const name = unique();
    mockFetch({ igdb: ok([igdbGame(name)]) });
    assert.equal((await lookupGameInfo(name)).info.name, name);
    mockFetch({ igdb: new Error('boom') });
    assert.equal((await lookupGameInfo(name)).info.name, name);
  });
});
