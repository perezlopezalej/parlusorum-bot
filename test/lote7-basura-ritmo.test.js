process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const test = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/ai/quality');
const { streakAllowed, freeCohostDue, STREAK_COHOST_GAP_MS, FREE_COHOST_MAX_PER_HOUR } = require('../src/utils/narrative');

test('junkProblem: descarta el caso real del timer ("something like... finding")', () => {
  assert.equal(q.junkProblem('something like... finding')?.rule, 'basura');
});

test('junkProblem: restos de razonamiento y texto sin español', () => {
  assert.ok(q.junkProblem('Okay, let me write a short message about the stream'));
  assert.ok(q.junkProblem('The user wants a funny comment about Manu'));
  assert.ok(q.junkProblem('Manu Fua Dios Souls'));
  assert.ok(q.junkProblem('Hola'));
  assert.ok(q.junkProblem('¡FUA! parlus1PORELPODERDELFUAAAAA'));
});

test('junkProblem: deja pasar frases normales en español', () => {
  assert.equal(q.junkProblem('Seis horas de directo y el FUA sigue en pie parlus1PORELPODERDELFUAAAAA'), null);
  assert.equal(q.junkProblem('¡Por el FUA, Manu!'), null);
  assert.equal(q.junkProblem('28 muertes en 3h, pero el FUA sigue contigo.'), null);
  assert.equal(q.junkProblem('Sí, claro.', { minWords: 2 }), null);
});

test('junkProblem se aplica en todos los validadores', () => {
  assert.equal(q.validateTimerIA('something like... finding').ok, false);
  assert.equal(q.validateCohost('something like... finding').ok, false);
  assert.equal(q.validateHook('something like... finding').ok, false);
  assert.equal(q.validateAuto('something like... finding').ok, false);
  assert.equal(q.validateMention('something like... finding').ok, false);
  assert.ok(q.validateQueMePerdi('something like... finding'));
});

test('números mal formados ("cuarentay siete") se detectan; los bien escritos pasan', () => {
  assert.ok(q.malformedNumber('Seis horas con cuarentay siete muertes a cuestas'));
  assert.ok(q.malformedNumber('treintaydos caídas'));
  assert.ok(q.malformedNumber('cuarenta siete caídas'));
  for (const ok of ['treinta y siete', 'cuarenta y uno', 'cuarenta y siete', 'cincuenta', 'veintiuno', 'noventa y nueve']) {
    assert.equal(q.malformedNumber(`Van ${ok} caídas`), null, ok);
  }
  assert.equal(q.junkProblem('Van treinta y siete caídas y el FUA sigue ahí'), null);
  assert.equal(q.junkProblem('Ya son cuarenta y uno y el FUA no se rinde'), null);
  assert.equal(q.junkProblem('Ya son cuarentay siete y el FUA no se rinde')?.rule, 'numero');
});

test('numberWordsEs: formas de escribir un número', () => {
  assert.ok(q.numberWordsEs(31).includes('treinta y una'));
  assert.ok(q.numberWordsEs(31).includes('treinta y uno'));
  assert.ok(q.numberWordsEs(47).includes('cuarenta y siete'));
  assert.ok(q.numberWordsEs(100).includes('cien'));
  assert.ok(q.numberWordsEs(121).includes('ciento veintiuno'));
});

test('citesDeathCount: cifra o palabra pegada a muertes/caídas, o el contador exacto suelto', () => {
  assert.equal(q.citesDeathCount('Treinta y una caídas a sus espaldas y el mando pide clemencia', 31), true);
  assert.equal(q.citesDeathCount('Treinta y dos caídas y el jefe sigue ahí', 32), true);
  assert.equal(q.citesDeathCount('Tres muertes seguidas con treinta y una en el zurrón', 31), true);
  assert.equal(q.citesDeathCount('Manu lleva 28 muertes en 3h', 28), true);
  assert.equal(q.citesDeathCount('Con treinta y una en el zurrón y el FUA pidiendo tregua', 31), true);
  assert.equal(q.citesDeathCount('Una muerte y el chat ya se ríe', 1), true);
  assert.equal(q.citesDeathCount('El jefe sigue riéndose pero el FUA no se rinde jamás', 33), false);
  assert.equal(q.citesDeathCount('Llevamos 3 horas de directo', 5), false);
});

