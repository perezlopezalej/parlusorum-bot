// Ficha de IGDB en español y en limpio + filtro de salida contra fichas volcadas en bruto (caso real: phantom-blade-pais)
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';
process.env.CHANNEL = process.env.CHANNEL || 'parlusorum';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../src/twitch/api');
require(apiPath);
const api = require.cache[apiPath].exports;
const PHANTOM = {
  name: 'Phantom Blade Zero',
  released: '2026-10-29',
  developers: 'S-Game',
  country: 'China',
  publishers: 'S-Game',
  genres: "Role-playing (RPG), Hack and slash/Beat 'em up, Adventure",
  description:
    'Framed for the death of his master and left with a ruined heart, Soul has sixty-six days to live, alone and hunted by his own sect.',
};
api.getCurrentGame = async () => ({ game: 'Hell Is Us' });
api.getGameInfo = async () => null;
api.getChannelInfo = async () => ({ game_name: 'Dark Souls: Remastered' });
api.lookupGameInfo = async (name) => (/phantom blade/i.test(name) ? { info: PHANTOM } : { info: null });

const router = require('../src/utils/ai-router');
const state = require('../src/utils/state');
const sheet = require('../src/ai/game-sheet');
const ai = require('../src/ai/handler');

const text = (c) => ({ choices: [{ message: { content: c }, finish_reason: 'stop' }] });

describe('fecha en español', () => {
  test('ISO → «octubre de 2026»', () => {
    assert.equal(sheet.formatReleaseEs('2026-10-29'), 'octubre de 2026');
    assert.equal(sheet.formatReleaseEs('2025-01-02'), 'enero de 2025');
    assert.equal(sheet.formatReleaseEs('2024'), '2024');
    assert.equal(sheet.formatReleaseEs(null), '');
  });
});

describe('leaksSheetRaw: respuestas con la ficha en bruto', () => {
  const names = ['Phantom Blade Zero'];
  const bad = [
    ['fecha ISO', '2026-10-29, S-Game, RPG: de eso no tengo ni idea'],
    ['géneros en inglés', "Es un RPG, Hack and slash/Beat 'em up y Adventure, el FUA lo aprueba."],
    ['descripción en inglés', 'Va de Framed for the death of his master y poco más, el FUA lo sabe.'],
    ['campos copiados', 'Salida: octubre de 2026. Desarrolladora: S-Game. Géneros: Acción.'],
    [
      'el volcado real',
      '2026-10-29, S-Game, RPG, Hack and slash/Beat \'em up, Adventure, "Framed for the death of his master…" — de eso no tengo ni idea',
    ],
  ];
  for (const [why, t] of bad) test(`descarta: ${why}`, () => assert.ok(sheet.leaksSheetRaw(t, { names }), t));

  const good = [
    'Phantom Blade Zero es de S-Game, un estudio de China, así que chinos; sale en octubre de 2026 y el FUA ya está en la cola.',
    'Hell Is Us es una aventura de acción con misterio, de Rogue Factor, estudio de Canadá; el FUA te lo aprueba.',
    'The Last of Us Part II Remastered es de Naughty Dog, y el FUA llora igual.',
    'Dark Souls: Remastered es de FromSoftware (2018) y duele con cariño.',
    'Black Myth: Wukong es de Game Science, estudio de China.',
  ];
  for (const t of good)
    test(`deja pasar: ${t.slice(0, 50)}`, () =>
      assert.equal(
        sheet.leaksSheetRaw(t, { names: [...names, 'Hell Is Us', 'The Last of Us Part II Remastered'] }),
        '',
      ));
});

describe('buildGameSheet', () => {
  test('ficha en español: fecha legible, géneros traducidos, país y resumen en español; sin inglés ni ISO', async () => {
    const out = await sheet.buildGameSheet(PHANTOM, {
      summary: async () => 'Un guerrero acusado de matar a su maestro tiene 66 días de vida.',
    });
    assert.match(
      out,
      /^Nombre: Phantom Blade Zero\nSalida: octubre de 2026\nDesarrolladora: S-Game\nPaís de la desarrolladora: China\nEditora: S-Game\nGéneros: Rol, Acción, Aventura\nResumen: Un guerrero/,
    );
    assert.equal(sheet.leaksSheetRaw(out.replace(/^[^\n]*: /gm, ''), { names: ['Phantom Blade Zero'] }), '');
    assert.doesNotMatch(out, /Framed|2026-10|Hack and slash/);
  });

  test('sin resumen válido la ficha dice «sin resumen» y nunca lleva la descripción inglesa', async () => {
    const out = await sheet.buildGameSheet(PHANTOM, { summary: async () => '' });
    assert.match(out, /Resumen: sin resumen$/);
    assert.doesNotMatch(out, /Framed/);
  });
});

