// Directo del 10-11 (primer directo con el bot nuevo): selector con IA, datos frescos del timer, reglas nuevas de quality.js,
// un solo aviso de inicio y de raid. Todo sin red (transportes de IA falsos).
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';
process.env.CHANNEL = process.env.CHANNEL || 'parlusorum';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../src/twitch/api');
require(apiPath);
const api = require.cache[apiPath].exports;
api.getCurrentGame = async () => ({ game: 'Hell Is Us' });
api.lookupGameInfo = async () => ({ info: null });
api.getGameInfo = async () => null;
api.getChannelInfo = async () => ({ game_name: 'Dark Souls: Remastered' });

const router = require('../src/utils/ai-router');
const state = require('../src/utils/state');
const style = require('../src/ai/style');
const q = require('../src/ai/quality');
const narrative = require('../src/utils/narrative');
const { pickBest, parsePick, buildPickPrompt } = require('../src/ai/pick-best');
const ai = require('../src/ai/handler');
const alerts = require('../src/alerts/handler');
const timers = require('../src/timers/handler');
const { summaryProblem } = require('../src/memory/handler');

// 19:49 en Madrid (martes 10-11-2026) y 22:49
const AT_TARDE = new Date('2026-11-10T18:49:00Z').getTime();
const AT_NOCHE = new Date('2026-11-10T21:49:00Z').getTime();

let sent, calls;
const client = { say: (ch, msg) => { sent.push(msg); } };
const text = c => ({ choices: [{ message: { content: c }, finish_reason: 'stop' }] });
const json = (...c) => text(JSON.stringify({ candidatos: c }));
const isSelector = p => /editor de un chat/.test(p.messages[0].content);

// fn recibe (params, esSelector) y devuelve la respuesta; calls guarda todas las llamadas
function stubModels(fn) {
  const t = async p => { calls.push({ selector: isSelector(p), messages: p.messages }); return fn(p, isSelector(p)); };
  router.setTransport('groq', t);
  router.setTransport('gemini', t);
}
const generated = () => calls.filter(c => !c.selector);
const selectorCalls = () => calls.filter(c => c.selector);

beforeEach(() => {
  sent = []; calls = [];
  state.resetAiBlocks(); state.resetAiUsage();
  state.setStreamIsLive(true);
  state.setStreamStartedAt(Date.now() - 47 * 60000);
  state.resetBotHistory();
  state.resetNamedUsers();
  state.setDeathCount(5);
  ai.addToHistory('gangar79', 'Jajaja otra vez ese jefe');
  ai.addToHistory('markosssx', 'Manu no te rindas');
  ai.addToHistory('mujica90_', 'Va a tardar en pasárselo');
});

// ─────────────────────────────── Reglas puras ───────────────────────────────
describe('mayúsculas y ortografía', () => {
  test('rechaza MasterClass, SOULS, el Jefe y las palabras mal escritas del directo', () => {
    assert.equal(q.oddCaps('Menudo MasterClass de sufrir'), 'MasterClass');
    assert.equal(q.oddCaps('ya llevaríamos tres SOULS completitos'), 'SOULS');
    assert.match(q.oddCaps('vaya el Jefe que tenemos delante'), /el Jefe/);
    assert.match(q.spellingProblem('FUA, no me ignoreís'), /ignoreís/);
    assert.match(q.spellingProblem('Menudo masterclass de despistes'), /femenino/);
    assert.equal(q.styleProblem('Menudo MasterClass de sufrir, qué grande.')?.rule, 'mayusculas');
    assert.equal(q.styleProblem('Menudo masterclass de sufrir, qué grande.')?.rule, 'ortografia');
  });
  test('deja pasar el FUA, los gritos enteros, los emotes y lo correcto', () => {
    for (const t of ['¡FUA! Manu sigue en pie.', '¡POR EL PODER DEL FUA!', 'Qué gran masterclass de despistes, FUAAAA.', 'Manu parlus1PORELPODERDELFUAAAAA sigue.', 'Vosotros reís y yo sonrío con el FUA.', '¿Queréis un chiste, Lusorums?', 'Hell Is Us se juega por el mapa, FUA.', 'Manu ya tiene la teoría del puzle.'])
      assert.equal(q.oddCaps(t) || q.spellingProblem(t), '', t);
  });
  test('letras alargadas del chat ("parrrrrr") se rechazan; los emotes y el FUAAA no', () => {
    assert.equal(q.hasElongation('y el chat grita parrrrrrr sin parar'), true);
    assert.equal(q.hasElongation('FUAAAAA parlus1PORELPODERDELFUAAAAA jajajaja'), false);
    assert.equal(q.styleProblem('El chat grita parrrrrrr y yo aquí mirando.')?.rule, 'ruido');
    assert.equal(q.cleanChatNoise('Pao parrrrerrrrr y parrrrrr dime'), 'Pao y dime');
  });
});

