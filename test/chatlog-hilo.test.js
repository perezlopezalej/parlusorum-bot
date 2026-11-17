// 16-11: el chatlog guardaba el texto de las respuestas del bot antes de quitar la «@usuario» y no indicaba si salieron en hilo,
// así que siempre se veía la arroba, saliera en hilo o no. Ahora se guarda lo realmente enviado y la marca de hilo.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:1';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const chatlog = require('../src/utils/chatlog');
const reactions = require('../src/ai/reactions');
const state = require('../src/utils/state');
const { wrapClientSay, setApiSender, _testHooks } = require('../src/utils/irc-ratelimit');

const { buildRow, formatLine } = chatlog;

describe('buildRow: mensajes del bot en hilo', () => {
  test('en hilo: guarda el destinatario en reply_parent_login y threaded=true', () => {
    const r = buildRow({
      username: 'bot',
      message: 'Hola',
      isBot: true,
      threaded: true,
      replyTo: { id: 'm1', nick: 'Ana' },
    });
    assert.equal(r.threaded, true);
    assert.equal(r.reply_parent_login, 'ana');
  });

  test('sin hilo: el bot no guarda destinatario y threaded=false', () => {
    const r = buildRow({ username: 'bot', message: '@Ana Hola', isBot: true, replyTo: { id: 'm1', nick: 'Ana' } });
    assert.equal(r.threaded, false);
    assert.equal(r.reply_parent_login, null);
  });

  test('threaded sin destinatario no se marca; los usuarios nunca llevan threaded', () => {
    assert.equal(buildRow({ username: 'bot', message: 'x', isBot: true, threaded: true }).threaded, false);
    const u = buildRow({ username: 'a', message: 'x', replyTo: 'Dios_Fua', threaded: true });
    assert.equal(u.threaded, false);
    assert.equal(u.reply_parent_login, 'dios_fua');
  });
});

describe('formatLine marca el hilo', () => {
  const base = {
    created_at: new Date(2026, 10, 16, 20, 14, 5).toISOString(),
    username: 'dios_fua',
    message: 'Hola',
    is_bot: true,
  };
  test('[mencion ↩] si salió en hilo y [mencion] si no', () => {
    assert.match(formatLine({ ...base, origin: 'mencion', threaded: true }), /dios_fua \[mencion ↩\]: Hola$/);
    assert.match(formatLine({ ...base, origin: 'mencion', threaded: false }), /dios_fua \[mencion\]: Hola$/);
    assert.match(formatLine({ ...base, origin: 'mencion' }), /dios_fua \[mencion\]: Hola$/);
  });
  test('los mensajes de usuario no llevan marca', () => {
    assert.match(formatLine({ ...base, is_bot: false, username: 'ana' }), /ana: Hola$/);
  });
});

describe('addresseeOfRow (reacciones)', () => {
  test('en hilo el destinatario sale de reply_parent_login; si no, de la arroba', () => {
    const threaded = { is_bot: true, message: 'Hola', reply_parent_login: 'Ana', threaded: true };
    assert.equal(reactions.addresseeOfRow(threaded), 'ana');
    assert.equal(reactions.addresseeOfRow({ is_bot: true, message: '@Luis Hola', reply_parent_login: null }), 'luis');
    assert.equal(reactions.addresseeOfRow({ is_bot: true, message: 'Hola' }), null);
    // un mensaje de usuario con reply_parent_login no cambia su lectura
    assert.equal(reactions.addresseeOfRow({ is_bot: false, message: '@Luis Hola', reply_parent_login: 'ana' }), 'luis');
  });

  test('el destinatario que contesta cuenta aunque el texto no lleve arroba', () => {
    const T0 = Date.UTC(2026, 10, 16, 20, 0, 0);
    const bot = {
      created_at: new Date(T0).toISOString(),
      username: 'dios_fua',
      message: 'Manu sigue en pie.',
      is_bot: true,
      origin: 'mencion',
      threaded: true,
      reply_parent_login: 'ana',
    };
    const answer = {
      created_at: new Date(T0 + 5000).toISOString(),
      username: 'ana',
      message: 'gracias',
      is_bot: false,
    };
    const withParent = reactions.scoreReaction(bot, [answer]);
    const without = reactions.scoreReaction({ ...bot, reply_parent_login: null, threaded: false }, [answer]);
    assert.notDeepEqual(withParent, without, 'con destinatario, la respuesta de Ana se reconoce');
  });
});

describe('cola de salida: el chatlog guarda lo enviado y si fue en hilo', () => {
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
    state.takeChatLog(10_000);
  });
  afterEach(() => {
    setApiSender(null);
    state.takeChatLog(10_000);
    if (savedEnv === undefined) delete process.env.CHAT_REPLY_THREAD;
    else process.env.CHAT_REPLY_THREAD = savedEnv;
  });
  const makeClient = () => {
    const client = { say: async () => {}, readyState: () => 'OPEN' };
    wrapClientSay(client);
    return client;
  };
  const reply = (client, text) =>
    chatlog.runWithOrigin('mencion', () => client.say('#c', text), { replyTo: { id: 'padre-1', nick: 'Ana' } });
  const lastRow = async () => {
    await until(() => state.getChatLogSize() > 0);
    return state.takeChatLog(10)[0];
  };

  test('en hilo: texto sin la arroba, threaded=true y destinatario', async () => {
    setApiSender(async () => ({ sent: true }));
    reply(makeClient(), '@Ana Manu sigue en pie.');
    const row = await lastRow();
    assert.equal(row.message, 'Manu sigue en pie.');
    assert.equal(row.threaded, true);
    assert.equal(row.reply_parent_login, 'ana');
    assert.match(formatLine(row), /\[mencion ↩\]: Manu sigue en pie\.$/);
  });

  test('si Twitch rechaza el padre, se guarda con la arroba y sin hilo', async () => {
    setApiSender(async (m, opts) => {
      if (opts?.replyTo) throw Object.assign(new Error('padre'), { replyParent: true });
      return { sent: true };
    });
    reply(makeClient(), '@Ana Manu sigue en pie.');
    const row = await lastRow();
    assert.equal(row.message, '@Ana Manu sigue en pie.');
    assert.equal(row.threaded, false);
    assert.equal(row.reply_parent_login, null);
  });

  test('sin la opción o por IRC se guarda tal cual, sin hilo', async () => {
    delete process.env.CHAT_REPLY_THREAD;
    setApiSender(null);
    reply(makeClient(), '@Ana Manu sigue en pie.');
    const row = await lastRow();
    assert.equal(row.message, '@Ana Manu sigue en pie.');
    assert.equal(row.threaded, false);
  });
});
