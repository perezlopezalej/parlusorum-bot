// Directo del 13-11, punto 8: respuestas en hilo (reply_parent_message_id) en vez de «@usuario» al inicio, para el lector de voz.
// Apagado por defecto (CHAT_REPLY_THREAD): Twitch no documenta si añade él la arroba al texto. Todo sin red.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.CLIENT_ID = process.env.CLIENT_ID || 'cid';
process.env.CLIENT_SECRET = process.env.CLIENT_SECRET || 'secret';
process.env.BOT_USERNAME = 'dios_fua';
delete process.env.BOT_USER_ID;

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const thread = require('../src/utils/reply-thread');
const chatlog = require('../src/utils/chatlog');
const api = require('../src/twitch/chat-api');
const state = require('../src/utils/state');
const { wrapClientSay, setApiSender, _testHooks } = require('../src/utils/irc-ratelimit');

const ON = { CHAT_REPLY_THREAD: '1' };
const meta = (origin = 'dios_fua', nick = 'Ana') => ({ origin, replyTo: { id: 'msg-1', nick } });

describe('stripLeadingMention', () => {
  test('quita la arroba de quien se contesta, con coma, dos puntos o espacio', () => {
    for (const [input, text] of [
      ['@Ana Ayer fue la maratón.', 'Ayer fue la maratón.'],
      ['@Ana, ayer fue la maratón.', 'ayer fue la maratón.'],
      ['@ana: ayer fue la maratón.', 'ayer fue la maratón.'],
      ['@ANA   ayer fue la maratón.', 'ayer fue la maratón.'],
    ])
      assert.deepEqual(thread.stripLeadingMention(input, 'Ana'), { text, replied: true }, input);
  });

  test('con un emoji delante lo conserva («⏳ @Ana, espera»)', () => {
    assert.deepEqual(thread.stripLeadingMention('⏳ @Ana, espera un poco.', 'Ana'), {
      text: '⏳ espera un poco.',
      replied: true,
    });
  });

  test('no toca la arroba de otra persona, la del medio del mensaje ni un nick que solo empieza igual', () => {
    for (const input of [
      '@Luis te ha retado a una trivia.',
      'Ayer, @Ana, fue la maratón.',
      '@Anabel ayer fue la maratón.',
      '@Ana_99 ayer fue la maratón.',
      'Sin arroba alguna.',
    ])
      assert.deepEqual(thread.stripLeadingMention(input, 'Ana'), { text: input, replied: false }, input);
  });

  test('si no queda nada que decir, o no hay nick, no hay hilo', () => {
    assert.equal(thread.stripLeadingMention('@Ana', 'Ana').replied, false);
    assert.equal(thread.stripLeadingMention('@Ana ...', 'Ana').replied, false);
    assert.equal(thread.stripLeadingMention('@Ana hola', '').replied, false);
    assert.equal(thread.stripLeadingMention(undefined, 'Ana').text, '');
  });

  test('nicks con caracteres especiales de expresión regular', () => {
    assert.equal(thread.stripLeadingMention('@a.b hola', 'a.b').replied, true);
    assert.equal(thread.stripLeadingMention('@axb hola', 'a.b').replied, false);
  });
});