describe('hora, formato y listas', () => {
  test('"plus de nocturnidad" a las 19:49 se rechaza; de noche vale', () => {
    assert.equal(q.wrongDayPart('el FUA hoy cobra plus de nocturnidad', new Date(AT_TARDE)), true);
    assert.equal(q.wrongDayPart('el FUA hoy cobra plus de nocturnidad', new Date(AT_NOCHE)), false);
    assert.equal(q.wrongDayPart('qué madrugón, esta mañana en pie', new Date(AT_NOCHE)), true);
    assert.equal(q.validateTimerIA('Manu cae y el FUA cobra plus de nocturnidad en este rato.', { deathCount: 5, now: AT_TARDE }).ok, false);
    assert.equal(q.validateTimerIA('Manu cae y el FUA cobra plus de nocturnidad en este rato.', { deathCount: 5, now: AT_NOCHE }).ok, true);
  });
  test('formato de informe: "(5 del día)", "En los últimos 30′"', () => {
    assert.equal(q.reportFormat('En los últimos 30′ Manu se ha caído 2 veces (5 del día).'), true);
    assert.equal(q.reportFormat('Manu se ha caído dos veces en media hora.'), false);
    assert.equal(q.mentionsUnrecordedDeaths('Manu cae otra vez, 5 del día, y sigue', 7), true);
    assert.equal(q.mentionsUnrecordedDeaths('Manu cae otra vez, 7 del día, y sigue', 7), false);
  });
  test('listas de palabras sueltas y nicks pegados', () => {
    assert.ok(q.wordListProblem('el chat suelta harocho3847, tienes, parlusorum, poco y dron'));
    assert.equal(q.wordListProblem('el chat ayudando con el puzle mientras Manu busca la forja'), '');
    const real = 'En los últimos 30′ Manu se ha caído 2 veces (5 del día), mientras el chat suelta harocho3847, tienes, parlusorum, poco y dron… ¡FUA!';
    assert.equal(q.validateTimerIA(real, { deathCount: 7, extraDeathNumbers: [2] }).ok, false);
    assert.equal(q.validateTimerIA('El chat ayudando con el puzle y Manu buscando la forja con calma.', { deathCount: 7 }).ok, true);
  });
  test('"el chat mudo" cuenta como juzgar el ambiente; los viewers de una raid no se citan', () => {
    assert.equal(q.judgesChatMood('Tres muertes seguidas y el chat mudo, qué pena.'), true);
    assert.equal(q.validateCohost('¿Dónde está la gloria? 6 viewers y el chat tan contento.', { deathCount: 5 }).rule, 'viewers');
  });
});

