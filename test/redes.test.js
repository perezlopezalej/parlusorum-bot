process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const redes = require('../src/commands/redes');
const { checkOutbound, findDisallowedUrl } = require('../src/utils/output-guard');
const { outboundBlock } = require('../src/utils/bot-control');
const { fill, TEMPLATES } = require('../src/utils/plantillas');
const { buildCommandList, getHelpText } = require('../src/commands/help');
const cfg = require('../config/redes.json');

const FAKE = { discord: 'https://discord.gg/abc', tiktok: 'https://www.tiktok.com/@canal' };

describe('respuestas de !redes, !discord y !tiktok', () => {
  test('el JSON trae los dos enlaces https', () => {
    assert.match(cfg.discord, /^https:\/\/discord\.gg\//);
    assert.match(cfg.tiktok, /^https:\/\/www\.tiktok\.com\/@/);
  });
  test('!redes da los dos, !discord y !tiktok uno', () => {
    const both = redes.replyFor('redes', FAKE);
    assert.ok(both.includes(FAKE.discord) && both.includes(FAKE.tiktok));
    assert.equal(redes.replyFor('discord', FAKE).includes(FAKE.tiktok), false);
    assert.ok(redes.replyFor('tiktok', FAKE).includes(FAKE.tiktok));
  });
  test('sin enlace en el JSON no se contesta; un comando ajeno da null', () => {
    assert.equal(redes.replyFor('discord', { tiktok: FAKE.tiktok }), null);
    assert.equal(redes.replyFor('redes', {}), null);
    assert.equal(redes.replyFor('uptime', FAKE), null);
    assert.equal(redes.replyFor('tiktok', { tiktok: 'javascript:alert(1)' }), null);
  });
  test('cooldown por usuario y global', () => {
    const map = new Map();
    const t = 1000;
    assert.equal(redes.onCooldown(map, 'a', t), false);
    assert.equal(redes.onCooldown(map, 'a', t + 1000), true); // mismo usuario
    assert.equal(redes.onCooldown(map, 'b', t + 1000), true); // otro usuario, global
    assert.equal(redes.onCooldown(map, 'b', t + 31_000), false); // pasa el global
    assert.equal(redes.onCooldown(map, 'a', t + 40_000), true); // a sigue en su cooldown de 60 s
    assert.equal(redes.onCooldown(map, 'a', t + 61_000), false);
  });
});

describe('filtro de salida y dominios', () => {
  test('allowedHosts saca los dominios exactos sin www', () => {
    assert.deepEqual(redes.allowedHosts(), ['discord.gg', 'tiktok.com']);
  });
  test('los enlaces solo pasan con origen redes', () => {
    const text = redes.replyFor('redes');
    assert.equal(checkOutbound(text, { origin: 'redes' }).ok, true);
    assert.equal(checkOutbound(text, { origin: 'comando' }).reason, 'url');
    assert.equal(checkOutbound(text, { origin: 'timer' }).reason, 'url');
    assert.equal(checkOutbound(text, { origin: 'dios_fua' }).reason, 'url');
  });
  test('con origen redes solo valen los dominios exactos', () => {
    const o = { origin: 'redes' };
    assert.equal(checkOutbound('Mira discord.gg/NpKnA4nm9F', o).ok, true);
    assert.equal(checkOutbound('Mira https://evil.discord.gg/x', o).reason, 'url');
    assert.equal(checkOutbound('Mira https://tiktok.com.evil.io/x', o).reason, 'url');
    assert.equal(checkOutbound('Mira https://youtube.com/x', o).reason, 'url');
    assert.equal(checkOutbound('Mira twitch.tv/parlusorum', o).ok, true);
  });
  test('findDisallowedUrl sin exactHosts sigue como antes', () => {
    assert.ok(findDisallowedUrl('https://discord.gg/x'));
    assert.equal(findDisallowedUrl('https://discord.gg/x', ['discord.gg']), null);
  });
  test('con silencio, las respuestas de redes salen; con directo apagado también', () => {
    assert.equal(outboundBlock('redes', { silenced: true, reactive: true }), null);
    assert.equal(checkOutbound('hola', { origin: 'redes', live: false }).ok, true);
  });
});

describe('aviso periódico', () => {
  test('las variantes no llevan enlaces, invitan a !redes y pasan el filtro con origen timer', () => {
    const list = TEMPLATES.redes_recordatorio;
    assert.ok(list.length >= 2 && list.length <= 3);
    for (const v of list) {
      assert.match(v, /!redes/);
      assert.doesNotMatch(v, /https?:|www\.|\.com|\.gg/i);
      assert.equal(checkOutbound(fill(v), { origin: 'timer' }).ok, true);
    }
  });
  test('toca solo en directo, sin silencio ni modo reactivo y pasados 10 minutos', () => {
    const now = 100 * 60 * 1000;
    const base = { live: true, silenced: false, reactive: false, startedAt: now - 11 * 60 * 1000, now };
    assert.equal(redes.reminderDue(base), true);
    assert.equal(redes.reminderDue({ ...base, startedAt: now - 9 * 60 * 1000 }), false);
    assert.equal(redes.reminderDue({ ...base, startedAt: null }), false);
    assert.equal(redes.reminderDue({ ...base, live: false }), false);
    assert.equal(redes.reminderDue({ ...base, silenced: true }), false);
    assert.equal(redes.reminderDue({ ...base, reactive: true }), false);
  });
  test('el origen timer queda bloqueado por silencio y modo reactivo', () => {
    assert.equal(outboundBlock('timer', { silenced: true }), 'silencio');
    assert.equal(outboundBlock('timer', { reactive: true }), 'reactivo');
  });
  test('se alterna con el follow: desfase de media hora', () => {
    assert.equal(redes.REMINDER_OFFSET_MS * 2, redes.REMINDER_INTERVAL_MS);
  });
});

describe('ayuda', () => {
  test('los tres comandos salen en !comandos y !ayuda', () => {
    const list = buildCommandList(false);
    for (const c of ['redes', 'discord', 'tiktok']) {
      assert.ok(list.split(/\s+/).includes(`!${c}`), c);
      assert.ok(getHelpText(c, false));
    }
  });
});