describe('planReply', () => {
  test('apagado por defecto: ningún mensaje sale en hilo', () => {
    assert.equal(thread.enabled({}), false);
    assert.equal(thread.planReply('@Ana hola', meta(), { env: {} }), null);
    assert.equal(thread.planReply('@Ana hola', meta(), { env: { CHAT_REPLY_THREAD: '0' } }), null);
  });

  test('con la opción activa, las respuestas a un usuario salen en hilo y sin arroba', () => {
    for (const origin of thread.REPLY_ORIGINS)
      assert.deepEqual(thread.planReply('@Ana hola, qué tal', meta(origin), { env: ON }), {
        text: 'hola, qué tal',
        replyTo: 'msg-1',
      });
    assert.deepEqual([...thread.REPLY_ORIGINS].sort(), [
      'chiste',
      'comando',
      'dios_fua',
      'mencion',
      'quemeperdi',
      'redes',
    ]);
  });

  test('otros orígenes (cohost, alertas, hooks…), mensajes sin destinatario y sin API: sin hilo', () => {
    for (const origin of ['cohost', 'alerta', 'hook', 'otro', 'trivia'])
      assert.equal(thread.planReply('@Ana hola', meta(origin), { env: ON }), null, origin);
    assert.equal(thread.planReply('@Ana hola', { origin: 'dios_fua' }, { env: ON }), null);
    assert.equal(thread.planReply('Hola a todos', meta(), { env: ON }), null);
    assert.equal(thread.planReply('@Luis ven', meta(), { env: ON }), null);
    assert.equal(thread.planReply('@Ana hola', meta(), { env: ON, hasApi: false }), null, 'por IRC no hay hilo');
  });
});

describe('contexto de origen: replyTo viaja con el say()', () => {
  test('runWithOrigin guarda el mensaje al que se contesta y currentMeta lo da (también tras un await)', async () => {
    const seen = await chatlog.runWithOrigin(
      'dios_fua',
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        return chatlog.currentMeta();
      },
      { replyTo: { id: 'abc', nick: 'Ana' } },
    );
    assert.deepEqual(seen.replyTo, { id: 'abc', nick: 'Ana' });
    assert.equal(seen.origin, 'dios_fua');
    assert.equal(
      chatlog.runWithOrigin('mencion', () => chatlog.currentMeta().replyTo),
      null,
    );
    assert.equal(chatlog.currentMeta().replyTo, null);
  });
});

describe('chat-api: 400 con reply_parent_message_id', () => {
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  let requests, realFetch;
  const fake =
    (sendResponse) =>
    async (url, opts = {}) => {
      requests.push({ url: String(url), opts });
      if (String(url).includes('id.twitch.tv/oauth2/token')) return json(200, { access_token: 'APPTOKEN' });
      if (String(url).includes('/users?login=')) return json(200, { data: [{ id: '777' }] });
      return sendResponse(opts);
    };
  beforeEach(() => {
    requests = [];
    realFetch = global.fetch;
    api._setDeps({ botUserId: null, reset: true });
  });
  afterEach(() => {
    global.fetch = realFetch;
  });
  const posts = () => requests.filter((r) => r.url.endsWith('/chat/messages'));

  test('manda el id del padre en el cuerpo', async () => {
    global.fetch = fake(() => json(200, { data: [{ message_id: 'm', is_sent: true }] }));
    api._setDeps({ fetch: (...a) => global.fetch(...a) });
    await api.sendChatMessage('texto', { replyTo: 'padre-1' });
    assert.equal(JSON.parse(posts()[0].opts.body).reply_parent_message_id, 'padre-1');
    await api.sendChatMessage('sin hilo');
    assert.equal('reply_parent_message_id' in JSON.parse(posts()[1].opts.body), false);
  });

  test('un 400 con hilo es «padre no válido»: no desactiva la API; un 400 sin hilo sigue siendo de autorización', async () => {
    global.fetch = fake(() => json(400, {}));
    api._setDeps({ fetch: (...a) => global.fetch(...a), now: () => 5_000_000 });
    await assert.rejects(api.sendChatMessage('x', { replyTo: 'borrado' }), (e) => e.replyParent === true && !e.auth);
    await assert.rejects(api.sendChatMessage('y'), (e) => e.auth === true && e.status === 400, 'este sí desactiva');
  });
});