describe('minutos aproximados y repeticiones del stream', () => {
  test('approxDuration: nunca los minutos exactos', () => {
    assert.equal(q.approxDuration(116), 'casi dos horas');
    assert.equal(q.approxDuration(147), 'dos horas y media');
    assert.equal(q.approxDuration(194), 'tres horas y pico');
    assert.equal(q.approxDuration(38), 'media hora');
    assert.equal(q.approxDuration(62), 'una hora');
    assert.equal(q.approxDuration(245), 'unas cuatro horas');
    for (let m = 0; m < 400; m += 7) assert.doesNotMatch(q.approxDuration(m), /\d/);
  });
  test('rechaza "116 minutos" y "1h 18m" en cohost, hook y timer', () => {
    assert.equal(q.exactMinutes('116 minutos y Manu ya ha probado el suelo'), true);
    assert.equal(q.exactMinutes('Llevamos 1h 18m de stream'), true);
    assert.equal(q.exactMinutes('Llevamos casi dos horas de directo'), false);
    assert.equal(q.validateCohost('A los 147 minutos de directo seguimos aquí con el FUA.', { deathCount: 5 }).rule, 'minutos');
    assert.equal(q.validateHook('¿Quién aguanta 116 minutos más de directo?', { deathCount: 5 }).ok, false);
    assert.equal(q.validateTimerIA('Llevamos 194 minutos y Manu sigue peleando con calma.', { deathCount: 5 }).ok, false);
  });
  test('el prompt del cohost da el rato en palabras aproximadas', () => {
    const p = style.buildCohostSystem({ game: 'Hell Is Us', minutes: 116, form: style.COHOST_FORMS[0] });
    assert.match(p, /casi dos horas/);
    assert.doesNotMatch(p, /116/);
    assert.match(narrative.pickFreeTopic({ minutes: 147, pick: () => 0 }).note, /dos horas y media/);
  });
  test('día de la semana, "Entre X y Y…" y palabras llamativas: una vez por stream', () => {
    const first = 'Entre Pao y Manu, vaya martes de masterclass y sufrimiento.';
    const used = new Set(q.streamMarks(first, 'Hell Is Us'));
    assert.ok(used.has('dia-semana') && used.has('entre-x-y'));
    assert.equal(q.validateCohost('Qué martes más largo llevamos con el FUA.', { deathCount: 5, usedStructures: used }).rule, 'repetido');
    assert.equal(q.validateCohost('Entre el FUA y el chat se reparten el sufrimiento a partes iguales.', { deathCount: 5, usedStructures: used }).rule, 'repetido');
    assert.equal(q.validateCohost('Manu ya domina el puzle y el FUA lo celebra con calma.', { deathCount: 5, usedStructures: used }).ok, true);
    assert.equal(q.validateTimerIA('Otra masterclass más y Manu sigue con el puzle tan tranquilo.', { deathCount: 5, usedStructures: used }).ok, false);
    assert.equal(q.validateCohost('Qué martes más largo llevamos con el FUA.', { deathCount: 5 }).ok, true, 'sin marcas previas pasa');
  });
  test('el prompt omite el día de la semana cuando ya salió', () => {
    assert.match(style.dayLine(new Date(AT_TARDE)), /martes/);
    assert.doesNotMatch(style.dayLine(new Date(AT_TARDE), { weekday: false }), /martes/);
    assert.doesNotMatch(style.buildTimerSystem({ game: 'X', now: new Date(AT_TARDE), weekday: false }), /martes/);
  });
  test('Pao entra en la ventana de nombres', () => {
    const named = new Map([['pao', Date.now() - 5 * 60000]]);
    const r = q.validateCohost('Pao ya se rie de todo lo que pasa en el directo con Manu.', { deathCount: 5, named });
    assert.equal(r.rule, 'nombre');
  });
  test('"¡FUA!" final de las menciones: solo una de cada tres', () => {
    const a = q.limitTrailingFua('¡Jajaja, que el seguimiento se quede! 😂 ¡FUA!', []);
    assert.equal(a.had, true);
    assert.match(a.text, /¡FUA!$/);
    const b = q.limitTrailingFua('¡Ey, la cara la tiene el Jefe, pero el FUA la lleva el chat! ¡FUA!', [true]);
    assert.equal(b.had, false);
    assert.doesNotMatch(b.text, /¡FUA!$/);
    assert.match(b.text, /chat!$/);
    assert.equal(q.limitTrailingFua('Vale, vale.', [true]).text, 'Vale, vale.');
  });
});

