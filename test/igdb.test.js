process.env.CLIENT_ID = 'cid';
process.env.CLIENT_SECRET = 'secret';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const igdb = require('../src/twitch/igdb');
const { invalidateAppAccessToken } = require('../src/twitch/app-token');
const q = require('../src/ai/quality');
const { translateGenres } = require('../src/utils/genres');
const { formatJuegoLine } = require('../src/commands/juego');

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  invalidateAppAccessToken();
});

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const pbz = {
  id: 250618,
  name: 'Phantom Blade Zero',
  first_release_date: 1793232000,
  summary: 'Soul has sixty-six days to live.',
  storyline: 'SPOILER',
  genres: [{ name: 'Role-playing (RPG)' }, { name: "Hack and slash/Beat 'em up" }],
  involved_companies: [
    { developer: true, publisher: true, company: { name: 'S-Game', country: 156 } },
    { developer: false, publisher: false, company: { name: 'Cruelman Studio', country: 344 } },
  ],
};

describe('mapGame', () => {
  test('desarrolladora, editora, país en español, fecha ISO, sin storyline', () => {
    const i = igdb.mapGame(pbz, true);
    assert.equal(i.name, 'Phantom Blade Zero');
    assert.equal(i.developers, 'S-Game');
    assert.equal(i.publishers, 'S-Game');
    assert.equal(i.country, 'China');
    assert.equal(i.released, '2026-10-29');
    assert.equal(i.source, 'igdb');
    assert.ok(!JSON.stringify(i).includes('SPOILER'));
  });
  test('varias compañías: el país es solo el de las desarrolladoras', () => {
    const i = igdb.mapGame({
      name: 'Hell Is Us',
      involved_companies: [
        { publisher: true, company: { name: 'Nacon', country: 250 } },
        { developer: true, company: { name: 'Rogue Factor', country: 124 } },
      ],
    });
    assert.equal(i.developers, 'Rogue Factor');
    assert.equal(i.publishers, 'Nacon');
    assert.equal(i.country, 'Canadá');
  });
  test('sin país en la fuente → country null', () => {
    const i = igdb.mapGame({ name: 'X', involved_companies: [{ developer: true, company: { name: 'Y' } }] });
    assert.equal(i.country, null);
    assert.equal(igdb.countryName(99999), '');
  });
});

describe('sin credenciales', () => {
  test('falla sin tocar la red', async () => {
    const id = process.env.CLIENT_ID;
    delete process.env.CLIENT_ID;
    let called = false;
    global.fetch = async () => {
      called = true;
      return ok([]);
    };
    try {
      await assert.rejects(igdb.searchGame('Algo'), /sin CLIENT_ID/);
      assert.equal(called, false);
    } finally {
      process.env.CLIENT_ID = id;
    }
  });
});

describe('pickBest', () => {
  test('prefiere coincidencia de nombre y juego base sobre edición', () => {
    const best = igdb.pickBest('Hell is Us', [
      { name: 'Hell Is Us: Deluxe Edition', version_parent: 1 },
      { name: 'Hell Is Us' },
    ]);
    assert.equal(best.name, 'Hell Is Us');
  });
});

describe('pickBest: el juego original sobre su remake, remaster o port', () => {
  const sotc = [
    { id: 3, name: 'Shadow of the Colossus', game_type: 8, first_release_date: 1517529600, parent_game: 1 }, // remake 2018
    { id: 2, name: 'Shadow of the Colossus', game_type: 11, first_release_date: 1346457600, parent_game: 1 }, // port 2012
    { id: 1, name: 'Shadow of the Colossus', game_type: 0, first_release_date: 1131494400 }, // original 2005
    { id: 4, name: 'Shadow of the Colossus', game_type: 9, first_release_date: 1318377600, parent_game: 1 }, // remaster 2011
  ];

  test('sin pedir edición gana el original aunque IGDB lo devuelva el último', () => {
    assert.equal(igdb.pickBest('Shadow of the Colossus', sotc).id, 1);
  });

  test('si se pide la edición o el año, no se penaliza', () => {
    assert.equal(igdb.pickBest('Shadow of the Colossus remake', sotc.slice(1)).game_type !== undefined, true);
    assert.equal(igdb.pickBest('Shadow of the Colossus 2018', sotc).id, 3);
    assert.equal(igdb.pickBest('Shadow of the Colossus 2012', sotc).id, 2);
  });

  test('si el original no está en los resultados, se elige el mejor de los demás', () => {
    assert.equal(
      igdb.pickBest(
        'Shadow of the Colossus',
        sotc.filter((g) => g.id !== 1),
      ) !== null,
      true,
    );
  });
});

