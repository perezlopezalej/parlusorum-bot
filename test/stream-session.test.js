const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  decideStreamTransition,
  liveMinutes,
  closingPlan,
  rejoinMs,
  sanitizePendingEnd,
  endGraceUntil,
  END_GRACE_MS,
} = require('../src/utils/stream-session');
const { checkOutbound } = require('../src/utils/output-guard');
const { buildSnapshot } = require('../src/utils/bot-state');

const MIN = 60 * 1000;

describe('decideStreamTransition', () => {
  it('sin corte pendiente, directo nuevo', () => {
    assert.equal(decideStreamTransition({ pendingEnd: null, now: 1000 }), 'new');
  });
  it('dentro de la ventana es el mismo directo', () => {
    assert.equal(decideStreamTransition({ pendingEnd: { endedAt: 0 }, now: 3 * MIN, rejoinMs: 15 * MIN }), 'rejoin');
  });
  it('fuera de la ventana es un directo nuevo', () => {
    assert.equal(decideStreamTransition({ pendingEnd: { endedAt: 0 }, now: 16 * MIN, rejoinMs: 15 * MIN }), 'new');
  });
  it('rejoinMs usa STREAM_REJOIN_MS o 15 min', () => {
    assert.equal(rejoinMs({}), 15 * MIN);
    assert.equal(rejoinMs({ STREAM_REJOIN_MS: '60000' }), MIN);
    assert.equal(rejoinMs({ STREAM_REJOIN_MS: 'x' }), 15 * MIN);
  });
});

describe('liveMinutes y closingPlan', () => {
  it('descuenta los huecos de los cortes', () => {
    assert.equal(liveMinutes({ startedAt: 0, endedAt: 60 * MIN, gapMs: 10 * MIN }), 50);
  });
  it('datos inválidos dan 0', () => {
    assert.equal(liveMinutes({ startedAt: null, endedAt: 5 }), 0);
    assert.equal(liveMinutes({ startedAt: 10, endedAt: 5 }), 0);
  });
  it('menos de 5 min: nada; menos de 20: despedida; resto: resumen', () => {
    assert.equal(closingPlan(0), 'nada');
    assert.equal(closingPlan(4), 'nada');
    assert.equal(closingPlan(5), 'despedida');
    assert.equal(closingPlan(19), 'despedida');
    assert.equal(closingPlan(20), 'resumen');
    assert.equal(closingPlan(NaN), 'nada');
  });
});

describe('secuencia real del 13-11 (corte repetido)', () => {
  // Réplica pura de la lógica de eventsub: on / off / on / off / on, y cierre al vencer la ventana
  function simulate(events, closeAt) {
    let pending = null;
    let startedAt = null;
    let gapMs = 0;
    const log = { starts: 0, summaries: 0, plans: [] };
    for (const [type, at] of events) {
      if (type === 'on') {
        if (pending && decideStreamTransition({ pendingEnd: pending, now: at }) === 'rejoin') {
          gapMs = pending.gapMs + (at - pending.endedAt);
          startedAt = pending.startedAt;
          pending = null;
        } else {
          log.starts++;
          startedAt = at;
          gapMs = 0;
        }
      } else if (!pending) {
        pending = { endedAt: at, startedAt, gapMs };
        startedAt = null;
      }
    }
    if (pending && decideStreamTransition({ pendingEnd: pending, now: closeAt }) === 'new') {
      const minutes = liveMinutes(pending);
      log.plans.push(closingPlan(minutes));
      if (closingPlan(minutes) === 'resumen') log.summaries++;
      log.minutes = minutes;
    }
    return log;
  }

  it('cinco eventos en 17 min: un aviso de inicio y ningún resumen', () => {
    const r = simulate(
      [
        ['on', 0],
        ['off', 5 * MIN],
        ['on', 8 * MIN],
        ['off', 16 * MIN],
        ['on', 17 * MIN],
        ['off', 18 * MIN],
      ],
      40 * MIN,
    );
    assert.equal(r.starts, 1);
    assert.equal(r.summaries, 0);
    assert.deepEqual(r.plans, ['despedida']);
    assert.equal(r.minutes, 14); // 18 min menos 4 de cortes (3 + 1)
  });
  it('un directo largo con un corte sí tiene resumen, con los minutos reales', () => {
    const r = simulate(
      [
        ['on', 0],
        ['off', 60 * MIN],
        ['on', 62 * MIN],
        ['off', 120 * MIN],
      ],
      150 * MIN,
    );
    assert.equal(r.starts, 1);
    assert.deepEqual(r.plans, ['resumen']);
    assert.equal(r.minutes, 118);
  });
});

describe('estado guardado del corte', () => {
  it('sanitizePendingEnd descarta datos incompletos', () => {
    assert.equal(sanitizePendingEnd(null), null);
    assert.equal(sanitizePendingEnd({ endedAt: 1 }), null);
    assert.deepEqual(sanitizePendingEnd({ endedAt: 2, startedAt: 1, gapMs: -5 }), {
      endedAt: 2,
      startedAt: 1,
      gapMs: 0,
    });
  });
  it('sin directo, el snapshot conserva solo el corte pendiente', () => {
    const snap = buildSnapshot({ live: false, pendingEnd: { endedAt: 2, startedAt: 1, gapMs: 0 } }, 99);
    assert.deepEqual(snap, { v: 1, live: false, pendingEnd: { endedAt: 2, startedAt: 1, gapMs: 0 }, savedAt: 99 });
    assert.deepEqual(buildSnapshot({ live: false }, 99), { v: 1, live: false, savedAt: 99 });
  });
});

describe('margen del resumen final con el directo apagado', () => {
  const offlineAt = 0;
  const closedAt = offlineAt + 15 * MIN; // el resumen sale al vencer la espera
  const resumen = 'Gran directo, gracias por venir a todos';
  const args = (now, graceUntil) => ({ origin: 'resumen', live: false, graceUntil, now });

  it('durante el corte el bot calla (aún no hay margen)', () => {
    assert.equal(checkOutbound(resumen, args(offlineAt + 5 * MIN, 0)).reason, 'offline');
  });
  it('el margen cuenta desde el cierre real, no desde el offline', () => {
    const grace = endGraceUntil(closedAt);
    assert.equal(grace, closedAt + END_GRACE_MS);
    // 20 min tras el offline y 5 tras el cierre: el resumen pasa (con margen desde el offline ya habría caducado)
    assert.equal(checkOutbound(resumen, args(offlineAt + 20 * MIN, grace)).ok, true);
    assert.equal(checkOutbound(resumen, args(offlineAt + 20 * MIN, offlineAt + END_GRACE_MS)).reason, 'offline');
  });
  it('pasado el margen desde el cierre vuelve a callar', () => {
    assert.equal(checkOutbound(resumen, args(closedAt + END_GRACE_MS + 1, endGraceUntil(closedAt))).reason, 'offline');
  });
});