describe('vida personal: estudios y "familia" como saludo', () => {
  test('ADE, universidad y carrera cuentan como vida personal', () => {
    for (const t of ['Entre Pao haciendo chistes de ADE y Manu repartiendo caídas, vaya directo.', 'Pao ya va por el tercer año de carrera.', 'La universidad no perdona, ni el jefe.', 'Tocan los exámenes y el FUA sufre.'])
      assert.equal(q.talksPersonalLife(t), true, t);
    assert.equal(q.validateCohost('Entre Pao haciendo chistes de ADE y Manu repartiendo caídas, vaya directo.', { deathCount: 5 }).rule, 'personal');
  });
  test('"familia" como saludo no se descarta; "la familia de Manu" sí', () => {
    assert.equal(q.talksPersonalLife('¡Gracias por el directo, familia Lusorum!'), false);
    assert.equal(q.talksPersonalLife('Qué grande sois, familia.'), false);
    assert.equal(q.talksPersonalLife('La familia de Manu viene a cenar.'), true);
    assert.equal(summaryProblem('Gran directo de Hell Is Us, familia: Manu cayó diez veces y el chat no paró de animar.'), null);
    assert.ok(summaryProblem('Directo de Hell Is Us con charla sobre la familia de Pao y sus exámenes.'));
  });
});

describe('muestra del chat para el resumen de media hora', () => {
  test('sin nombres, comandos, risas ni ruido', () => {
    const out = narrative.chatSample([
      { username: 'a', message: 'Mira debajo del asiento de copiloto y en la estantería' },
      { username: 'b', message: 'jajajajaja' },
      { username: 'c', message: '@a parrrrrrr' },
      { username: 'd', message: '!muertes +1' },
      { username: 'e', message: 'Por fin encontramos el último puzle' },
    ]);
    assert.deepEqual(out, ['Mira debajo del asiento de copiloto y en la estantería', 'Por fin encontramos el último puzle']);
  });
});

// ─────────────────────────────── Selector con IA ───────────────────────────────
describe('selector con IA', () => {
  test('parsePick y buildPickPrompt', () => {
    assert.equal(parsePick('{"mejor": 2}', 3), 2);
    assert.equal(parsePick('```json\n{"mejor":0}\n```', 3), 0);
    assert.equal(parsePick('2', 3), 2);
    assert.equal(parsePick('{"mejor": 7}', 3), null);
    assert.equal(parsePick('no sé', 3), null);
    const p = buildPickPrompt(['uno parlus1Kelokekelowa', 'dos'], { dayLine: 'Hoy es martes por la tarde.', game: 'Hell Is Us', facts: 'Caídas anotadas: 5.', chat: 'a: hola', activity: 12 });
    assert.match(p, /<ahora>[\s\S]*martes[\s\S]*<\/ahora>/);
    assert.match(p, /Mensajes en el chat en los últimos 5 minutos: 12/);
    assert.match(p, /1\) uno/);
    assert.match(p, /2\) dos/);
    assert.doesNotMatch(p, /parlus1/);
  });
  test('pickBest: elegido, ninguno y error', async () => {
    stubModels(() => text('{"mejor": 2}'));
    assert.deepEqual(await pickBest(['a b c d', 'e f g h']), { status: 'ok', index: 1 });
    stubModels(() => text('{"mejor": 0}'));
    assert.deepEqual(await pickBest(['a b c d', 'e f g h']), { status: 'none' });
    stubModels(() => { throw new Error('sin cupo'); });
    assert.deepEqual(await pickBest(['a b c d']), { status: 'error' });
    assert.deepEqual(await pickBest([]), { status: 'none' });
  });

  const A = 'El jefe ya sabe el camino a casa de Manu de memoria.';
  const B = 'Hacer caso al chat con ese historial es jugársela.';
  const C = 'El FUA se levanta antes que el propio jefe, y encima aplaude.';

  test('cohost: envía el candidato que elige el selector y le pasa chat, hora y actividad', async () => {
    stubModels((p, sel) => (sel ? text('{"mejor": 2}') : json(A, B, C)));
    const out = await ai.runCohost(client, '#parlusorum', null);
    assert.equal(out, 'sent');
    assert.equal(sent[0], B);
    assert.equal(selectorCalls().length, 1);
    const prompt = selectorCalls()[0].messages[1].content;
    assert.match(prompt, /<ahora>/);
    assert.match(prompt, /Mensajes en el chat en los últimos 5 minutos: [1-9]\d*/);
    assert.match(prompt, /gangar79: Jajaja otra vez ese jefe/);
    assert.match(prompt, /1\) .*\n2\) .*\n3\) /);
  });
  test('cohost: si el selector dice que ninguno vale, reintenta una vez con la corrección y se calla', async () => {
    stubModels((p, sel) => (sel ? text('{"mejor": 0}') : json(A, B, C)));
    const out = await ai.runCohost(client, '#parlusorum', null);
    assert.equal(out, 'dropped');
    assert.equal(sent.length, 0);
    assert.equal(generated().length, 2);
    assert.match(generated()[1].messages[0].content, /<correccion>Una sola idea que se entienda a la primera/);
  });
  test('cohost: si el selector falla (cupo o error), sigue el orden del código y envía', async () => {
    stubModels((p, sel) => { if (sel) throw new Error('429'); return json(A, B, C); });
    const out = await ai.runCohost(client, '#parlusorum', null);
    assert.equal(out, 'sent');
    assert.ok([A, B, C].includes(sent[0]));
  });
  test('cohost: las marcas del stream se anotan (día de la semana, palabras largas)', async () => {
    const msg = 'Qué martes más largo, y Manu sigue con su sufrimiento diario.';
    stubModels((p, sel) => (sel ? text('{"mejor": 1}') : json(msg, B, C)));
    assert.equal(await ai.runCohost(client, '#parlusorum', null), 'sent');
    const marks = state.getUsedStructures();
    assert.ok(marks.has('dia-semana'));
    assert.ok(marks.has('w:sufrimiento'));
  });
});

