// 16-11: un reinicio a mitad de directo puso a cero los contadores del stream y el consumo de Groq del día
// (el resumen dio 2 comentarios y 3 llamadas al 120b cuando hubo ~20). Ahora se guardan en bot_state y se fusionan al arrancar.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const state = require('../src/utils/state');
const metrics = require('../src/utils/metrics');
const { buildSnapshot, restorableState, restorableGroqDay } = require('../src/utils/bot-state');
const { formatCohostStats } = require('../src/eventsub');

const START = 1_700_000_000_000;
const NOW = Date.UTC(2026, 10, 16, 21, 29);
const DAY = '2026-11-16';

function clearAll() {
  state.resetCohostStats();
  state.resetGroqFallbackUse();
  state.resetGroqTokenUse();
  state.resetFilterStats();
  state.resetAiUsage();
  state.resetBotHistory();
  metrics.resetStreamMetrics();
}

// Rellena como lo haría un directo de verdad
function simulateStream() {
  for (let i = 0; i < 9; i++) state.recordCohostAttempt('free');
  for (let i = 0; i < 6; i++) state.recordCohostSent('free');
  state.recordCohostAttempt('event');
  state.recordCohostSent('event');
  state.recordGroq429();
  state.recordCohostDiscard('quality:tiempo');
  state.recordCohostDiscard('quality:tiempo');
  state.recordGroqFallback('openai/gpt-oss-120b', 'openai/gpt-oss-20b');
  state.recordFilterSent('mencion');
  state.recordFilterDiscard('mencion', 'cifra_caidas');
  for (let i = 0; i < 4; i++) {
    const h = state.startAiRequest('groq', 'openai/gpt-oss-120b', 500, NOW);
    state.finishAiRequest(h, { prompt_tokens: 400, completion_tokens: 100 });
    state.recordGroqTokens('openai/gpt-oss-120b', { prompt_tokens: 400, completion_tokens: 100 }, NOW);
  }
  state.markFactUse('chat_risas', NOW - 60_000);
  state.markFactUse('pregunta', NOW - 30_000);
  state.markStructure('estructura-a');
  state.recordCohost(NOW - 10_000);
  metrics.updatePeakViewers(42);
  metrics.trackMessage();
  metrics.trackMessage();
  metrics.trackCommand('redes');
}

function snapshot(extra = {}) {
  return buildSnapshot(
    {
      live: true,
      streamStartedAt: START,
      deaths: 8,
      bosses: 2,
      counters: { ...state.exportStreamCounters(), metrics: metrics.exportMetrics() },
      restarts: 0,
      groqDay: state.exportGroqDay(NOW),
      ...extra,
    },
    NOW,
  );
}