describe('resumen en español, una vez por juego', () => {
  let calls;
  beforeEach(() => {
    calls = [];
    sheet.resetSummaryCache();
    state.resetAiBlocks();
    state.resetAiUsage();
  });

  test('lo genera con el tipo summary (qwen), lo guarda en caché y la segunda vez no llama', async () => {
    router.setTransport('groq', async (p) => {
      calls.push(p);
      return text('Un guerrero acusado de matar a su maestro tiene 66 días de vida.');
    });
    const a = await sheet.summarizeGameEs(PHANTOM);
    const b = await sheet.summarizeGameEs(PHANTOM);
    assert.equal(a, b);
    assert.equal(calls.length, 1);
    assert.match(calls[0].model, /qwen/);
    assert.match(calls[0].messages[1].content, /<descripcion>Framed/);
  });

  test('peticiones simultáneas del mismo juego comparten una sola llamada', async () => {
    router.setTransport('groq', async (p) => {
      calls.push(p);
      await new Promise((r) => setTimeout(r, 20));
      return text('Un guerrero con 66 días de vida.');
    });
    await Promise.all([sheet.summarizeGameEs(PHANTOM), sheet.summarizeGameEs(PHANTOM)]);
    assert.equal(calls.length, 1);
  });

  test('un resumen con inglés o un fallo del modelo se queda en cadena vacía (no se cachea)', async () => {
    router.setTransport('groq', async () => text('Framed for the death of his master and left with a ruined heart.'));
    assert.equal(await sheet.summarizeGameEs(PHANTOM), '');
    router.setTransport('groq', async () => {
      throw Object.assign(new Error('boom'), { status: 400 });
    });
    assert.equal(await sheet.summarizeGameEs(PHANTOM), '');
  });
});

describe('!dios_fua: la respuesta con la ficha en bruto no se envía', () => {
  let sent, gen;
  const client = {
    say: (ch, msg) => {
      sent.push(msg);
    },
  };
  let uid = 500;
  const tags = () => ({ 'display-name': 'gangar79', 'user-id': String(uid++), username: 'gangar79', badges: {} });
  const RAW =
    '2026-10-29, S-Game, RPG, Hack and slash/Beat \'em up, Adventure, "Framed for the death of his master…" — de eso no tengo ni idea';
  const GOOD =
    'Chinos: Phantom Blade Zero es de S-Game, un estudio de China, y sale en octubre de 2026; el FUA ya tiene el sable listo.';

  beforeEach(() => {
    sent = [];
    gen = [];
    sheet.resetSummaryCache();
    state.resetAiBlocks();
    state.resetAiUsage();
  });

  function stub(answers) {
    router.setTransport('groq', async (p) => {
      const sys = p.messages[0].content;
      if (/Resumes en español/.test(sys))
        return text('Un guerrero acusado de matar a su maestro tiene 66 días de vida.');
      if (!/Eres Dios Fua/.test(sys)) return text('NO'); // verificadores
      gen.push(p);
      return text(answers.shift() ?? GOOD);
    });
  }

  test('la ficha que ve el modelo va en español y en limpio', async () => {
    stub([GOOD]);
    await ai.handleQuestion(client, '#parlusorum', tags(), [
      '!dios_fua',
      'quien',
      'desarrollo',
      'el',
      'phantom',
      'blade',
      '0?',
      'japoneses',
      'o',
      'chinos?',
    ]);
    const user = gen[0].messages.at(-1).content;
    assert.match(user, /Salida: octubre de 2026/);
    assert.match(user, /Géneros: Rol, Acción, Aventura/);
    assert.match(user, /Resumen: Un guerrero/);
    assert.doesNotMatch(user, /Framed|2026-10-29|Hack and slash/);
    assert.match(sent[0], /Chinos/);
  });

  test('un volcado en bruto se descarta, se reintenta y se envía la respuesta buena', async () => {
    stub([RAW, GOOD]);
    await ai.handleQuestion(client, '#parlusorum', tags(), [
      '!dios_fua',
      'quien',
      'desarrollo',
      'el',
      'phantom',
      'blade',
      '0?',
      'japoneses',
      'o',
      'chinos?',
    ]);
    assert.equal(gen.length, 2);
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0], /Framed|2026-10-29|Hack and slash/);
    assert.match(sent[0], /China/);
  });

  test('si el reintento también vuelca la ficha, sale la plantilla de IGDB en español', async () => {
    stub([RAW, RAW]);
    await ai.handleQuestion(client, '#parlusorum', tags(), [
      '!dios_fua',
      'quien',
      'desarrollo',
      'el',
      'phantom',
      'blade',
      '0?',
      'japoneses',
      'o',
      'chinos?',
    ]);
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0], /Framed|2026-10-29|Hack and slash/);
    assert.match(sent[0], /Phantom Blade Zero/);
    assert.match(sent[0], /China/);
  });
});
