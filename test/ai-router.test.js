process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const router = require('../src/utils/ai-router');
const state = require('../src/utils/state');
const gemini = require('../src/utils/ai-gemini');
const { pseudonymize, restoreText, restoreResult } = require('../src/utils/ai-pseudonym');
const { isModelGone } = require('../src/utils/groq-utils');
const { formatAiUsage } = require('../src/eventsub');

const gone = () => Object.assign(new Error('404 model_not_found'), { status: 404 });
const quota = (msg = 'Rate limit reached: tokens per minute (TPM)', retryAfter) =>
  Object.assign(new Error(msg), { status: 429, headers: retryAfter ? { 'retry-after': String(retryAfter) } : {} });
const server = status => Object.assign(new Error(`HTTP ${status}`), { status });
const chainOf = text => router.parseChain(text);
const ok = () => ({ choices: [{ message: { content: 'hola' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

let calls;
function fake(provider, handler) {
  router.setTransport(provider, async p => { calls.push(`${provider}:${p.model}`); return handler(p); });
}
beforeEach(() => { calls = []; state.resetAiBlocks(); state.resetAiUsage(); state.resetChatters(); state.resetGroqFallbackUse(); });
afterEach(() => { delete process.env.GEMINI_API_KEY; for (const k of Object.keys(process.env)) if (k.startsWith('AI_CHAIN_')) delete process.env[k]; });

describe('cadenas por tipo de llamada', () => {
  test('parseChain lee proveedor:modelo y descarta eslabones no válidos', () => {
    assert.deepEqual(chainOf('groq:openai/gpt-oss-120b, gemini:gemini-3.5-flash-lite, x:foo, groq:').map(l => l.key), ['groq:openai/gpt-oss-120b', 'gemini:gemini-3.5-flash-lite']);
  });

  test('sin GEMINI_API_KEY el cohost va solo por Groq', () => {
    assert.ok(router.getChain('cohost').every(l => l.provider === 'groq'));
  });

  test('con clave: cohost, timer, hook, alert, reaction y endstream empiezan por Gemini', () => {
    process.env.GEMINI_API_KEY = 'k';
    for (const k of ['cohost', 'timer', 'hook', 'alert', 'reaction', 'endstream']) {
      assert.equal(router.getChain(k)[0].provider, 'gemini', k);
      assert.equal(router.getChain(k).at(-1).provider, 'groq', k);
    }
  });

  test('menciones, !dios_fua, trivia, !quemeperdi y comandos nunca van a Gemini', () => {
    process.env.GEMINI_API_KEY = 'k';
    for (const k of ['mention', 'provocation', 'diosfua', 'trivia', 'quemeperdi', 'command']) {
      assert.ok(router.getChain(k).every(l => l.provider === 'groq'), k);
    }
  });

  test('las revisiones empiezan por el modelo rápido de Groq y Gemini queda de último', () => {
    process.env.GEMINI_API_KEY = 'k';
    const c = router.getChain('review');
    assert.match(c[0].model, /gpt-oss-20b/);
    assert.equal(c.at(-1).provider, 'gemini');
  });

  test('AI_CHAIN_<TIPO> manda sobre el defecto; un tipo desconocido lanza', () => {
    process.env.AI_CHAIN_HOOK = 'groq:solo-este';
    assert.deepEqual(router.getChain('hook').map(l => l.model), ['solo-este']);
    assert.throws(() => router.getChain('nada'), /desconocido/);
  });
});

describe('salto de eslabón y bloqueos', () => {
  const chain = chainOf('groq:a,groq:b,gemini:g');
  beforeEach(() => { process.env.GEMINI_API_KEY = 'k'; });

  test('un 429 salta al siguiente sin esperar y bloquea el agotado', async () => {
    fake('groq', p => { if (p.model === 'a') throw quota(); return ok(); });
    fake('gemini', () => ok());
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
      fake('groq', p => { if (p.model === 'a') throw server(status); return ok(); });
      await router.runChain(chain, 'cohost', { messages: [] });
      assert.deepEqual(calls, ['groq:a', 'groq:b']);
      const left = state.aiBlockedUntil('groq:a') - Date.now();
      assert.ok(left > 60 * 1000 && left <= 5 * 60 * 1000);
    });
  }

  test('un timeout salta de modelo y bloquea', async () => {
    fake('groq', p => { if (p.model === 'a') throw Object.assign(new Error('Request timed out.'), { code: 'ETIMEDOUT' }); return ok(); });
    await router.runChain(chain, 'cohost', { messages: [] });
    assert.deepEqual(calls, ['groq:a', 'groq:b']);
    assert.ok(state.isAiBlocked('groq:a'));
  });

  test('modelo retirado (404) salta al siguiente', async () => {
    fake('groq', p => { if (p.model === 'a') throw gone(); return ok(); });
    await router.runChain(chain, 'mention', { messages: [] });
    assert.deepEqual(calls, ['groq:a', 'groq:b']);
    assert.ok(isModelGone(gone()));
  });

  test('un 400 no salta de modelo', async () => {
    fake('groq', () => { throw Object.assign(new Error('bad request'), { status: 400 }); });
    await assert.rejects(router.runChain(chain, 'mention', { messages: [] }), /bad request/);
    assert.deepEqual(calls, ['groq:a']);
  });

  test('si todos fallan lanza el último error', async () => {
    fake('groq', () => { throw quota('sin cupo'); });
    fake('gemini', () => { throw server(503); });
    await assert.rejects(router.runChain(chain, 'mention', { messages: [] }), /503/);
    assert.deepEqual(calls, ['groq:a', 'groq:b', 'gemini:g']);
  });

  test('429 diario de Gemini bloquea hasta la medianoche del Pacífico', () => {
    const l = chainOf('gemini:g')[0];
    const now = Date.UTC(2026, 10, 3, 20, 0, 0);
    const ms = router.blockDuration(l, quota('Quota exceeded: RequestsPerDay limit 500'), now);
    assert.equal(ms, state.msUntilPacificMidnight(now) + 60000);
    assert.ok(ms > 60 * 60 * 1000);
  });

  test('429 por minuto bloquea 1 min; retry-after manda; el tope es 30 min', () => {
    const l = chainOf('groq:a')[0];
    assert.equal(router.blockDuration(l, quota(), 0), 60000);
    assert.equal(router.blockDuration(l, quota('x', 90), 0), 90000);
    assert.equal(router.blockDuration(l, quota('tokens per day (TPD)', 7200), 0), 30 * 60 * 1000);
  });

  test('el último eslabón no espera un 429 si el retry-after supera maxDelayMs', async () => {
    fake('groq', () => { throw quota('x', 20); });
    const t0 = Date.now();
    await assert.rejects(router.runChain(chainOf('groq:a'), 'mention', { messages: [] }, { maxRetries: 2, maxDelayMs: 3000 }), /x/);
    assert.equal(calls.length, 1);
    assert.ok(Date.now() - t0 < 1000);
  });

  test('el uso de un eslabón de reserva se cuenta; el del primero no', async () => {
    fake('groq', p => { if (p.model === 'a') throw quota(); return ok(); });
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
    fake('groq', p => { seen[p.model] = p; return ok(); });
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
    assert.equal(router.overBudget(l, 500, now), true);   // 6500 + 500 > 85 % de 8000
    assert.equal(router.overBudget(l, 100, now), false);
    assert.equal(router.overBudget(l, 500, now + 61000), false); // la ventana caduca
  });

  test('orderChain deja al final los sin presupuesto y los bloqueados', () => {
    const chain = chainOf('groq:a,groq:b,groq:c');
    state.startAiRequest('groq', 'a', 7000);
    state.blockAi('groq:b', Date.now() + 60000);
    assert.deepEqual(router.orderChain(chain, 300).map(l => l.model), ['c', 'a', 'b']);
  });

  test('Gemini: salta a Groq al llegar a ~450 peticiones del día del Pacífico', () => {
    const l = chainOf('gemini:g')[0];
    const now = Date.UTC(2026, 10, 3, 18, 0, 0);
    for (let i = 0; i < 449; i++) state.startAiRequest('gemini', 'g', 0, now - 120000);
    assert.equal(router.overBudget(l, 0, now), false);
    state.startAiRequest('gemini', 'g', 0, now - 120000);
    assert.equal(router.overBudget(l, 0, now), true);
  });

  test('el día de Gemini cambia a medianoche del Pacífico (09:00 en España), el de Groq a las 00:00 UTC', () => {
    const before = Date.UTC(2026, 10, 3, 7, 59); // 23:59 del día 2 en el Pacífico
    const after = Date.UTC(2026, 10, 3, 8, 1);
    assert.notEqual(state.aiDayKey('gemini', before), state.aiDayKey('gemini', after));
    assert.equal(state.aiDayKey('groq', before), state.aiDayKey('groq', after));
  });

  test('el cambio de horario del 1-11-2026 no rompe la clave del día', () => {
    assert.equal(state.aiDayKey('gemini', Date.UTC(2026, 10, 1, 9, 30)), '2026-11-01');
    assert.equal(state.aiDayKey('gemini', Date.UTC(2026, 10, 1, 6, 30)), '2026-10-31');
  });

  test('startAiRequest/finishAiRequest suman peticiones y tokens por clave', () => {
    const h = state.startAiRequest('gemini', 'g', 100);
    state.finishAiRequest(h, { prompt_tokens: 40, completion_tokens: 10 });
    const u = state.getAiUsage()['gemini:g'];
    assert.equal(u.stream.requests, 1);
    assert.equal(u.stream.tokens, 50);
    assert.ok(u.day.requests >= 1);
    assert.equal(state.getAiMinuteUsage('gemini:g').tokens, 50);
  });

  test('formatAiUsage muestra el % del RPD solo para Gemini', () => {
    const txt = formatAiUsage({ 'gemini:g': { stream: { requests: 50 }, day: { requests: 100 } }, 'groq:a': { stream: { requests: 3 }, day: { requests: 4 } } }, 500);
    assert.match(txt, /gemini:g: 50 este stream, 100 hoy \(20% de 500\)/);
    assert.match(txt, /groq:a: 3 este stream, 4 hoy$/);
  });
});

describe('adaptador de Gemini', () => {
  test('quita las penalties, fuerza reasoning_effort low (nunca none) y suma margen', () => {
    const b = gemini.buildBody({ messages: [{ role: 'user', content: 'x' }], max_tokens: 90, frequency_penalty: 0.8, presence_penalty: 0.6, reasoning_effort: 'none', temperature: 0.4 }, 'gemini-3.5-flash-lite');
    assert.equal('frequency_penalty' in b, false);
    assert.equal('presence_penalty' in b, false);
    assert.equal(b.reasoning_effort, 'low');
    assert.equal(b.max_tokens, 154);
    assert.equal(b.temperature, 0.4);
  });

  test('Gemma: sin reasoning_effort y +700 de margen', () => {
    const b = gemini.buildBody({ messages: [], max_tokens: 90 }, 'gemma-4-31b-it');
    assert.equal('reasoning_effort' in b, false);
    assert.equal(b.max_tokens, 790);
  });

  test('limpia campos de Groq de los mensajes y deja el assistant sin texto en ""', () => {
    const b = gemini.buildBody({ messages: [{ role: 'assistant', content: null, reasoning: 'x', executed_tools: [], tool_calls: [{ id: '1' }] }] }, 'm');
    assert.deepEqual(b.messages[0], { role: 'assistant', content: '', tool_calls: [{ id: '1' }] });
  });

  test('stripThought quita <thought> completo o sin abrir', () => {
    assert.equal(gemini.stripThought({ choices: [{ message: { content: '<thought>a\nb</thought>Hola' } }] }).choices[0].message.content, 'Hola');
    assert.equal(gemini.stripThought({ choices: [{ message: { content: 'razono…</thought>Hola' } }] }).choices[0].message.content, 'Hola');
  });

  test('create: errores HTTP llevan status y retry-after; el timeout lleva ETIMEDOUT', async () => {
    const res = (status, body, headers = {}) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), headers: { get: k => headers[k] ?? null } });
    await assert.rejects(gemini.create({}, { fetchImpl: async () => res(429, { error: { message: 'quota' } }, { 'retry-after': '7' }), apiKey: 'k' }), e => e.status === 429 && e.headers['retry-after'] === '7' && /quota/.test(e.message));
    await assert.rejects(gemini.create({}, { fetchImpl: async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); }, apiKey: 'k' }), e => e.code === 'ETIMEDOUT');
    const r = await gemini.create({}, { fetchImpl: async () => res(200, { choices: [{ message: { content: '<thought>x</thought>ok' } }] }), apiKey: 'k' });
    assert.equal(r.choices[0].message.content, 'ok');
  });

  test('con Gemini en la cadena, los nicks salen seudonimizados y vuelven restaurados', async () => {
    process.env.GEMINI_API_KEY = 'k';
    state.noteChatter('Mujica90_');
    let sent;
    router.setTransport('gemini', async p => { sent = JSON.stringify(p.messages); return { choices: [{ message: { content: 'Qué tal user1, bien jugado' } }] }; });
    const r = await router.runChain(chainOf('gemini:g'), 'cohost', { messages: [{ role: 'user', content: 'Mujica90_: hola' }] });
    assert.doesNotMatch(sent, /Mujica90_/);
    assert.match(sent, /user1/);
    assert.equal(r.choices[0].message.content, 'Qué tal Mujica90_, bien jugado');
  });

  test('con Groq los nicks no se tocan', async () => {
    state.noteChatter('Mujica90_');
    let sent;
    router.setTransport('groq', async p => { sent = JSON.stringify(p.messages); return ok(); });
    await router.runChain(chainOf('groq:a'), 'mention', { messages: [{ role: 'user', content: 'Mujica90_: hola' }] });
    assert.match(sent, /Mujica90_/);
  });
});

describe('seudonimización', () => {
  const msgs = [{ role: 'system', content: 'Habla con @Ana_99 y ana_99, no con Pedro.' }, { role: 'user', content: 'Pedro: hola @ana_99!' }];
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
    const { map } = pseudonymize([{ role: 'user', content: 'ParLusorum vlxj97 al xo' }], ['ParLusorum', 'vlxj97', 'al', 'xo']);
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
    const { messages } = pseudonymize([{ role: 'system', content: 'NO nombres a Pedro (ya nombrado)' }], ['Pedro'], none);
    assert.doesNotMatch(messages[0].content, /Pedro/);
  });
});
