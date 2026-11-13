process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const router = require('../src/utils/ai-router');
const state = require('../src/utils/state');
const { pseudonymize, restoreText, restoreResult } = require('../src/utils/ai-pseudonym');
const { isModelGone } = require('../src/utils/groq-utils');
const { formatAiUsage } = require('../src/eventsub');

const gone = () => Object.assign(new Error('404 model_not_found'), { status: 404 });
const quota = (msg = 'Rate limit reached: tokens per minute (TPM)', retryAfter) =>
  Object.assign(new Error(msg), { status: 429, headers: retryAfter ? { 'retry-after': String(retryAfter) } : {} });
const server = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const chainOf = (text) => router.parseChain(text);
const ok = () => ({ choices: [{ message: { content: 'hola' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

let calls;
function fake(provider, handler) {
  router.setTransport(provider, async (p) => {
    calls.push(`${provider}:${p.model}`);
    return handler(p);
  });
}
beforeEach(() => {
  calls = [];
  state.resetAiBlocks();
  state.resetAiUsage();
  state.resetChatters();
  state.resetGroqFallbackUse();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('AI_CHAIN_')) delete process.env[k];
});

describe('cadenas por tipo de llamada', () => {
  test('parseChain lee groq:modelo y descarta eslabones no válidos (también los de Gemini)', () => {
    assert.deepEqual(
      chainOf('groq:openai/gpt-oss-120b, gemini:gemini-3.5-flash-lite, x:foo, groq:').map((l) => l.key),
      ['groq:openai/gpt-oss-120b'],
    );
  });

  test('los tipos que necesitan más gracia (cohost, reaction, !dios_fua, !quemeperdi) empiezan por el 120b', () => {
    for (const k of ['cohost', 'diosfua', 'quemeperdi']) {
      const c = router.getChain(k);
      assert.ok(
        c.every((l) => l.provider === 'groq'),
        k,
      );
      assert.match(c[0].model, /gpt-oss-120b/, k);
    }
  });

  test('menciones y provocaciones empiezan por el 120b, con el 20b de reserva', () => {
    for (const k of ['mention', 'provocation']) {
      const models = router.getChain(k).map((l) => l.model);
      assert.match(models[0], /gpt-oss-120b/, k);
      assert.ok(
        models.some((m) => /gpt-oss-20b/.test(m)),
        `${k}: el 20b de reserva`,
      );
    }
  });

  test('alertas, timer IA, hooks, fin de stream, trivia y comandos empiezan por qwen (cupo propio) y el 120b queda de reserva', () => {
    for (const k of ['alert', 'timer', 'hook', 'endstream', 'trivia', 'command']) {
      const c = router.getChain(k);
      assert.ok(
        c.every((l) => l.provider === 'groq'),
        k,
      );
      assert.match(c[0].model, /qwen/, k);
      assert.ok(
        c.some((l) => /gpt-oss-120b/.test(l.model)),
        k,
      );
    }
  });

  test('si el generador es qwen, el selector es un gpt-oss', () => {
    assert.ok(router.getChain('pick', { generator: 'qwen/qwen3.8-27b' }).every((l) => /gpt-oss/.test(l.model)));
  });

  test('las revisiones empiezan por el modelo rápido de Groq', () => {
    const c = router.getChain('review');
    assert.match(c[0].model, /gpt-oss-20b/);
    assert.ok(c.every((l) => l.provider === 'groq'));
  });

  test('el selector es de otra familia que el generador (gpt-oss → qwen y al revés)', () => {
    const fam = router.modelFamily;
    const vsGptOss = router.getChain('pick', { generator: 'openai/gpt-oss-120b' });
    assert.ok(vsGptOss.length && vsGptOss.every((l) => fam(l.model) !== 'gpt-oss'), vsGptOss.map((l) => l.key).join());
    const vsQwen = router.getChain('pick', { generator: 'qwen/qwen3.8-27b' });
    assert.ok(vsQwen.length && vsQwen.every((l) => fam(l.model) !== 'qwen'), vsQwen.map((l) => l.key).join());
  });

  test('AI_CHAIN_PICK no puede meter la familia del generador', () => {
    process.env.AI_CHAIN_PICK = 'groq:openai/gpt-oss-20b,groq:qwen/qwen3.8-27b';
    assert.deepEqual(
      router.getChain('pick', { generator: 'openai/gpt-oss-120b' }).map((l) => l.model),
      ['qwen/qwen3.8-27b'],
    );
  });

  test('AI_CHAIN_<TIPO> manda sobre el defecto; un tipo desconocido lanza', () => {
    process.env.AI_CHAIN_HOOK = 'groq:solo-este';
    assert.deepEqual(
      router.getChain('hook').map((l) => l.model),
      ['solo-este'],
    );
    assert.throws(() => router.getChain('nada'), /desconocido/);
  });
});

describe('salto de eslabón y bloqueos', () => {
  const chain = chainOf('groq:a,groq:b,groq:c');

  test('un 429 salta al siguiente sin esperar y bloquea el agotado', async () => {
    fake('groq', (p) => {
      if (p.model === 'a') throw quota();
      return ok();
    });
    const t0 = Date.now();
    const res = await router.runChain(chain, 'mention', { messages: [] });
    assert.deepEqual(calls, ['groq:a', 'groq:b']);
    assert.ok(Date.now() - t0 < 500);
    assert.deepEqual(res._ai, { provider: 'groq', model: 'b', kind: 'mention' });
    assert.ok(state.isAiBlocked('groq:a'));
    await router.runChain(chain, 'mention', { messages: [] });
    assert.deepEqual(calls.slice(2), ['groq:b']); // la siguiente petición ya no empieza por el bloqueado
  });

  for (const status of [500, 503]) {
    test(`un ${status} salta de modelo y lo bloquea unos minutos`, async () => {
      fake('groq', (p) => {
        if (p.model === 'a') throw server(status);
        return ok();
      });
      await router.runChain(chain, 'mention', { messages: [] });
      assert.deepEqual(calls, ['groq:a', 'groq:b']);
      const left = state.aiBlockedUntil('groq:a') - Date.now();
      assert.ok(left > 60 * 1000 && left <= 5 * 60 * 1000);
    });
  }

  test('un timeout salta de modelo y bloquea', async () => {
    fake('groq', (p) => {
      if (p.model === 'a') throw Object.assign(new Error('Request timed out.'), { code: 'ETIMEDOUT' });
      return ok();
    });
    await router.runChain(chain, 'mention', { messages: [] });
    assert.deepEqual(calls, ['groq:a', 'groq:b']);
    assert.ok(state.isAiBlocked('groq:a'));
  });

  test('modelo retirado (404) salta al siguiente', async () => {
    fake('groq', (p) => {
      if (p.model === 'a') throw gone();
      return ok();
    });
    await router.runChain(chain, 'mention', { messages: [] });
    assert.deepEqual(calls, ['groq:a', 'groq:b']);
    assert.ok(isModelGone(gone()));
  });

  test('un 400 no salta de modelo', async () => {
    fake('groq', () => {
      throw Object.assign(new Error('bad request'), { status: 400 });
    });
    await assert.rejects(router.runChain(chain, 'mention', { messages: [] }), /bad request/);
    assert.deepEqual(calls, ['groq:a']);
  });

  test('si todos fallan lanza el último error', async () => {
    fake('groq', (p) => {
      throw p.model === 'c' ? server(503) : quota('sin cupo');
    });
    await assert.rejects(router.runChain(chain, 'mention', { messages: [] }), /503/);
    assert.deepEqual(calls, ['groq:a', 'groq:b', 'groq:c']);
  });

  test('429 por minuto bloquea 1 min; retry-after manda; el tope es 30 min', () => {
    const l = chainOf('groq:a')[0];
    assert.equal(router.blockDuration(l, quota(), 0), 60000);
    assert.equal(router.blockDuration(l, quota('x', 90), 0), 90000);
    assert.equal(router.blockDuration(l, quota('tokens per day (TPD)', 7200), 0), 30 * 60 * 1000);
  });

  test('el último eslabón no espera un 429 si el retry-after supera maxDelayMs', async () => {
    fake('groq', () => {
      throw quota('x', 20);
    });
    const t0 = Date.now();
    await assert.rejects(
      router.runChain(chainOf('groq:a'), 'mention', { messages: [] }, { maxRetries: 2, maxDelayMs: 3000 }),
      /x/,
    );
    assert.equal(calls.length, 1);
    assert.ok(Date.now() - t0 < 1000);
  });

  test('el uso de un eslabón de reserva se cuenta; el del primero no', async () => {
    fake('groq', (p) => {
      if (p.model === 'a') throw quota();
      return ok();
    });
    await router.runChain(chain, 'mention', { messages: [] });
    assert.deepEqual(state.getGroqFallbackUse(), { 'groq:a→groq:b': 1 });
  });

  test('limpia <think> de las respuestas de Groq', async () => {
    fake('groq', () => ({ choices: [{ message: { content: '<think>x</think>Hola chat' } }] }));
    const r = await router.runChain(chainOf('groq:a'), 'mention', { messages: [] });
    assert.equal(r.choices[0].message.content, 'Hola chat');
  });

  test('gpt-oss recibe reasoning_effort y margen; el resto no', async () => {
    const seen = {};
    fake('groq', (p) => {
      seen[p.model] = p;
      return ok();
    });
    await router.runChain(chainOf('groq:openai/gpt-oss-120b'), 'mention', { messages: [], max_tokens: 100 });
    await router.runChain(chainOf('groq:plain'), 'mention', { messages: [], max_tokens: 100, reasoning_effort: 'low' });
    assert.equal(seen['openai/gpt-oss-120b'].reasoning_effort, 'low');
    assert.equal(seen['openai/gpt-oss-120b'].max_tokens, 164);
    assert.equal('reasoning_effort' in seen.plain, false);
    assert.equal(seen.plain.max_tokens, 100);
  });
});

describe('contadores y presupuesto', () => {
  test('Groq: salta antes del 429 si la ventana de 60 s no deja hueco', () => {
    const l = chainOf('groq:a')[0];
    const now = Date.now();
    state.startAiRequest('groq', 'a', 6500, now);
    assert.equal(router.overBudget(l, 500, now), true); // 6500 + 500 > 85 % de 8000
    assert.equal(router.overBudget(l, 100, now), false);
    assert.equal(router.overBudget(l, 500, now + 61000), false); // la ventana caduca
  });

  test('orderChain deja al final los sin presupuesto y los bloqueados', () => {
    const chain = chainOf('groq:a,groq:b,groq:c');
    state.startAiRequest('groq', 'a', 7000);
    state.blockAi('groq:b', Date.now() + 60000);
    assert.deepEqual(
      router.orderChain(chain, 300).map((l) => l.model),
      ['c', 'a', 'b'],
    );
  });

  test('el día de uso cambia a las 00:00 UTC', () => {
    assert.notEqual(
      state.aiDayKey('groq', Date.UTC(2026, 10, 3, 23, 59)),
      state.aiDayKey('groq', Date.UTC(2026, 10, 4, 0, 1)),
    );
    assert.equal(state.aiDayKey('groq', Date.UTC(2026, 10, 3, 0, 1)), '2026-11-03');
  });

  test('startAiRequest/finishAiRequest suman peticiones y tokens por clave', () => {
    const h = state.startAiRequest('groq', 'g', 100);
    state.finishAiRequest(h, { prompt_tokens: 40, completion_tokens: 10 });
    const u = state.getAiUsage()['groq:g'];
    assert.equal(u.stream.requests, 1);
    assert.equal(u.stream.tokens, 50);
    assert.ok(u.day.requests >= 1);
    assert.equal(state.getAiMinuteUsage('groq:g').tokens, 50);
  });

  test('formatAiUsage muestra las peticiones por modelo', () => {
    const txt = formatAiUsage({ 'groq:a': { stream: { requests: 3 }, day: { requests: 4 } } });
    assert.match(txt, /groq:a: 3 este stream, 4 hoy$/);
  });
});

describe('seudonimización hacia Groq', () => {
  test('los nicks salen seudonimizados y vuelven restaurados', async () => {
    state.noteChatter('Mujica90_');
    let sent;
    router.setTransport('groq', async (p) => {
      sent = JSON.stringify(p.messages);
      return { choices: [{ message: { content: 'Qué tal user1, bien jugado' } }] };
    });
    const r = await router.runChain(chainOf('groq:a'), 'cohost', {
      messages: [{ role: 'user', content: 'Mujica90_: hola' }],
    });
    assert.doesNotMatch(sent, /Mujica90_/);
    assert.match(sent, /user1/);
    assert.equal(r.choices[0].message.content, 'Qué tal Mujica90_, bien jugado');
  });

  test('los nicks pasados en opts.names también se seudonimizan', async () => {
    let sent;
    router.setTransport('groq', async (p) => {
      sent = JSON.stringify(p.messages);
      return ok();
    });
    await router.runChain(
      chainOf('groq:a'),
      'mention',
      { messages: [{ role: 'user', content: 'Hola Zorrito77' }] },
      { names: ['Zorrito77'] },
    );
    assert.doesNotMatch(sent, /Zorrito77/);
  });
});

describe('seudonimización', () => {
  const msgs = [
    { role: 'system', content: 'Habla con @Ana_99 y ana_99, no con Pedro.' },
    { role: 'user', content: 'Pedro: hola @ana_99!' },
  ];
  const none = { exclude: new Set() };

  test('mismo nick = mismo alias (sin importar mayúsculas) y se respeta la @', () => {
    const { messages, map } = pseudonymize(msgs, ['Ana_99', 'Pedro'], none);
    assert.equal(messages[0].content, 'Habla con @user1 y user1, no con user2.');
    assert.equal(messages[1].content, 'user2: hola @user1!');
    assert.equal(restoreText('Hola @user1 y user2', map), 'Hola @Ana_99 y Pedro');
  });

  test('solo sustituye palabras enteras', () => {
    const { messages } = pseudonymize([{ role: 'user', content: 'Pedrito y Pedro_2 no son Pedro' }], ['Pedro'], none);
    assert.equal(messages[0].content, 'Pedrito y Pedro_2 no son user1');
  });

  test('streamers, bot, creador y nicks cortos no se seudonimizan', () => {
    const { map } = pseudonymize(
      [{ role: 'user', content: 'ParLusorum vlxj97 al xo' }],
      ['ParLusorum', 'vlxj97', 'al', 'xo'],
    );
    assert.equal(map, null);
  });

  test('un alias que el modelo inventa y no está en el mapa se deja tal cual', () => {
    const { map } = pseudonymize(msgs, ['Ana_99'], none);
    assert.equal(restoreText('user7 y user1', map), 'user7 y Ana_99');
  });

  test('restoreResult restaura el contenido', () => {
    const { map } = pseudonymize(msgs, ['Pedro'], none);
    const r = restoreResult({ choices: [{ message: { content: 'ok user1' } }] }, map);
    assert.equal(r.choices[0].message.content, 'ok Pedro');
  });

  test('el feedback de rechazo con el nick también va seudonimizado', () => {
    const { messages } = pseudonymize(
      [{ role: 'system', content: 'NO nombres a Pedro (ya nombrado)' }],
      ['Pedro'],
      none,
    );
    assert.doesNotMatch(messages[0].content, /Pedro/);
  });
});