// ─────────────────────────────── Timer IA con datos frescos ───────────────────────────────
describe('timer IA', () => {
  const GOOD = 'El chat ayudando con el puzle y Manu buscando la forja con mucha calma.';

  beforeEach(() => {
    state.resetStreamNarrative();
    state.addNarrativeEvent('death', 'Manu ha caído', 1);
    state.addNarrativeEvent('death', 'Manu ha caído', 1);
    for (let i = 0; i < 6; i++) ai.addToHistory(`user${i}`, `Mira debajo del asiento del copiloto, número ${i} del mapa`);
  });

  test('si el contador cambia mientras la IA escribe, rehace el resumen con el estado actual', async () => {
    let n = 0;
    stubModels((p, sel) => {
      if (sel) return text('{"mejor": 1}');
      if (n++ === 0) state.setDeathCount(7); // dos muertes más mientras se generaba
      return text(GOOD);
    });
    const out = await timers.runTimerIA(client);
    assert.equal(out, GOOD);
    assert.equal(generated().length, 2, 'el primer intento (datos viejos) se descarta y se rehace');
    assert.match(generated()[0].messages[1].content, /hasta ahora: 5/);
    assert.match(generated()[1].messages[1].content, /hasta ahora: 7/);
    assert.equal(sent[0], GOOD);
  });
  test('el resumen lleva líneas del chat sin nombres y no una lista de palabras', async () => {
    stubModels((p, sel) => (sel ? text('{"mejor": 1}') : text(GOOD)));
    await timers.runTimerIA(client);
    const user = generated()[0].messages[1].content;
    assert.match(user, /<chat>[\s\S]*Mira debajo del asiento del copiloto[\s\S]*<\/chat>/);
    assert.doesNotMatch(user, /user\d|Temas del chat/);
    assert.match(generated()[0].messages[0].content, /sin nombres de usuario ni palabras sueltas/);
  });
  test('si el selector no lo ve bueno, no se envía nada', async () => {
    stubModels((p, sel) => (sel ? text('{"mejor": 0}') : text(GOOD)));
    const out = await timers.runTimerIA(client);
    assert.equal(out, '');
    assert.equal(sent.length, 0);
  });
});

