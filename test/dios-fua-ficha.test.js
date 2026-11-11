// !dios_fua con un juego en la pregunta: el código detecta el nombre, busca la ficha en IGDB ANTES de llamar al modelo y se la pasa siempre.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';
process.env.CHANNEL = process.env.CHANNEL || 'parlusorum';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../src/twitch/api');
require(apiPath);
const api = require.cache[apiPath].exports;
const lookups = [];
const PHANTOM = { name: 'Phantom Blade Zero', released: '2026', developers: 'S-Game', country: 'China', publishers: 'S-Game', genres: 'Acción, Aventura', description: 'Acción de espadas en la China antigua.' };
api.getCurrentGame = async () => ({ game: 'Hell Is Us' });
api.getGameInfo = async () => null;
api.getChannelInfo = async () => ({ game_name: 'Dark Souls: Remastered' });
api.lookupGameInfo = async (name) => { lookups.push(name); return /phantom blade/i.test(name) ? { info: PHANTOM } : { info: null }; };

const router = require('../src/utils/ai-router');
const state = require('../src/utils/state');
const q = require('../src/ai/quality');
const ai = require('../src/ai/handler');

let sent, calls;
const client = { say: (ch, msg) => { sent.push(msg); } };
const text = c => ({ choices: [{ message: { content: c }, finish_reason: 'stop' }] });
let userId = 100;
const tags = () => ({ 'display-name': 'gangar79', 'user-id': String(userId++), username: 'gangar79', badges: {} });

beforeEach(() => {
  sent = []; calls = []; lookups.length = 0;
  state.resetAiBlocks(); state.resetAiUsage();
  router.setTransport('groq', async p => { if (!/Eres Dios Fua/.test(p.messages[0].content)) return text('NO'); calls.push(p); return text('Phantom Blade Zero es de S-Game, un estudio de China, y sale en 2026; el FUA lo aprueba.'); });
});

describe('extractGameMention (nombre de juego en la pregunta)', () => {
  const cases = [
    ['quien desarrollo el phantom blade 0? japoneses o chinos?', 'phantom blade 0'],
    ['qué opinas de Hell is Us', 'Hell is Us'],
    ['cuándo sale Hades 2?', 'Hades 2'],
    ['de qué país es el estudio de Elden Ring', 'Elden Ring'],
    ['que tal es Black Myth: Wukong, merece la pena?', 'Black Myth: Wukong'],
    ['cuéntame de qué va Silent Hill F', 'Silent Hill F'],
  ];
  for (const [input, name] of cases) test(`"${input}" → ${name}`, () => assert.equal(q.extractGameMention(input), name));
  for (const input of ['por qué el cielo es azul?', 'quién es el mejor streamer?', 'qué opinas de tu creador', 'cuántas abejas hay']) {
    test(`sin juego: "${input}"`, () => assert.equal(q.extractGameMention(input), null));
  }
});

describe('!dios_fua con ficha previa', () => {
  test('el código busca la ficha, se la pasa en el mensaje y no ofrece la herramienta', async () => {
    await ai.handleQuestion(client, '#parlusorum', tags(), ['!dios_fua', 'quien', 'desarrollo', 'el', 'phantom', 'blade', '0?', 'japoneses', 'o', 'chinos?']);
    assert.deepEqual(lookups, ['phantom blade 0']);
    assert.equal(calls.length, 1, 'una sola llamada: sin ronda de herramienta');
    assert.equal(calls[0].tools, undefined);
    const user = calls[0].messages.at(-1).content;
    assert.match(user, /^<ficha_igdb>\nNombre: Phantom Blade Zero/);
    assert.match(user, /País de la desarrolladora: China/);
    assert.match(user, /<\/ficha_igdb>\ngangar79: quien desarrollo/);
  });

  test('sin nombre de juego no busca y deja la herramienta disponible', async () => {
    await ai.handleQuestion(client, '#parlusorum', tags(), ['!dios_fua', 'por', 'qué', 'el', 'cielo', 'es', 'azul']);
    assert.deepEqual(lookups, []);
    assert.ok(calls[0].tools?.length);
  });

  test('si IGDB no conoce el juego, sigue el flujo normal con la herramienta y sin ficha', async () => {
    await ai.handleQuestion(client, '#parlusorum', tags(), ['!dios_fua', 'qué', 'opinas', 'de', 'Zzzz', 'Quest']);
    assert.deepEqual(lookups, ['Zzzz Quest']);
    assert.ok(calls[0].tools?.length);
    assert.doesNotMatch(calls[0].messages.at(-1).content, /ficha_igdb/);
  });
});
