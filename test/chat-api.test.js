process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.CLIENT_ID = process.env.CLIENT_ID || 'cid';
process.env.CLIENT_SECRET = process.env.CLIENT_SECRET || 'secret';
process.env.BOT_USERNAME = 'dios_fua';
delete process.env.BOT_USER_ID;

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../src/twitch/chat-api');
const { wrapClientSay, setApiSender, _testHooks } = require('../src/utils/irc-ratelimit');
const state = require('../src/utils/state');

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
let requests;

// fetch falso: el token de aplicación, la búsqueda del ID del bot y el envío
function fakeFetch(sendResponse) {
  return async (url, opts = {}) => {
    requests.push({ url: String(url), opts });
    if (String(url).includes('id.twitch.tv/oauth2/token')) return json(200, { access_token: 'APPTOKEN' });
    if (String(url).includes('/users?login=')) return json(200, { data: [{ id: '777' }] });
    if (String(url).endsWith('/chat/messages'))
      return typeof sendResponse === 'function' ? sendResponse(opts) : sendResponse;
    return json(404, {});
  };
}

describe('Send Chat Message', () => {
  let realFetch;
  beforeEach(() => {
    requests = [];
    realFetch = global.fetch;
    api._setDeps({ botUserId: null, reset: true });
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  test('envía con el token de aplicación, el ID del bot y el del canal', async () => {
    global.fetch = fakeFetch(json(200, { data: [{ message_id: 'm1', is_sent: true }] }));
    api._setDeps({ fetch: (...a) => global.fetch(...a) });
    const r = await api.sendChatMessage('hola chat');
    assert.deepEqual(r, { sent: true, id: 'm1' });
    const post = requests.find((x) => x.url.endsWith('/chat/messages'));
    assert.equal(post.opts.method, 'POST');
    assert.equal(post.opts.headers.Authorization, 'Bearer APPTOKEN');
    const body = JSON.parse(post.opts.body);
    assert.equal(body.sender_id, '777');
    assert.equal(body.message, 'hola chat');
    assert.ok(body.broadcaster_id);
  });

  test('un mensaje descartado por Twitch devuelve el motivo, sin lanzar', async () => {
    global.fetch = fakeFetch(
      json(200, { data: [{ message_id: '', is_sent: false, drop_reason: { code: 'msg_duplicate', message: 'dup' } }] }),
    );
    api._setDeps({ fetch: (...a) => global.fetch(...a) });
    const r = await api.sendChatMessage('otra vez');
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'msg_duplicate');
  });

  test('403 (faltan permisos) lanza y desactiva la API un rato; 429 lanza sin desactivar', async () => {
    let now = 1_000_000;
    global.fetch = fakeFetch(json(403, {}));
    api._setDeps({ fetch: (...a) => global.fetch(...a), now: () => now });
    await assert.rejects(api.sendChatMessage('x'), (e) => e.auth === true && e.status === 403);
    const before = requests.length;
    await assert.rejects(api.sendChatMessage('x'), (e) => /desactivada/.test(e.message));
    assert.equal(requests.length, before, 'no vuelve a llamar mientras está desactivada');
    now += 11 * 60 * 1000;
    global.fetch = fakeFetch(json(429, {}));
    await assert.rejects(api.sendChatMessage('x'), (e) => e.status === 429 && !e.auth);
  });

  test('corta a 500 caracteres', async () => {
    global.fetch = fakeFetch(json(200, { data: [{ message_id: 'm', is_sent: true }] }));
    api._setDeps({ fetch: (...a) => global.fetch(...a) });
    await api.sendChatMessage('a'.repeat(700));
    assert.equal(JSON.parse(requests.find((x) => x.url.endsWith('/chat/messages')).opts.body).message.length, 500);
  });
});

describe('cola de salida con la API', () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Espera a la condición (sondeo) en vez de dormir un tiempo fijo: estable aunque la máquina vaya lenta
  const until = async (fn, ms = 3000) => {
    const t = Date.now();
    while (!fn() && Date.now() - t < ms) await wait(5);
  };
  beforeEach(() => {
    _testHooks({ gapMs: 5, sayTimeoutMs: 200, reset: true });
    state.setStreamIsLive(true);
    state.setStreamEndGraceUntil(0);
    state.resetRecentUserTexts();
    state.resetFilterStats();
  });
  afterEach(() => setApiSender(null));

  function makeClient(open = true) {
    const irc = [];
    const client = {
      say: async (c, m) => {
        irc.push(m);
      },
      readyState: () => (open ? 'OPEN' : 'CLOSED'),
    };
    wrapClientSay(client);
    return { client, irc };
  }

  test('con la API activa el mensaje sale por la API y no por IRC', async () => {
    const viaApi = [];
    setApiSender(async (m) => {
      viaApi.push(m);
      return { sent: true };
    });
    const { client, irc } = makeClient();
    client.say('#c', 'por la api', { origin: 'comando' });
    await until(() => viaApi.length);
    assert.deepEqual(viaApi, ['por la api']);
    assert.deepEqual(irc, []);
  });

  test('si la API falla, el mensaje sale por IRC', async () => {
    setApiSender(async () => {
      throw new Error('HTTP 500');
    });
    const { client, irc } = makeClient();
    client.say('#c', 'respaldo', { origin: 'comando' });
    await until(() => irc.length);
    assert.deepEqual(irc, ['respaldo']);
  });

  test('si Twitch lo descarta no se reenvía por IRC y cuenta como descarte de salida', async () => {
    setApiSender(async () => ({ sent: false, reason: 'automod_held' }));
    const { client, irc } = makeClient();
    client.say('#c', 'retenido', { origin: 'comando' });
    await until(() => state.getFilterStats().salida);
    assert.deepEqual(irc, []);
    assert.equal(state.getFilterStats().salida.reasons['api:automod_held'], 1);
  });

  test('con la API activa, un IRC caído no impide enviar', async () => {
    const viaApi = [];
    setApiSender(async (m) => {
      viaApi.push(m);
      return { sent: true };
    });
    const { client } = makeClient(false);
    client.say('#c', 'sigue', { origin: 'comando' });
    await until(() => viaApi.length);
    assert.deepEqual(viaApi, ['sigue']);
  });
});