// ─────────────────────────────── Avisos únicos ───────────────────────────────
describe('un solo aviso de inicio y de raid', () => {
  test('el aviso de inicio y el de calentamiento se disputan un único turno', async () => {
    state.resetStartAnnouncement();
    stubModels(() => text('¡Bienvenidos, Lusorums! ¿Qué esperáis del juego de hoy? ¡FUA!'));
    assert.equal(state.claimStartAnnouncement(), true); // sale el aviso normal
    await ai.onWarmupMode(client, '#parlusorum', 'Hell Is Us');
    assert.equal(sent.length, 0, 'el calentamiento no añade otro');
    state.resetStartAnnouncement();
    await ai.onWarmupMode(client, '#parlusorum', 'Hell Is Us');
    assert.equal(sent.length, 1);
    assert.equal(state.claimStartAnnouncement(), false, 'y ahora el aviso normal ya no sale');
  });
  test('stream.online reinicia el turno', () => {
    state.claimStartAnnouncement();
    state.resetBotHistory();
    assert.equal(state.claimStartAnnouncement(), true);
  });
  test('raid: un solo mensaje (el de la IA) y un raid repetido se ignora', async () => {
    stubModels(() => text('¡Menuda raid de @P1X3LUS con seis valientes! Bienvenidos a la casa de Manu y Pao.'));
    await alerts.onRaid(client, '#parlusorum', 'P1X3LUS', 6);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /@P1X3LUS/);
    await alerts.onRaid(client, '#parlusorum', 'P1X3LUS', 6);
    assert.equal(sent.length, 1, 'el repetido no se agradece otra vez');
  });
  test('raid: si la IA falla o no nombra a quien hace el raid, sale solo el mensaje fijo', async () => {
    stubModels(() => { throw new Error('sin IA'); });
    await alerts.onRaid(client, '#parlusorum', 'Otro_Canal', 12);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /RAID de @Otro_Canal con 12 viewers/);
    stubModels(() => text('Bienvenidos todos a la casa de Manu y Pao, qué alegría.'));
    sent.length = 0;
    await alerts.onRaid(client, '#parlusorum', 'Tercero', 3);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /RAID de @Tercero/);
  });
  test('la narrativa describe a los raiders como visitantes, no como viewers del canal', async () => {
    state.resetStreamNarrative();
    stubModels(() => { throw new Error('sin IA'); });
    await alerts.onRaid(client, '#parlusorum', 'Cuarto', 6);
    const ev = state.getStreamNarrative().find(e => e.type === 'raid');
    assert.match(ev.description, /raiders/);
    assert.match(ev.description, /visitantes/);
  });
});

// ─────────────────────────────── Casos reales del eval ───────────────────────────────
// Los casos d10-* de test/eval-cases.json se comprueban aquí solo con las reglas (sin IA); `npm run eval` añade el selector y el revisor de sentido
test('eval-cases: las reglas dan lo esperado en los casos reales del 10-11', () => {
  const cases = require('./eval-cases.json').filter(c => c.id.startsWith('d10-') && ['cohost', 'timer_ia', 'summary'].includes(c.filter));
  assert.ok(cases.length >= 10);
  for (const c of cases) {
    const ctx = { deathCount: c.deaths ?? 5, recent: [], now: c.at ? new Date(c.at).getTime() : Date.now(), player: 'manu' };
    const rules = {
      cohost: t => q.validateCohost(t, ctx),
      timer_ia: t => q.validateTimerIA(t, ctx),
      summary: t => (summaryProblem(t) ? { ok: false } : { ok: true }),
    };
    const v = rules[c.filter](c.input);
    assert.equal(!v.ok, c.expect.rejected, `${c.id}: ${JSON.stringify(v)}`);
  }
  const picks = require('./eval-cases.json').filter(c => c.filter === 'pick');
  assert.ok(picks.length >= 4);
  for (const c of picks) assert.ok(c.candidates.length >= 2 && c.expect.pick !== undefined, c.id);
});

test('"quién desarrolló el Phantom Blade 0" es una pregunta de juego, no de identidad', () => {
  assert.equal(q.identityQuestion('!dios_fua quien desarrollo el phantom blade 0? japoneses o chinos?'), null);
  assert.equal(q.identityQuestion('quién creó Hades'), null);
  assert.equal(q.identityQuestion('dios fua quién te desarrolló'), 'creator');
  assert.equal(q.identityQuestion('quién creó a este bot'), 'creator');
});