test('cohost: no cita el número de muertes en dos mensajes seguidos', () => {
  const base = { deathCount: 33 };
  const text = 'Treinta y tres caídas y el jefe sigue riéndose, pero el FUA no se rinde jamás.';
  assert.equal(q.validateCohost(text, base).ok, true);
  const repeated = q.validateCohost(text, { ...base, lastCitedDeaths: true });
  assert.equal(repeated.ok, false);
  assert.equal(repeated.rule, 'contador');
  assert.equal(repeated.soft, undefined, 'es un descarte duro');
  // si no cita el número, pasa aunque el anterior sí lo citara
  assert.equal(q.validateCohost('El jefe sigue riéndose, pero el FUA no se rinde jamás.', { ...base, lastCitedDeaths: true }).ok, true);
});

test('timer y hook: mismo límite del contador', () => {
  const text = 'Con treinta y tres muertes a cuestas el FUA sigue encendido';
  assert.equal(q.validateTimerIA(text, { deathCount: 33, lastCitedDeaths: true }).ok, false);
  assert.equal(q.validateHook(text, { deathCount: 33, lastCitedDeaths: true }).ok, false);
  assert.equal(q.validateTimerIA(text, { deathCount: 33, lastCitedDeaths: false }).ok, true);
});

test('streakAllowed: hueco mínimo y cupo por hora compartidos', () => {
  const now = 10 * 3600 * 1000;
  assert.equal(streakAllowed({ now, lastSharedAt: 0, sharedStamps: [] }), true);
  assert.equal(streakAllowed({ now, lastSharedAt: now - 5 * 60 * 1000, sharedStamps: [now - 5 * 60 * 1000] }), false);
  assert.equal(streakAllowed({ now, lastSharedAt: now - STREAK_COHOST_GAP_MS, sharedStamps: [now - STREAK_COHOST_GAP_MS] }), true);
  const full = [1, 2, 3, 4].map(i => now - i * 14 * 60 * 1000);
  assert.equal(streakAllowed({ now, lastSharedAt: full[0], sharedStamps: full, gapMs: 0 }), false);
});

// Simula 6,5 h de un stream con muertes constantes (una racha nueva cada 3 min) y chat activo:
// los libres y las rachas comparten cupo; el día 3 hubo 37 cohost.
test('ritmo: con muchas muertes el cohost no pasa de 4 por hora ni de ~26 en 6,5 h', () => {
  const MIN = 60 * 1000;
  const sent = [];
  let lastShared = 0;
  let lastFreeAt = 0;
  const start = 20 * 3600 * 1000;
  for (let m = 0; m < 6.5 * 60; m++) {
    const now = start + m * MIN;
    const stamps = sent.filter(t => now - t < 60 * MIN);
    if (m % 3 === 0 && streakAllowed({ now, lastSharedAt: lastShared, sharedStamps: stamps })) {
      sent.push(now); lastShared = now; lastFreeAt = now;
      continue;
    }
    if (freeCohostDue({ now, lastFreeAt: lastFreeAt || start, recentMessages: 20, freeStamps: stamps, lastAnyAt: lastShared })) {
      sent.push(now); lastShared = now; lastFreeAt = now;
    }
  }
  for (const t of sent) {
    const inHour = sent.filter(s => s >= t && s < t + 60 * MIN).length;
    assert.ok(inHour <= FREE_COHOST_MAX_PER_HOUR, `${inHour} comentarios en una hora`);
  }
  assert.ok(sent.length <= 26, `${sent.length} comentarios en 6,5 h`);
  assert.ok(sent.length >= 20, `${sent.length} comentarios: no debe quedarse corto con chat activo`);
});

test('freeAngleNote: ángulo con datos reales tras un SKIP', () => {
  const { freeAngleNote } = require('../src/utils/narrative');
  const note = freeAngleNote({ minutes: 125, bosses: 2, game: 'Phantom Blade Zero', deathCount: 7, pick: () => 0 });
  assert.match(note, /NO respondas SKIP/);
  assert.match(note, /2 h 5 min/);
  const noDeaths = freeAngleNote({ minutes: 10, bosses: 0, game: '', deathCount: 7, canCiteDeaths: false, pick: () => 0.5 });
  assert.doesNotMatch(noDeaths, /7 anotadas/);
  assert.match(noDeaths, /lore/);
});

