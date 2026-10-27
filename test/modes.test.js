const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { decideMode, resolveModeConfig, MIN_MODE_DWELL_MS } = require('../src/utils/narrative');
const state = require('../src/utils/state');
const channelConfig = require('../config/channel.json');

const MIN = 60 * 1000;
const NOW = 10_000_000;
const ev = (type, agoMin) => ({ type, description: type, ts: NOW - agoMin * MIN });
const decide = (o = {}) => decideMode({ now: NOW, recentChatCount: 20, ...o });

describe('decideMode: prioridades', () => {
  test('sin nada especial y chat activo: normal', () => {
    assert.deepEqual(decide(), { mode: 'normal', variant: null });
  });
  test('chat tranquilo: chill', () => {
    assert.equal(decide({ recentChatCount: 2 }).mode, 'chill');
  });
  test('BRB: focus/brb, por encima de todo', () => {
    assert.deepEqual(decide({ brb: true, raidActive: true, events: [ev('victory', 0)] }), { mode: 'focus', variant: 'brb' });
  });
  test('victoria reciente: victory', () => {
    assert.equal(decide({ events: [ev('victory', 1)] }).mode, 'victory');
    assert.equal(decide({ events: [ev('boss', 2)] }).mode, 'victory');
    assert.equal(decide({ events: [ev('milestone', 4)] }).mode, 'victory');
  });
  test('raid, caps rage o sub reciente: hype', () => {
    assert.equal(decide({ raidActive: true }).mode, 'hype');
    assert.equal(decide({ capsRageAt: NOW - MIN }).mode, 'hype');
    assert.equal(decide({ events: [ev('sub', 1)] }).mode, 'hype');
  });
  test('victory gana a hype', () => {
    assert.equal(decide({ raidActive: true, events: [ev('victory', 1)] }).mode, 'victory');
  });
  test('3 muertes en 10 min: focus/deaths', () => {
    assert.deepEqual(decide({ events: [ev('death', 8), ev('death', 5), ev('death', 1)] }), { mode: 'focus', variant: 'deaths' });
  });
  test('2 muertes no bastan', () => {
    assert.equal(decide({ events: [ev('death', 5), ev('death', 1)] }).mode, 'normal');
  });
  test('una victoria posterior a las muertes manda; una muerte posterior a la victoria, no', () => {
    const deaths = [ev('death', 9), ev('death', 8), ev('death', 7)];
    assert.equal(decide({ events: [...deaths, ev('boss', 2)] }).mode, 'victory');
    assert.equal(decide({ events: [ev('boss', 4), ev('death', 3), ev('death', 2), ev('death', 1)] }).mode, 'focus');
  });
});

describe('decideMode: caducidad', () => {
  test('victory caduca a los 5 min, no media hora después', () => {
    assert.equal(decide({ events: [ev('victory', 4.9)] }).mode, 'victory');
    assert.equal(decide({ events: [ev('victory', 5.1)] }).mode, 'normal');
    assert.equal(decide({ events: [ev('victory', 30)] }).mode, 'normal');
  });
  test('hype caduca a los 3 min', () => {
    assert.equal(decide({ events: [ev('raid', 3.5)] }).mode, 'normal');
    assert.equal(decide({ capsRageAt: NOW - 3.5 * MIN }).mode, 'normal');
  });
  test('las muertes de hace más de 10 min no cuentan', () => {
    assert.equal(decide({ events: [ev('death', 12), ev('death', 11), ev('death', 10.5)] }).mode, 'normal');
  });
  test('capsRageAt = 0 (nunca) no activa hype', () => {
    assert.equal(decide({ capsRageAt: 0 }).mode, 'normal');
  });
});

describe('decideMode: permanencia mínima', () => {
  const prev = (mode, variant, agoMs) => ({ mode, variant, setAt: NOW - agoMs });
  test('un cambio a un modo no urgente espera a la permanencia mínima', () => {
    assert.deepEqual(decide({ prev: prev('chill', null, 10 * 1000) }), { mode: 'chill', variant: null });
    assert.deepEqual(decide({ prev: prev('chill', null, MIN_MODE_DWELL_MS + 1) }), { mode: 'normal', variant: null });
  });
  test('victory, hype y BRB entran siempre al momento', () => {
    assert.equal(decide({ prev: prev('chill', null, 1000), events: [ev('victory', 0)] }).mode, 'victory');
    assert.equal(decide({ prev: prev('normal', null, 1000), raidActive: true }).mode, 'hype');
    assert.equal(decide({ prev: prev('normal', null, 1000), brb: true }).variant, 'brb');
  });
  test('sin modo previo no hay espera', () => {
    assert.equal(decide({ recentChatCount: 0, prev: null }).mode, 'chill');
  });
  test('misma variante no cuenta como cambio', () => {
    assert.deepEqual(decide({ brb: true, prev: prev('focus', 'brb', 1000) }), { mode: 'focus', variant: 'brb' });
  });
});

describe('resolveModeConfig y config del canal', () => {
  const modes = channelConfig.personality_modes;
  test('la variante sobrescribe al modo base', () => {
    const brb = resolveModeConfig(modes, 'focus', 'brb');
    const deaths = resolveModeConfig(modes, 'focus', 'deaths');
    assert.ok(brb.max_chars < deaths.max_chars);
    assert.ok(brb.cohost_multiplier < deaths.cohost_multiplier);
    assert.match(brb.prompt_extension, /BRB/);
  });
  test('modo o variante desconocidos caen al modo base / normal', () => {
    assert.equal(resolveModeConfig(modes, 'inventado').max_chars, modes.normal.max_chars);
    assert.equal(resolveModeConfig(modes, 'focus', 'otra').max_chars, modes.focus.max_chars);
    assert.deepEqual(resolveModeConfig(undefined, 'hype'), {});
  });
  test('los modos se distinguen en longitud y frecuencia', () => {
    const c = m => resolveModeConfig(modes, m);
    assert.ok(c('hype').max_chars < c('normal').max_chars);
    assert.ok(c('chill').max_tokens > c('hype').max_tokens);
    assert.ok(c('victory').cohost_multiplier > c('normal').cohost_multiplier);
    assert.ok(c('chill').cohost_multiplier < c('normal').cohost_multiplier);
    assert.ok(c('hype').pattern_cooldown_multiplier < c('chill').pattern_cooldown_multiplier);
  });
  test('focus por muertes no es silencio: sigue respondiendo con ánimo', () => {
    const f = resolveModeConfig(modes, 'focus', 'deaths');
    assert.ok(f.max_chars >= 100 && f.max_tokens >= 40 && f.cohost_multiplier > 0.3);
    assert.match(f.prompt_extension, /ánimo/i);
  });
});

describe('estado del modo', () => {
  test('modeSetAt solo cambia cuando cambia el modo', async () => {
    state.setPersonalityMode('hype', null);
    const t = state.getModeSetAt();
    await new Promise(r => setTimeout(r, 15));
    state.setPersonalityMode('hype', null);
    assert.equal(state.getModeSetAt(), t);
    state.setPersonalityMode('focus', 'brb');
    assert.ok(state.getModeSetAt() > t);
    assert.equal(state.getModeVariant(), 'brb');
    state.setPersonalityMode('normal');
  });
});