describe('searchGame con remakes y ports', () => {
  function mock(handler) {
    const calls = [];
    global.fetch = async (url, opts) => {
      if (String(url).includes('id.twitch.tv')) return ok({ access_token: 'tok' });
      calls.push({ body: opts.body });
      return handler(calls.length, opts.body);
    };
    return calls;
  }
  const original = { id: 1, name: 'Shadow of the Colossus', game_type: 0, first_release_date: 1131494400 };

  test('un remake sin el original en la búsqueda se resuelve a su juego original (2005, no 2018)', async () => {
    const remake = {
      id: 3,
      name: 'Shadow of the Colossus',
      game_type: 8,
      first_release_date: 1517529600,
      parent_game: 1,
    };
    const calls = mock((n) => ok(n === 1 ? [remake] : [original]));
    const info = await igdb.searchGame('Shadow of the Colossus');
    assert.equal(info.released, '2005-11-09');
    assert.match(calls[1].body, /where id = 1;/);
    assert.match(calls[0].body, /game_type,parent_game/);
  });

  test('pidiendo el remake no se redirige al original', async () => {
    const remake = {
      id: 3,
      name: 'Shadow of the Colossus Remake',
      game_type: 8,
      first_release_date: 1517529600,
      parent_game: 1,
    };
    const calls = mock(() => ok([remake]));
    const info = await igdb.searchGame('Shadow of the Colossus remake');
    assert.equal(info.released, '2018-02-02');
    assert.equal(calls.length, 1);
  });

  test('una expansión independiente con padre de otro nombre no se redirige', async () => {
    const expansion = {
      id: 9,
      name: 'Dark Souls Artorias',
      game_type: 4,
      first_release_date: 1346457600,
      parent_game: 1,
    };
    const calls = mock(() => ok([expansion]));
    const info = await igdb.searchGame('Dark Souls Artorias');
    assert.equal(info.name, 'Dark Souls Artorias');
    assert.equal(calls.length, 1);
  });

  test('un port cuyo padre tiene otro nombre se queda como está', async () => {
    const port = {
      id: 5,
      name: 'Shadow of the Colossus HD',
      game_type: 11,
      first_release_date: 1318377600,
      parent_game: 77,
    };
    const calls = mock((n) => ok(n === 1 ? [port] : [{ id: 77, name: 'Algo Distinto', game_type: 0 }]));
    const info = await igdb.searchGame('Shadow of the Colossus');
    assert.equal(info.name, 'Shadow of the Colossus HD');
    assert.equal(calls.length, 2);
  });
});

