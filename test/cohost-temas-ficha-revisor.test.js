process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const test = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/ai/quality');
const factcheck = require('../src/ai/factcheck');
const { pickFreeTopic } = require('../src/utils/narrative');

// --- Tema del cohost libre elegido por el código ---
test('pickFreeTopic: nunca repite el tema anterior y rota por todos', () => {
  const ctx = { minutes: 90, bosses: 2, game: 'Phantom Blade Zero', deathCount: 5 };
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    for (const last of ['tiempo', 'partida', 'chat_juego', 'lore', 'lusorums', 'fua']) {
      assert.notEqual(pickFreeTopic({ ...ctx, last, pick: () => i / 6 }).id, last);
    }
    seen.add(pickFreeTopic({ ...ctx, pick: () => i / 6 }).id);
  }
  assert.ok(seen.size >= 5, `solo ${seen.size} temas distintos`);
});

test('pickFreeTopic: sin tiempo de directo ni juego solo ofrece temas que no inventan', () => {
  const ids = new Set();
  for (let i = 0; i < 10; i++) ids.add(pickFreeTopic({ minutes: 5, game: '', pick: () => i / 10 }).id);
  assert.ok(!ids.has('tiempo') && !ids.has('partida'));
  assert.ok(ids.has('lore') && ids.has('chat_juego'));
});

test('pickFreeTopic: no cita muertes si canCiteDeaths es false', () => {
  for (let i = 0; i < 10; i++) {
    const t = pickFreeTopic({ minutes: 60, game: 'X', deathCount: 9, canCiteDeaths: false, pick: () => i / 10 });
    assert.ok(!/caídas|\(9/.test(t.note));
  }
});

// --- Ficha de IGDB para el revisor ---
test('gameFactsText: la ficha incluye año, estudio, géneros y descripción', () => {
  const t = factcheck.gameFactsText({
    name: 'Phantom Blade Zero',
    released: '2026-09-09',
    developers: 'S-GAME',
    genres: 'RPG, Hack and slash',
    description: 'Acción wuxia.',
  });
  assert.match(t, /Phantom Blade Zero/);
  assert.match(t, /2026/);
  assert.match(t, /S-GAME/);
  assert.match(t, /Acción wuxia/);
  assert.equal(factcheck.gameFactsText(null), '');
  assert.equal(factcheck.gameFactsText({}), '');
});

test('el prompt del revisor no trata como dato las frases genéricas ("exige temple de acero")', () => {
  const p = factcheck.buildReviewPrompt('Phantom Blade Zero exige temple de acero', 'Juego: Phantom Blade Zero.', {
    checkData: true,
  });
  assert.match(p, /exige temple de acero/);
  assert.match(p, /NO son datos del juego/);
  assert.match(factcheck.buildCheckPrompt('x', 'y', 'stream'), /NO son datos del juego/);
});

// --- Falsos positivos ---
test('"la dificultad del jefe" no cuenta como mecánica; "la dificultad del juego" sí', () => {
  assert.equal(q.mentionsMechanics('Ese jefe se ha ganado la dificultad del jefe, FUA'), false);
  assert.equal(q.mentionsMechanics('La dificultad de este boss es brutal'), false);
  assert.equal(q.mentionsMechanics('Con esa dificultad del juego no hay quien pueda'), true);
  assert.equal(q.mentionsMechanics('Tienes que aprender la parry'), true);
  assert.equal(q.gameTalkProblem('Manu vs la dificultad del jefe, otro asalto más'), null);
});

test('"repartiendo el presupuesto nacional" (chiste) no es un dato inventado; el presupuesto del juego sí', () => {
  assert.equal(
    q.unsupportedAttributes('Manu repartiendo el presupuesto nacional en cada esquivada', '', { persons: false }),
    '',
  );
  assert.equal(q.gameTalkProblem('Manu repartiendo el presupuesto nacional en cada esquivada'), null);
  assert.equal(q.unsupportedAttributes('El juego tuvo un presupuesto enorme', '', { persons: false }), 'presupuesto');
  assert.equal(
    q.unsupportedAttributes('El presupuesto del juego fue de 50 millones', '', { persons: false }),
    'presupuesto',
  );
});

// --- groq-utils: \b no puede ser un retroceso (0x08) ---
test('isDailyQuota detecta TPD/RPD y "per day", y no confunde el cupo por minuto', () => {
  const { isDailyQuota } = require('../src/utils/groq-utils');
  assert.equal(isDailyQuota({ message: 'Rate limit reached for model on tokens per day (TPD): Limit 200000' }), true);
  assert.equal(isDailyQuota({ message: 'Limit reached (RPD): Limit 1000' }), true);
  assert.equal(isDailyQuota({ message: 'Rate limit reached on tokens per minute (TPM)' }), false);
  assert.equal(isDailyQuota({ message: 'x', headers: { 'retry-after': '3600' } }), true);
});

test('ningún fichero fuente contiene caracteres de retroceso (0x08)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|json|md)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(String.fromCharCode(8)))
        bad.push(p);
    }
  };
  for (const d of ['src', 'test', 'config', 'scripts']) walk(path.join(__dirname, '..', d));
  assert.deepEqual(bad, []);
});

// --- !juega ambos ---
test('setPlayer acepta ambos / los dos y rechaza lo demás; resetPlayer vuelve a manu', () => {
  const st = require('../src/utils/state');
  assert.equal(st.setPlayer('ambos'), true);
  assert.equal(st.getPlayer(), 'ambos');
  st.resetPlayer();
  assert.equal(st.getPlayer(), 'manu');
  assert.equal(st.setPlayer('Los  Dos'), true);
  assert.equal(st.getPlayer(), 'ambos');
  assert.equal(st.setPlayer('nadie'), false);
  assert.equal(st.getPlayer(), 'ambos');
  st.resetPlayer();
});

test('con ambos: el prompt lo dice y "Manu y Pao caen" no se descarta (con manu sí)', () => {
  const { playerLine } = require('../src/ai/style');
  assert.match(playerLine('ambos'), /Juegan Manu y Pao a la vez/);
  const t = 'Manu y Pao caen otra vez, FUA';
  assert.equal(q.validateCohost(t, { player: 'manu' }).ok, false);
  assert.equal(q.validateCohost(t, { player: 'ambos' }).rule === 'manu', false);
});

test('!juega los dos: el comando lo registra y responde en plural', () => {
  const st = require('../src/utils/state');
  const { handleJuega } = require('../src/commands/handler');
  const said = [];
  const client = { say: (_c, m) => said.push(m) };
  handleJuega(client, '#c', 'mod', ['juega', 'los', 'dos']);
  assert.equal(st.getPlayer(), 'ambos');
  assert.match(said[0], /Ahora juegan Manu y Pao/);
  handleJuega(client, '#c', 'mod', ['juega', 'pao']);
  assert.match(said[1], /Ahora juega Pao/);
  handleJuega(client, '#c', 'mod', ['juega', 'xyz']);
  assert.match(said[2], /ambos/);
  st.resetPlayer();
});