test('resumen de fin de stream: informa de los SKIP del modelo', () => {
  const { formatCohostStats } = require('../src/eventsub');
  const line = formatCohostStats({ attempts: { event: 2, free: 5 }, sent: { event: 2, free: 2 }, discards: { skip: 3, sin_tema: 1 }, groq429: 0 });
  assert.match(line, /SKIP del modelo: 3/);
});

// ── Timer IA repetitivo (3) ──
test('timer: no repite el género del juego en cada mensaje', () => {
  const prev = 'Seis horas de directo en este juego de rol y acción y el FUA sigue en pie';
  const next = 'Sigue la batalla en este juego de rol y acción con el FUA al frente';
  assert.equal(q.validateTimerIA(next, { deathCount: 0, recent: [] }).ok, true);
  const r = q.validateTimerIA(next, { deathCount: 0, recent: [prev] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /género/);
});

test('timer: sin comparaciones forzadas', () => {
  assert.ok(q.forcedComparison('El FUA ruge con la misma fuerza que un despertador un lunes por la mañana'));
  assert.ok(q.forcedComparison('El FUA lo impulsa como un tren de carga'));
  assert.equal(q.forcedComparison('El FUA sigue ahí y Manu también, qué barbaridad'), false);
  assert.equal(q.validateTimerIA('El FUA ruge con la misma fuerza que un despertador un lunes por la mañana', { deathCount: 0 }).ok, false);
});

test('timer: sin preguntas de autoayuda', () => {
  assert.ok(q.selfHelp('¿Qué os da fuerzas cuando el mundo se pone difícil?'));
  assert.equal(q.selfHelp('¿Cuál es el mejor momento del directo hasta ahora?'), false);
  assert.equal(q.validateTimerIA('¿Qué os da fuerzas cuando el mundo se pone difícil? El FUA lo sabe', { deathCount: 0 }).ok, false);
});

test('timer: no abre dos mensajes con la misma estructura', () => {
  assert.equal(q.openingKey('Cuatro horas y media dándolo todo'), q.openingKey('Seis horas y once minutos de directo'));
  assert.equal(q.sameOpening('Seis horas y once minutos de directo con el FUA', ['Cuatro horas y media dándolo todo']), true);
  assert.equal(q.sameOpening('El FUA sigue vivo después de seis horas', ['Cuatro horas y media dándolo todo']), false);
});

test('emote: siempre al final y nunca antes de "?" o "."', () => {
  const emotes = ['parlus1PORELPODERDELFUAAAAA'];
  const e = emotes[0];
  assert.equal(q.moveEmotesToEnd(`Sigue la batalla ${e} ¡que la gloria apenas comienza!`, emotes), `Sigue la batalla ¡que la gloria apenas comienza! ${e}`);
  assert.equal(q.applyEmotePolicy(`¿Qué sorpresita nos espera ${e}?`, true, emotes), `¿Qué sorpresita nos espera? ${e}`);
  assert.equal(q.applyEmotePolicy(`Manu aguanta ${e}.`, true, emotes), `Manu aguanta. ${e}`);
  assert.equal(q.applyEmotePolicy(`Manu aguanta ${e}.`, false, emotes), 'Manu aguanta.');
  assert.equal(q.applyEmotePolicy('Manu aguanta.', true, emotes), 'Manu aguanta.');
});

// ── Menciones, quién juega y silencio (4) ──
test('petición de silencio: respuesta amable, no provocación; con insulto sigue siendo provocación', () => {
  const { classifyMessage, isShutUpRequest } = require('../src/ai/patterns');
  const opts = { botNames: ['Dios_Fua'] };
  assert.equal(classifyMessage('Dios fua callate unos minutos que te van a despedir', {}, opts), 'shutup');
  assert.equal(classifyMessage('dios fua calla un poco', {}, opts), 'shutup');
  assert.equal(classifyMessage('@Dios_Fua cállate subnormal', {}, opts), 'provocation');
  assert.equal(classifyMessage('el dios fua se calla solo', {}, opts), null);
  assert.equal(classifyMessage('Dios fua cuántas muertes llevamos?', {}, opts), 'direct');
  assert.equal(isShutUpRequest('hola buenas'), false);
});

test('estado: quién juega (Manu por defecto, !juega pao|manu) y pausa del cohost libre', () => {
  const state = require('../src/utils/state');
  assert.equal(state.getPlayer(), 'manu');
  assert.equal(state.setPlayer('Pao'), true);
  assert.equal(state.getPlayer(), 'pao');
  assert.equal(state.setPlayer('otro'), false);
  assert.equal(state.getPlayer(), 'pao');
  state.resetPlayer();
  assert.equal(state.getPlayer(), 'manu');
  const t0 = 1_000_000;
  assert.equal(state.isFreeCohostPaused(t0), false);
  state.pauseFreeCohost(10 * 60 * 1000, t0);
  assert.equal(state.isFreeCohostPaused(t0 + 9 * 60 * 1000), true);
  assert.equal(state.isFreeCohostPaused(t0 + 10 * 60 * 1000), false);
  state.pauseFreeCohost(10 * 60 * 1000, t0);
  state.resetFreeCohostPause();
  assert.equal(state.isFreeCohostPaused(t0 + 1), false);
});

test('prompt: quién juega y quién escribe', () => {
  const { playerRule } = require('../src/ai/prompts');
  assert.match(playerRule('manu'), /ahora juega Manu; Pao no juega/);
  assert.match(playerRule('pao'), /ahora juega Pao; Manu no juega/);
  assert.match(playerRule('manu'), /NO es quien juega/);
  assert.match(playerRule('manu'), /ParLusorum suelen ser de Pao: no la llames Manu/);
});

test('la regla "solo juega Manu" no descarta frases cuando juega Pao', () => {
  const text = 'Manu y Pao siguen firmes y el FUA no se rinde jamás.';
  assert.equal(q.validateCohost(text, { deathCount: 0 }).ok, false);
  assert.equal(q.validateCohost(text, { deathCount: 0, player: 'pao' }).ok, true);
  assert.equal(q.validateTimerIA(text, { deathCount: 0 }).ok, false);
  assert.equal(q.validateTimerIA(text, { deathCount: 0, player: 'pao' }).ok, true);
  assert.equal(q.validateMention(text, { player: 'pao' }).ok, true);
});

// ── Detalles (5) ──
test('emote partido por max_tokens o por el límite: se quita', () => {
  const emotes = ['parlus1PORELPODERDELFUAAAAA', 'parlus1Esteeselrollo'];
  assert.equal(q.dropPartialEmote('Aún queda acción, parlus1PORELPO', emotes), 'Aún queda acción');
  assert.equal(q.dropPartialEmote('Aún queda acción parlus1PORELPODERDELFUAAAAA', emotes), 'Aún queda acción parlus1PORELPODERDELFUAAAAA');
  assert.equal(q.dropPartialEmote('Sigue el directo', emotes), 'Sigue el directo');
  const long = `${'palabra '.repeat(60)}fin parlus1PORELPODERDELFUAAAAA`;
  const fitted = q.fitWithEmotes(long, 450, emotes);
  assert.ok(!fitted.includes('parlus1'));
  assert.equal(q.fitWithEmotes('Texto corto parlus1PORELPODERDELFUAAAAA', 450, emotes), 'Texto corto parlus1PORELPODERDELFUAAAAA');
});

test('lore: Dios Fua es leal a Manu y Pao (completo y lean)', () => {
  const lore = require('../config/lore.json');
  assert.match(lore.identity, /leal a Manu y a Pao/);
  assert.match(lore.lean.identity, /leal a Manu y a Pao/);
});

test('ayuda: !juega aparece como comando de mods', () => {
  const help = require('../config/help.json');
  const entry = help.commands.find(c => c.name === 'juega');
  assert.ok(entry && entry.mod === true);
});

// ── Resumen de fin de stream sin vida personal (6) ──
test('resumen de fin de stream: sin vida personal (lista ampliada solo aquí)', () => {
  assert.equal(q.summaryPersonalLife('Entre risas, charlas de hamburguesas y buen rollo en el chat'), true);
  assert.equal(q.summaryPersonalLife('Stream con calor veraniego y muchas caídas del streamer'), true);
  assert.equal(q.summaryPersonalLife('Manu cayó 12 veces ante el jefe final y el chat no paró de animar'), false);
  // el resto de tipos no usa la lista ampliada: "el calor del combate" sigue valiendo en directo
  assert.equal(q.validateCohost('Con el calor del combate el FUA sigue encendido, Manu.', { deathCount: 0 }).ok, true);
  assert.equal(q.talksPersonalLife('Con el calor del combate el FUA sigue encendido'), false);
});

test('resumen de fin de stream: onStreamEnd filtra momentos y frases personales y reintenta', async () => {
  process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
  const { setTransport } = require('../src/utils/ai-router');
  const answers = [
    JSON.stringify({ summary: 'Stream con charlas de hamburguesas y calor veraniego', highlights: ['hamburguesas a medianoche', 'Manu venció al jefe'], recurringPhrases: ['qué calor hace'] }),
    JSON.stringify({ summary: 'Manu cayó 9 veces pero venció al jefe final con mucho FUA y buen ambiente', highlights: ['Manu venció al jefe', 'cena de hamburguesas'], recurringPhrases: ['qué calor hace', 'por el FUA'] }),
  ];
  let calls = 0;
  const prompts = [];
  setTransport('groq', async params => {
    prompts.push(params.messages[0].content);
    return { choices: [{ message: { content: answers[Math.min(calls++, answers.length - 1)] }, finish_reason: 'stop' }], usage: {} };
  });
  try {
    const mem = require('../src/memory/handler');
    assert.ok(mem.generateStreamMemory, 'exporta generateStreamMemory para poder probarlo');
    const out = await mem.generateStreamMemory({ game: 'Phantom Blade Zero', durationMinutes: 200, deathCount: 9, peakViewers: 10, topCommands: {}, activeUsers: [] }, 'user: hola');
    assert.equal(calls, 2);
    assert.match(prompts[0], /PROHIBIDO cualquier vida personal/);
    assert.match(prompts[1], /RECHAZADO: habla de vida personal/);
    assert.match(out.summary, /venció al jefe final/);
    assert.deepEqual(out.highlights, ['Manu venció al jefe']);
    assert.deepEqual(out.recurringPhrases, ['por el FUA']);
  } finally { setTransport('groq', async () => { throw new Error('transporte de prueba sin configurar'); }); }
});

// Los casos reales añadidos a test/eval-cases.json se comprueban aquí solo con las reglas (sin IA); `npm run eval` añade la revisión por IA
test('eval-cases: las reglas dan lo esperado en los casos reales nuevos', () => {
  const cases = require('./eval-cases.json');
  const ids = new Set(['f-something-like', 'f-treinta-y-una', 'f-treinta-y-dos', 'f-treinta-y-tres', 'f-contador-control', 'f-despertador-lunes', 'f-autoayuda-fuerzas', 'f-genero-repetido', 'f-cuarentay-siete', 'f-cuarenta-y-siete-bien', 'f-apertura-repetida', 'f-juega-pao-control', 'f-juega-manu', 'f-silencio-fua', 'f-silencio-insulto', 'f-resumen-hamburguesas', 'f-resumen-control']);
  const { classifyMessage } = require('../src/ai/patterns');
  const { summaryProblem } = require('../src/memory/handler');
  let checked = 0;
  for (const c of cases.filter(x => ids.has(x.id))) {
    const ctx = { deathCount: c.deaths ?? 5, recent: c.recent || [], lastCitedDeaths: !!c.lastCitedDeaths, player: c.player || 'manu' };
    const rules = {
      cohost: t => q.validateCohost(t, ctx),
      timer_ia: t => q.validateTimerIA(t, ctx),
      shutup: t => (classifyMessage(t, {}, { botNames: ['Dios_Fua'] }) === 'shutup' ? { ok: false } : { ok: true }),
      summary: t => (summaryProblem(t) ? { ok: false } : { ok: true }),
    };
    const v = rules[c.filter](c.input);
    assert.equal(!v.ok, c.expect.rejected, `${c.id}: ${JSON.stringify(v)}`);
    checked++;
  }
  assert.equal(checked, ids.size);
});