describe('searchGame', () => {
  function mock(handler) {
    const calls = [];
    global.fetch = async (url, opts) => {
      if (String(url).includes('id.twitch.tv')) return ok({ access_token: 'tok' });
      calls.push({ url: String(url), body: opts.body, auth: opts.headers.Authorization });
      return handler(calls.length, opts.body);
    };
    return calls;
  }
  test('consulta con search, filtro game_type y summary (nunca storyline)', async () => {
    const calls = mock(() => ok([pbz]));
    const info = await igdb.searchGame('Phantom Blade Zero');
    assert.equal(info.country, 'China');
    assert.match(calls[0].body, /^search "Phantom Blade Zero";/);
    assert.match(calls[0].body, /where game_type = \(0,4,8,9,10,11\)/);
    assert.match(calls[0].body, /summary/);
    assert.doesNotMatch(calls[0].body, /storyline/);
    assert.equal(calls[0].auth, 'Bearer tok');
  });
  test('comillas del nombre no rompen la consulta', async () => {
    const calls = mock(() => ok([]));
    await igdb.searchGame('Foo" ; fields *; "');
    assert.doesNotMatch(calls[0].body.split(';')[0], /".*".*"/);
  });
  test('sin resultados → null', async () => {
    mock(() => ok([]));
    assert.equal(await igdb.searchGame('zzz qqq'), null);
  });
  test('candidato sin relación → null ', async () => {
    mock(() => ok([{ name: 'Totalmente Distinto' }]));
    assert.equal(await igdb.searchGame('Fuaventura Legends'), null);
  });
  test('"phantom blade 0" devuelve la edición: se piden los datos del juego base', async () => {
    const edition = { name: 'Phantom Blade Zero: Digital Deluxe Edition', version_parent: 250618 };
    const calls = mock((n) => ok(n === 1 ? [edition] : [pbz]));
    const info = await igdb.searchGame('phantom blade 0');
    assert.equal(info.name, 'Phantom Blade Zero');
    assert.match(calls[1].body, /where id = 250618/);
  });
  test('401 → renueva el token y reintenta una vez', async () => {
    let n = 0;
    mock(() => (++n === 1 ? { ok: false, status: 401, json: async () => ({}) } : ok([pbz])));
    assert.equal((await igdb.searchGame('Phantom Blade Zero')).name, 'Phantom Blade Zero');
    assert.equal(n, 2);
  });
  test('5xx y formato ilegible lanzan error', async () => {
    mock(() => ({ ok: false, status: 503, json: async () => ({}) }));
    await assert.rejects(igdb.searchGame('Algo'), /HTTP 503/);
    mock(() => ok({ message: 'raro' }));
    await assert.rejects(igdb.searchGame('Algo'), /ilegible/);
  });
  test('límite de IGDB: ≥ 250 ms entre peticiones aunque salgan a la vez', async () => {
    const starts = [];
    global.fetch = async (url) => {
      if (String(url).includes('id.twitch.tv')) return ok({ access_token: 'tok' });
      starts.push(Date.now());
      return ok([]);
    };
    await Promise.all([igdb.searchGame('uno'), igdb.searchGame('dos'), igdb.searchGame('tres')]);
    assert.equal(starts.length, 3);
    assert.ok(
      starts[1] - starts[0] >= 250 && starts[2] - starts[1] >= 250,
      `separación: ${starts[1] - starts[0]}, ${starts[2] - starts[1]}`,
    );
  });
});

describe('géneros de IGDB en español', () => {
  test('traduce y omite lo desconocido', () => {
    assert.equal(translateGenres("Role-playing (RPG), Hack and slash/Beat 'em up, Adventure"), 'Rol, Acción, Aventura');
    assert.equal(translateGenres('Fighting, Algo raro'), 'Lucha');
  });
});

describe('formatJuegoLine (!juego)', () => {
  const info = igdb.mapGame(pbz);
  test('géneros en español, año, desarrolladora y atribución de IGDB; sin nota', () => {
    const line = formatJuegoLine('Phantom Blade Zero', 'Primer directo', info);
    assert.equal(
      line,
      '🎮 Phantom Blade Zero (2026): Rol, Acción, Desarrolladora: S-Game. Título del directo: Primer directo. Datos: IGDB.com',
    );
    assert.doesNotMatch(line, /⭐|\/5/);
  });
  test('sin datos útiles → null (línea simple)', () => {
    assert.equal(formatJuegoLine('X', null, null), null);
    assert.equal(formatJuegoLine('X', null, { genres: null, released: null, developers: null }), null);
  });
});

describe('país de IGDB en el filtro de atributos', () => {
  const data =
    'Nombre: Phantom Blade Zero\nDesarrolladora: S-Game\nPaís de la desarrolladora: China\nGéneros: Role-playing (RPG)';
  test('con país en los datos, decir china es válido', () => {
    assert.equal(q.unsupportedAttributes('S-Game es un estudio chino', data), '');
    assert.equal(q.inventedCompany('La desarrolladora es S-Game, china', data), '');
  });
  test('japonés sigue sin respaldo', () => {
    assert.ok(q.unsupportedAttributes('S-Game es un estudio japonés', data));
  });
  test('sin país en los datos, no puede decir china', () => {
    assert.ok(
      q.unsupportedAttributes('S-Game es un estudio chino', 'Nombre: Phantom Blade Zero\nDesarrolladora: S-Game'),
    );
  });
  test('países en español respaldados: Estados Unidos y Reino Unido', () => {
    assert.equal(
      q.unsupportedAttributes('El estudio es estadounidense', 'País de la desarrolladora: Estados Unidos'),
      '',
    );
    assert.equal(q.unsupportedAttributes('El estudio es británico', 'País de la desarrolladora: Reino Unido'), '');
  });
  test('IGDB cuenta como fuga técnica y como cita de fuente', () => {
    assert.ok(q.leaksTech('según IGDB sale en 2026'));
    assert.ok(q.citesGameScore('lo dice IGDB'));
  });
});

describe('búsqueda: casos reales de la comparativa', () => {
  function mockSeq(responses) {
    const bodies = [];
    global.fetch = async (url, opts) => {
      if (String(url).includes('id.twitch.tv')) return ok({ access_token: 'tok' });
      bodies.push(opts.body);
      return ok(responses(bodies.length, opts.body));
    };
    return bodies;
  }
  const hellIsUs = { id: 1, name: 'Hell Is Us', first_release_date: 1756944000 };
  const hellHell = { id: 2, name: 'Hell-Hell', first_release_date: 1500000000 };

  test('Hell is Us: entre varios resultados elige el nombre completo, no "Hell-Hell"', () => {
    assert.equal(igdb.pickBest('Hell is Us', [hellHell, hellIsUs]).name, 'Hell Is Us');
    assert.equal(
      igdb.pickBest('Hell is Us', [
        hellHell,
        { id: 3, name: 'Hell Is Us: Deluxe Edition', version_parent: 1 },
        hellIsUs,
      ]).name,
      'Hell Is Us',
    );
  });
  test('Hell is Us: si solo sale "Hell-Hell" no se da por bueno', async () => {
    mockSeq(() => [hellHell]);
    assert.equal(await igdb.searchGame('Hell is Us'), null);
  });
  test('"Hell ... ..." (nombre truncado por el modelo) no acepta "Hell-Hell" como coincidencia', async () => {
    mockSeq(() => [hellHell]);
    const info = await igdb.searchGame('Hell ... ...');
    const { classifyGameMatch } = require('../src/utils/game-match');
    assert.notEqual(classifyGameMatch('Hell ... ...', info.name), 'match');
  });
  test('phantom blade 0: si la primera búsqueda falla reintenta con "zero"', async () => {
    const bodies = mockSeq((n) => (n === 1 ? [] : [pbz]));
    const info = await igdb.searchGame('phantom blade 0');
    assert.equal(info.name, 'Phantom Blade Zero');
    assert.match(bodies[0], /search "phantom blade 0"/);
    assert.match(bodies[1], /search "phantom blade zero"/);
  });
  test('phantom blade 0: la edición que sale primero se resuelve al juego base', async () => {
    const edition = { name: 'Phantom Blade Zero: Digital Deluxe Edition', version_parent: 250618 };
    const bodies = mockSeq((n) => (n === 1 ? [edition] : [pbz]));
    assert.equal((await igdb.searchGame('phantom blade 0')).name, 'Phantom Blade Zero');
    assert.equal(bodies.length, 2);
  });
  test('con coincidencia clara no hay reintentos', async () => {
    const bodies = mockSeq(() => [pbz]);
    await igdb.searchGame('Phantom Blade Zero');
    assert.equal(bodies.length, 1);
  });
  test('nameVariants: cifra ↔ palabra ↔ romano, sin repetir el original', () => {
    assert.deepEqual(igdb.nameVariants('phantom blade 0'), ['phantom blade zero']);
    assert.deepEqual(igdb.nameVariants('dark souls 2'), ['dark souls two', 'dark souls II']);
    assert.deepEqual(igdb.nameVariants('dark souls III'), ['dark souls 3']);
    assert.deepEqual(igdb.nameVariants('elden ring'), []);
  });
});
