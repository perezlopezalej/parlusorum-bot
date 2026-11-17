// 17-11: 12 avisos fijos en 3,5 horas y el follow y el tiempo con un minuto de diferencia (12:29/12:30, 14:29/14:30).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { nextFixedNotice, MIN_GAP_MS, TIME_INTERVAL_MS } = require('../src/timers/fixed-notices');

const MIN = 60 * 1000;
const notices = [
  { kind: 'follow0', intervalMs: 60 * MIN },
  { kind: 'redes', intervalMs: 60 * MIN },
  { kind: 'tiempo', intervalMs: TIME_INTERVAL_MS },
];

// Simula un directo minuto a minuto y devuelve [{ minute, kind }]
function simulate(totalMin, list = notices) {
  const start = 1_000_000_000_000;
  const last = {};
  const sent = [];
  for (let m = 10; m <= totalMin; m++) {
    const now = start + m * MIN;
    const kind = nextFixedNotice({ now, notices: list, lastAt: (k) => last[k] || 0, startedAt: start });
    if (kind) {
      last[kind] = now;
      sent.push({ minute: m, kind });
    }
  }
  return sent;
}

describe('avisos fijos', () => {
  test('en 3,5 horas salen como mucho 8 (el 17-11 salieron 12)', () => {
    const sent = simulate(210);
    assert.ok(sent.length <= 8 && sent.length >= 6, JSON.stringify(sent));
  });

  test('nunca dos avisos a menos de 20 minutos, aunque estén debidos a la vez', () => {
    for (const total of [120, 210, 400]) {
      const sent = simulate(total);
      for (let i = 1; i < sent.length; i++)
        assert.ok(sent[i].minute - sent[i - 1].minute >= MIN_GAP_MS / MIN, JSON.stringify(sent));
    }
  });

  test('nunca el mismo aviso dos veces seguidas', () => {
    const sent = simulate(600);
    for (let i = 1; i < sent.length; i++) assert.notEqual(sent[i].kind, sent[i - 1].kind, JSON.stringify(sent));
  });

  test('cada aviso respeta su intervalo: follow y redes 60 min, «Llevamos X» 90 min', () => {
    const sent = simulate(600);
    for (const n of notices) {
      const mine = sent.filter((s) => s.kind === n.kind);
      for (let i = 1; i < mine.length; i++)
        assert.ok(mine[i].minute - mine[i - 1].minute >= n.intervalMs / MIN, `${n.kind}: ${JSON.stringify(mine)}`);
    }
    const tiempo = sent.filter((s) => s.kind === 'tiempo');
    assert.ok(tiempo.length >= 2);
  });

  test('el primero sale tras su intervalo completo desde el inicio del directo', () => {
    const sent = simulate(200);
    assert.ok(sent[0].minute >= 60, JSON.stringify(sent[0]));
  });

  test('sin inicio de directo no hay aviso', () => {
    assert.equal(nextFixedNotice({ now: Date.now(), notices, lastAt: () => 0, startedAt: 0 }), null);
  });

  test('de los debidos va primero el más atrasado respecto a su intervalo', () => {
    const T = 1_000_000_000_000;
    const at = (last) => (k) => (last[k] ? T + last[k] * MIN : 0);
    const pick = (last) => nextFixedNotice({ now: T + 120 * MIN, notices, lastAt: at(last), startedAt: T });
    // follow lleva 110 min (1,83 veces su intervalo) y redes 60 (1,0): el follow
    assert.equal(pick({ follow0: 10, redes: 60, tiempo: 75 }), 'follow0');
    // redes lleva 110 min y el follow 70: redes
    assert.equal(pick({ follow0: 50, redes: 10, tiempo: 95 }), 'redes');
  });

  test('con un solo aviso configurado se repite por su intervalo', () => {
    const one = [{ kind: 'solo', intervalMs: 60 * MIN }];
    const sent = simulate(200, one);
    assert.deepEqual(
      sent.map((s) => s.minute),
      [60, 120, 180],
    );
  });
});
