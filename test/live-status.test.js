const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileLive, buildHealth, OFFLINE_CONFIRMATIONS } = require('../src/utils/live-status');
const { buildSnapshot, restorableState } = require('../src/utils/bot-state');

describe('reconcileLive', () => {
  test('una consulta fallida (null) nunca cambia nada ni reinicia la cuenta', () => {
    assert.deepEqual(reconcileLive({ flagLive: true, check: null, misses: 2 }), { action: 'none', misses: 2 });
  });
  test('el directo se da por terminado solo tras varias lecturas offline seguidas', () => {
    let misses = 0;
    for (let i = 1; i < OFFLINE_CONFIRMATIONS; i++) {
      const r = reconcileLive({ flagLive: true, check: { live: false }, misses });
      assert.equal(r.action, 'none');
      misses = r.misses;
    }
    assert.equal(reconcileLive({ flagLive: true, check: { live: false }, misses }).action, 'set_offline');
  });
  test('una lectura en directo reinicia la cuenta', () => {
    assert.deepEqual(reconcileLive({ flagLive: true, check: { live: true }, misses: 2 }), {
      action: 'none',
      misses: 0,
    });
  });
  test('Twitch en directo y el bot sin saberlo: se marca online', () => {
    assert.equal(reconcileLive({ flagLive: false, check: { live: true } }).action, 'set_online');
  });
  test('offline y offline: nada', () => {
    assert.deepEqual(reconcileLive({ flagLive: false, check: { live: false }, misses: 5 }), {
      action: 'none',
      misses: 0,
    });
  });
});

describe('buildHealth', () => {
  test('refleja si el chat está conectado', () => {
    const ok = buildHealth({ connected: true, uptime: 5, live: true, lastConnectedAt: 'x' });
    assert.equal(ok.status, 'ok');
    assert.equal(ok.chat, 'connected');
    assert.equal(ok.live, true);
    const down = buildHealth({ connected: false, uptime: 5, lastError: 'login' });
    assert.equal(down.status, 'degraded');
    assert.equal(down.chat, 'disconnected');
    assert.equal(down.lastError, 'login');
  });
});

describe('estado persistido del bot', () => {
  const live = {
    live: true,
    streamStartedAt: 1_700_000_000_000,
    silenced: true,
    brbStart: 1_700_000_600_000,
    player: 'pao',
    deaths: 4,
    bosses: 2,
  };
  test('sin directo se guarda vacío', () => {
    assert.deepEqual(Object.keys(buildSnapshot({ ...live, live: false })).sort(), ['live', 'savedAt', 'v']);
  });
  test('se restaura si es el mismo directo', () => {
    const r = restorableState(buildSnapshot(live), { live: true, streamStartedAt: 1_700_000_001_000 });
    assert.deepEqual(r, {
      silenced: true,
      brbStart: 1_700_000_600_000,
      player: 'pao',
      deaths: 4,
      bosses: 2,
      muteUntil: 0,
      mode: 'normal',
    });
  });
  test('no se restaura si es de otro directo, si no hay directo o si está vacío/corrupto', () => {
    const snap = buildSnapshot(live);
    assert.equal(restorableState(snap, { live: true, streamStartedAt: 1_700_100_000_000 }), null);
    assert.equal(restorableState(snap, { live: false, streamStartedAt: 1_700_000_000_000 }), null);
    assert.equal(
      restorableState(buildSnapshot({ ...live, live: false }), { live: true, streamStartedAt: 1_700_000_000_000 }),
      null,
    );
    assert.equal(restorableState(null, { live: true, streamStartedAt: 1 }), null);
    assert.equal(restorableState({ v: 1, live: true, streamStartedAt: 'x' }, { live: true, streamStartedAt: 1 }), null);
  });
  test('valores raros se sanean', () => {
    const r = restorableState(
      { ...buildSnapshot(live), player: 'otro', deaths: -3, bosses: 'x', brbStart: 'ya' },
      { live: true, streamStartedAt: live.streamStartedAt },
    );
    assert.deepEqual(r, {
      silenced: true,
      brbStart: null,
      player: null,
      deaths: 0,
      bosses: 0,
      muteUntil: 0,
      mode: 'normal',
    });
  });
});
