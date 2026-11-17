// 17-11: con Control (Remedy, 2019) IGDB devolvió otro juego llamado «Control». El juego actual se pide por el igdb_id
// de su categoría de Twitch; la búsqueda por nombre queda de respaldo.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.CLIENT_ID = 'cid';
process.env.CLIENT_SECRET = 'secret';
process.env.BROADCASTER_TOKEN = 'btok';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const igdb = require('../src/twitch/igdb');
const api = require('../src/twitch/api');
const { invalidateAppAccessToken } = require('../src/twitch/app-token');

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  invalidateAppAccessToken();
});

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const control = { id: 9999, name: 'Control', first_release_date: 1566432000, summary: 'Jesse Faden.' };
const otroControl = { id: 1, name: 'Control', first_release_date: 1262304000 };

describe('validIgdbId', () => {
  test('solo enteros positivos; "" y "0" (sin enlace) no valen', () => {
    assert.equal(igdb.validIgdbId('9999'), 9999);
    assert.equal(igdb.validIgdbId(12), 12);
    for (const bad of ['', '0', 0, null, undefined, 'abc', '1; drop', -3, 1.5])
      assert.equal(igdb.validIgdbId(bad), null);
  });
});

describe('searchGame con igdbId', () => {
  function mock(handler) {
    const calls = [];
    global.fetch = async (url, opts) => {
      if (String(url).includes('id.twitch.tv')) return ok({ access_token: 'tok', expires_in: 5000000 });
      calls.push(opts.body);
      return handler(calls.length, opts.body);
    };
    return calls;
  }

  test('pide ese juego por id y no busca por nombre', async () => {
    const calls = mock(() => ok([control]));
    const info = await igdb.searchGame('Control', { igdbId: '9999' });
    assert.equal(info.released, '2019-08-22');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /where id = 9999;/);
    assert.doesNotMatch(calls[0], /search/);
  });

  test('id que IGDB no tiene → respaldo por nombre', async () => {
    const calls = mock((n) => ok(n === 1 ? [] : [otroControl]));
    const info = await igdb.searchGame('Control', { igdbId: 424242 });
    assert.equal(info.name, 'Control');
    assert.match(calls[0], /where id = 424242;/);
    assert.match(calls[1], /^search "Control";/);
  });

  test('id vacío o "0" → búsqueda por nombre directa', async () => {
    const calls = mock(() => ok([otroControl]));
    await igdb.searchGame('Control', { igdbId: '' });
    await igdb.searchGame('Control', { igdbId: '0' });
    assert.equal(calls.length, 2);
    assert.ok(calls.every((b) => /^search "Control";/.test(b)));
  });

  test('si IGDB falla al pedir por id, el error se propaga (no se oculta con otro juego)', async () => {
    mock(() => ({ ok: false, status: 503, json: async () => ({}) }));
    await assert.rejects(igdb.searchGame('Control', { igdbId: 9999 }), /HTTP 503/);
  });
});

describe('lookupGameInfo del juego actual', () => {
  test('usa el igdb_id de la categoría de Twitch y lo cachea por id', async () => {
    const seen = { games: 0, igdb: [] };
    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('id.twitch.tv')) return ok({ access_token: 'tok', expires_in: 5000000 });
      if (u.includes('helix/channels')) return ok({ data: [{ game_id: '33214', game_name: 'Control', title: 't' }] });
      if (u.includes('helix/games')) {
        seen.games++;
        assert.match(u, /id=33214/);
        return ok({ data: [{ id: '33214', name: 'Control', igdb_id: '9999' }] });
      }
      seen.igdb.push(opts.body);
      return ok([control]);
    };
    const game = await api.getCurrentGame();
    assert.equal(game.game, 'Control');
    assert.equal(game.gameId, '33214');
    const { info } = await api.lookupGameInfo('Control', { detail: true });
    assert.equal(info.released, '2019-08-22');
    // la ficha precalentada (en segundo plano) y esta consulta comparten caché: una sola petición a IGDB por id
    await api.lookupGameInfo('Control', { detail: true });
    assert.ok(seen.igdb.length >= 1);
    assert.ok(seen.igdb.every((b) => /where id = 9999;/.test(b)));
    assert.equal(seen.games, 1);
  });

  test('IGDB caído al pedir por id: lookupGameInfo no lanza, devuelve error o la ficha en caché', async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('id.twitch.tv')) return ok({ access_token: 'tok', expires_in: 5000000 });
      if (u.includes('helix/channels')) return ok({ data: [{ game_id: '777', game_name: 'Juego Caido', title: 't' }] });
      if (u.includes('helix/games')) return ok({ data: [{ id: '777', igdb_id: '4242' }] });
      return { ok: false, status: 503, json: async () => ({}) };
    };
    await api.getCurrentGame();
    const r = await api.lookupGameInfo('Juego Caido', { detail: true });
    assert.deepEqual(r, { info: null, error: true });
    assert.equal(await api.getGameInfo('Juego Caido'), null);
  });

  test('un nombre que no es el juego actual se sigue buscando por nombre', async () => {
    const bodies = [];
    global.fetch = async (url, opts = {}) => {
      if (String(url).includes('id.twitch.tv')) return ok({ access_token: 'tok', expires_in: 5000000 });
      assert.doesNotMatch(String(url), /helix/);
      bodies.push(opts.body);
      return ok([{ id: 5, name: 'Hollow Knight', first_release_date: 1487894400 }]);
    };
    const { info } = await api.lookupGameInfo('Hollow Knight');
    assert.equal(info.name, 'Hollow Knight');
    assert.match(bodies[0], /^search "Hollow Knight";/);
  });
});