describe('contadores del stream en el snapshot', () => {
  beforeEach(clearAll);

  test('ida y vuelta: tras un reinicio (memoria a cero) se recupera todo', () => {
    simulateStream();
    const saved = JSON.parse(JSON.stringify(snapshot())); // pasa por Supabase como JSON
    const before = state.getCohostStats();
    const beforeFilters = state.getFilterStats();
    const beforeAi = state.getAiUsage(NOW);
    const beforeTokens = state.getGroqTokenUse();
    const beforeMetrics = metrics.exportMetrics();

    clearAll(); // reinicio: proceso nuevo, todo a cero
    assert.equal(state.getCohostStats().attempts.free, 0);

    const r = restorableState(saved, { live: true, streamStartedAt: START + 500 }, NOW);
    assert.ok(r.counters);
    const merged = state.mergeStreamCounters(r.counters, NOW) + metrics.mergeMetrics(r.counters.metrics);
    assert.ok(merged > 10, `recuperó ${merged}`);

    const after = state.getCohostStats();
    assert.deepEqual(after.attempts, before.attempts);
    assert.deepEqual(after.sent, before.sent);
    assert.deepEqual(after.discards, before.discards);
    assert.equal(after.groq429, 1);
    assert.deepEqual(state.getGroqFallbackUse(), { 'openai/gpt-oss-120b→openai/gpt-oss-20b': 1 });
    assert.deepEqual(state.getFilterStats(), beforeFilters);
    assert.deepEqual(
      state.getAiUsage(NOW)['groq:openai/gpt-oss-120b'].stream,
      beforeAi['groq:openai/gpt-oss-120b'].stream,
    );
    assert.equal(
      state.getGroqTokenUse().stream['openai/gpt-oss-120b'].total,
      beforeTokens.stream['openai/gpt-oss-120b'].total,
    );
    assert.deepEqual(metrics.exportMetrics(), beforeMetrics);
  });

  test('el control de repetición (factUse, estructuras, hora del cohost) también se recupera', () => {
    simulateStream();
    const saved = JSON.parse(JSON.stringify(snapshot()));
    clearAll();
    state.mergeStreamCounters(saved.counters, NOW);
    assert.equal(state.getFactUse('chat_risas').count, 1);
    assert.equal(state.getFactUse('chat_risas').at, NOW - 60_000);
    assert.equal(state.getFactUse('pregunta').count, 1);
    assert.deepEqual([...state.getUsedStructures()], ['estructura-a']);
  });

  test('las horas del cohost de la última hora se fusionan, sin duplicar ni aceptar futuras o basura', () => {
    const before = state.getCohostTimes();
    const t1 = NOW - 20_000;
    const t2 = NOW - 5_000;
    const fresh = [t1, t2].filter((t) => !before.includes(t));
    state.mergeStreamCounters(
      { cohostTimes: [t1, t2, t2, 'a', NOW + 99_999_999, NOW - 2 * 3_600_000], lastCohostTime: t2 },
      NOW,
    );
    const after = state.getCohostTimes();
    assert.ok(after.includes(t1) && after.includes(t2));
    assert.equal(after.length, before.length + fresh.length);
    assert.ok(!after.includes(NOW + 99_999_999));
    assert.ok(!after.includes(NOW - 2 * 3_600_000)); // más de una hora: caducada
    assert.ok(state.getLastCohostTime() >= t2);
  });

  test('fusionar dos veces no duplica (gana el mayor valor)', () => {
    simulateStream();
    const saved = JSON.parse(JSON.stringify(snapshot()));
    clearAll();
    state.mergeStreamCounters(saved.counters, NOW);
    state.mergeStreamCounters(saved.counters, NOW);
    assert.equal(state.getCohostStats().attempts.free, 9);
    assert.equal(state.getFactUse('pregunta').count, 1);
    assert.equal(state.mergeStreamCounters(saved.counters, NOW), 0);
  });

  test('lo contado entre el arranque y la restauración se conserva si es mayor', () => {
    simulateStream();
    const saved = JSON.parse(JSON.stringify(snapshot()));
    clearAll();
    for (let i = 0; i < 12; i++) state.recordCohostAttempt('free');
    state.mergeStreamCounters(saved.counters, NOW);
    assert.equal(state.getCohostStats().attempts.free, 12);
  });

  test('se descarta si cambia el directo o si no hay directo', () => {
    simulateStream();
    const saved = snapshot();
    assert.equal(restorableState(saved, { live: true, streamStartedAt: START + 3_600_000 }, NOW), null);
    assert.equal(restorableState(saved, { live: false, streamStartedAt: START }, NOW), null);
  });

  test('sin directo el snapshot no arrastra contadores del stream, pero sí el consumo diario', () => {
    simulateStream();
    const snap = snapshot({ live: false });
    assert.equal(snap.live, false);
    assert.equal(snap.counters, undefined);
    assert.equal(snap.restarts, undefined);
    assert.ok(snap.groqDay);
    assert.equal(snap.groqDay.dayKey, DAY);
  });

  test('un snapshot antiguo sin los campos nuevos sigue valiendo', () => {
    const old = { v: 1, live: true, streamStartedAt: START, silenced: false, deaths: 5, bosses: 1, savedAt: NOW };
    const r = restorableState(old, { live: true, streamStartedAt: START }, NOW);
    assert.equal(r.deaths, 5);
    assert.equal(r.counters, null);
    assert.equal(r.restarts, 0);
    assert.equal(state.mergeStreamCounters(r.counters, NOW), 0);
    assert.equal(restorableGroqDay(old, NOW), null);
  });

  test('valores corruptos no rompen ni contaminan', () => {
    const timesBefore = state.getCohostTimes();
    const n = state.mergeStreamCounters(
      {
        cohost: {
          attempts: { event: -4, free: 'x' },
          sent: null,
          groq429: NaN,
          discards: { 'quality:tiempo': 'mucho' },
        },
        fallback: [1, 2],
        filters: { sent: 7, discards: { cohost: 'x' } },
        ai: { 'groq:m': { requests: -1, prompt: 'a' } },
        factUse: { pregunta: { at: 'ayer', count: -2 } },
        structures: [1, null, ''],
        cohostTimes: ['a', NOW + 99_999_999],
      },
      NOW,
    );
    assert.equal(n, 0);
    assert.equal(state.getCohostStats().attempts.event, 0);
    assert.equal(state.getFactUse('pregunta').count, 0);
    assert.deepEqual(state.getCohostTimes(), timesBefore);
    assert.equal(state.mergeStreamCounters(null), 0);
    assert.equal(state.mergeStreamCounters('x'), 0);
  });

  test('no se guarda ningún dato por usuario ni texto: solo cifras y claves de tipo', () => {
    simulateStream();
    const json = JSON.stringify(snapshot());
    assert.doesNotMatch(json, /user_id|username|nick|@/);
  });
});