describe('cola de salida: envío en hilo y reintento sin hilo', () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 3000) => {
    const t = Date.now();
    while (!fn() && Date.now() - t < ms) await wait(5);
  };
  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.CHAT_REPLY_THREAD;
    process.env.CHAT_REPLY_THREAD = '1';
    _testHooks({ gapMs: 5, sayTimeoutMs: 200, reset: true });
    state.setStreamIsLive(true);
    state.setStreamEndGraceUntil(0);
    state.resetRecentUserTexts();
    state.resetFilterStats();
  });
  afterEach(() => {
    setApiSender(null);
    if (savedEnv === undefined) delete process.env.CHAT_REPLY_THREAD;
    else process.env.CHAT_REPLY_THREAD = savedEnv;
  });
  function makeClient() {
    const irc = [];
    const client = {
      say: async (c, m) => {
        irc.push(m);
      },
      readyState: () => 'OPEN',
    };
    wrapClientSay(client);
    return { client, irc };
  }
  const reply = (client, text) =>
    chatlog.runWithOrigin('dios_fua', () => client.say('#c', text), { replyTo: { id: 'padre-1', nick: 'Ana' } });

  test('con la opción activa sale por la API en hilo y sin la arroba', async () => {
    const calls = [];
    setApiSender(async (m, opts) => {
      calls.push([m, opts?.replyTo]);
      return { sent: true };
    });
    const { client, irc } = makeClient();
    reply(client, '@Ana Ayer fue la maratón de Hell Is Us.');
    await until(() => calls.length);
    assert.deepEqual(calls, [['Ayer fue la maratón de Hell Is Us.', 'padre-1']]);
    assert.deepEqual(irc, []);
  });

  test('sin la opción, sale como siempre: con la arroba y sin hilo', async () => {
    delete process.env.CHAT_REPLY_THREAD;
    const calls = [];
    setApiSender(async (m, opts) => {
      calls.push([m, opts?.replyTo]);
      return { sent: true };
    });
    const { client } = makeClient();
    reply(client, '@Ana Ayer fue la maratón de Hell Is Us.');
    await until(() => calls.length);
    assert.deepEqual(calls, [['@Ana Ayer fue la maratón de Hell Is Us.', undefined]]);
  });

  test('si Twitch rechaza el mensaje padre, el mismo texto sale sin hilo y con su arroba', async () => {
    const calls = [];
    setApiSender(async (m, opts) => {
      calls.push([m, opts?.replyTo]);
      if (opts?.replyTo) throw Object.assign(new Error('padre'), { replyParent: true });
      return { sent: true };
    });
    const { client, irc } = makeClient();
    reply(client, '@Ana Ayer fue la maratón de Hell Is Us.');
    await until(() => calls.length >= 2);
    assert.deepEqual(calls, [
      ['Ayer fue la maratón de Hell Is Us.', 'padre-1'],
      ['@Ana Ayer fue la maratón de Hell Is Us.', undefined],
    ]);
    assert.deepEqual(irc, []);
  });

  test('un fallo de la API que no es del padre sigue yendo a IRC, con la arroba', async () => {
    setApiSender(async () => {
      throw new Error('HTTP 500');
    });
    const { client, irc } = makeClient();
    reply(client, '@Ana Ayer fue la maratón de Hell Is Us.');
    await until(() => irc.length);
    assert.deepEqual(irc, ['@Ana Ayer fue la maratón de Hell Is Us.']);
  });

  test('un mensaje a otra persona o de otro origen sale tal cual', async () => {
    const calls = [];
    setApiSender(async (m, opts) => {
      calls.push([m, opts?.replyTo]);
      return { sent: true };
    });
    const { client } = makeClient();
    reply(client, '@Luis te ha retado a una trivia, Ana.');
    chatlog.runWithOrigin('cohost', () => client.say('#c', '@Ana Manu sigue en pie, eso es FUA.'));
    await until(() => calls.length >= 2);
    assert.deepEqual(calls, [
      ['@Luis te ha retado a una trivia, Ana.', undefined],
      ['@Ana Manu sigue en pie, eso es FUA.', undefined],
    ]);
  });
});