describe('consumo diario de Groq', () => {
  beforeEach(clearAll);

  test('se restaura si es del mismo día UTC', () => {
    simulateStream();
    const saved = JSON.parse(JSON.stringify(snapshot({ live: false })));
    const dayBefore = state.getAiDayUsage('groq:openai/gpt-oss-120b', NOW);
    const tokensBefore = state.getGroqTokenUse().day['openai/gpt-oss-120b'].total;
    clearAll();
    assert.equal(state.getAiDayUsage('groq:openai/gpt-oss-120b', NOW).requests, 0);

    const day = restorableGroqDay(saved, NOW);
    assert.ok(day);
    assert.ok(state.mergeGroqDay(day, NOW) > 0);
    assert.deepEqual(state.getAiDayUsage('groq:openai/gpt-oss-120b', NOW), dayBefore);
    assert.equal(dayBefore.requests, 4);
    assert.equal(state.getGroqTokenUse().day['openai/gpt-oss-120b'].total, tokensBefore);
  });

  test('un consumo de otro día UTC se descarta', () => {
    simulateStream();
    const saved = JSON.parse(JSON.stringify(snapshot({ live: false })));
    const nextDay = Date.UTC(2026, 10, 17, 0, 5);
    assert.equal(restorableGroqDay(saved, nextDay), null);
    assert.equal(state.mergeGroqDay(saved.groqDay, nextDay), 0);
  });

  test('restaurar dos veces no duplica y lo ya gastado después del arranque no se pierde', () => {
    simulateStream();
    const saved = JSON.parse(JSON.stringify(snapshot({ live: false })));
    clearAll();
    for (let i = 0; i < 6; i++) state.startAiRequest('groq', 'openai/gpt-oss-120b', 100, NOW);
    state.mergeGroqDay(saved.groqDay, NOW);
    state.mergeGroqDay(saved.groqDay, NOW);
    assert.equal(state.getAiDayUsage('groq:openai/gpt-oss-120b', NOW).requests, 6);
  });
});

describe('reinicios en el resumen de fin de stream', () => {
  beforeEach(clearAll);

  test('el contador de reinicios entra en las estadísticas y en la línea del resumen', () => {
    assert.equal(state.getCohostStats().restarts, 0);
    assert.doesNotMatch(formatCohostStats(state.getCohostStats()), /reinicios/);
    state.setStreamRestarts(2);
    assert.equal(state.getCohostStats().restarts, 2);
    assert.match(formatCohostStats(state.getCohostStats()), /reinicios del bot con el directo en curso: 2/);
    state.resetCohostStats();
    assert.equal(state.getStreamRestarts(), 0);
  });

  test('el snapshot guarda los reinicios y los valores raros se sanean', () => {
    assert.equal(snapshot({ restarts: 3 }).restarts, 3);
    assert.equal(snapshot({ restarts: -1 }).restarts, 0);
    state.setStreamRestarts(-5);
    assert.equal(state.getStreamRestarts(), 0);
  });
});

describe('métricas del chat', () => {
  beforeEach(clearAll);

  test('merge de métricas: gana el mayor y descarta comandos con nombres raros', () => {
    metrics.updatePeakViewers(10);
    const n = metrics.mergeMetrics({
      peakViewers: 30,
      messages: 500,
      commands: { redes: 4, 'comando con espacios muy largo y raro que no es nombre': 9, '!!': 3 },
    });
    assert.equal(n, 3);
    const out = metrics.exportMetrics();
    assert.equal(out.peakViewers, 30);
    assert.equal(out.messages, 500);
    assert.deepEqual(out.commands, { redes: 4 });
    assert.equal(metrics.mergeMetrics({ peakViewers: 5 }), 0);
    assert.equal(metrics.mergeMetrics(null), 0);
  });
});
