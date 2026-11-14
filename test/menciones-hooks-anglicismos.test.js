// Directo del 13-11, puntos 5, 6 y 7: anglicismos en todos los textos del bot, «piratear» en las menciones, coletillas de
// `dios_fua_game_quips` sin meta-charla sobre mentir y hooks fijos (config/hooks.json) sin repetir ni reiniciar. Sin red.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const q = require('../src/ai/quality');
const style = require('../src/ai/style');
const messages = require('../config/messages.json');
const hooksConfig = require('../config/hooks.json');
const { pickStaticHook, hookIntervalMs, fillHook } = require('../src/ai/hooks');
const { summaryProblem } = require('../src/memory/handler');
const { buildGameTemplate } = require('../src/ai/game-template');

describe('regla `anglicismo`', () => {
  test('la lista está en data/anglicismos.txt y trae «lads» y «power» con su equivalente', () => {
    assert.deepEqual(q.anglicism('Vaya power tiene Manu'), { word: 'power', es: 'potencia' });
    assert.deepEqual(q.anglicism('Chavales no, lads'), { word: 'lads', es: 'chavales' });
    assert.match(q.ANGLICISM_REASON(q.anglicism('Qué vibes hoy')), /«vibes».*«ambiente» en español/);
  });

  test('palabras sueltas, con mayúsculas; no casan trozos de otras palabras ni los términos del canal', () => {
    assert.ok(q.anglicism('POWER total'));
    assert.equal(q.anglicism('El empower no existe, ni el powerpoint'), null);
    for (const t of [
      'El stream de hoy va fenomenal.',
      'Manu, streamer de pro, sigue.',
      'Otro boss caído, gg.',
      'Manu parlus1Power sigue',
    ])
      assert.equal(q.anglicism(t), null, t);
  });

  test('vale lo que está en el título del juego o lo que escribió quien pregunta', () => {
    assert.equal(q.anglicism('Manu en Power Rangers, FUA', ['Power Rangers']), null);
    assert.equal(q.anglicism('Pues el power, claro', ['dime el power de este juego']), null);
    assert.ok(q.anglicism('Pues el power, claro', ['dime algo']));
  });

  test('cohost, hook, timer, mención, aviso, !quemeperdi y resumen la aplican', () => {
    const t = 'Manu sigue peleando con mucho power y el FUA lo aplaude a gritos.';
    assert.equal(q.validateCohost(t, { deathCount: 1 }).rule, 'anglicismo');
    assert.equal(q.validateHook('¿Qué opináis de los lads que juegan hoy, Lusorums?', { deathCount: 1 }).ok, false);
    assert.equal(q.validateTimerIA(t, { deathCount: 1 }).ok, false);
    assert.equal(q.validateMention(t).rule, 'anglicismo');
    assert.equal(q.validateAuto('¡Bienvenidos, lads, a un directo con mucho FUA!').ok, false);
    assert.match(
      q.validateQueMePerdi('Manu lleva un directo con mucho power y cayó una vez.', { deathCount: 1 }),
      /power/,
    );
    assert.match(summaryProblem('Directo con mucho power y el chat animando a Manu.'), /anglicismo «power»/);
  });

  test('en las menciones no cuenta si el usuario la escribió, y con el título del juego tampoco', () => {
    const t = 'Menudo power tiene ese juego, Manu.';
    assert.equal(q.validateMention(t, { question: 'qué power tiene manu' }).ok, true);
    assert.equal(q.validateMention(t, { question: 'qué opinas' }).rule, 'anglicismo');
    assert.equal(
      q.validateCohost('Manu y Power Rangers, vaya tarde de FUA.', { deathCount: 1, game: 'Power Rangers' }).ok,
      true,
    );
  });

  test('el reintento recibe la corrección en positivo', () => {
    assert.equal(style.positiveFix('anglicismo'), 'Escríbelo todo en español de España, con palabras españolas.');
    assert.equal(
      style.positiveFix(q.ANGLICISM_REASON({ word: 'lads', es: 'chavales' })),
      'Escríbelo todo en español de España, con palabras españolas.',
    );
    const note = style.retryNote('anglicismo');
    assert.doesNotMatch(note, /lads|power/i);
  });

  test('los textos fijos del bot no llevan anglicismos', () => {
    const strings = [];
    const walk = (v) =>
      typeof v === 'string' ? strings.push(v) : v && typeof v === 'object' ? Object.values(v).forEach(walk) : 0;
    walk(messages);
    walk(hooksConfig);
    for (const s of strings) assert.equal(q.anglicism(s), null, s);
  });
});

describe('menciones: «piratear» es hackear', () => {
  test('el prompt de menciones lleva el glosario y ningún otro prompt lo necesita', () => {
    const p = style.buildMentionSystem({});
    assert.match(p, /<glosario>«Piratear» es hackear[^<]*nada que ver con barcos ni con piratas/);
    assert.doesNotMatch(style.buildQuestionSystem({}), /<glosario>/);
  });

  test('los prompts siguen sin citar prohibiciones del estilo «no digas»', () => {
    assert.doesNotMatch(style.buildMentionSystem({}), /no digas|nunca digas|prohibid/i);
  });
});

describe('`dios_fua_game_quips`: sin meta-charla sobre mentir', () => {
  test('ninguna coletilla habla de bulos, de mentir ni de fiarse', () => {
    const quips = messages.dios_fua_game_quips;
    assert.ok(quips.length >= 3);
    for (const quip of quips) assert.doesNotMatch(quip, /bulo|mentir|mentira|no me f[ií]o|certifico|regañ/i, quip);
  });

  test('invitan a seguir preguntando, como `mention_game_quips`', () => {
    const rest = messages.dios_fua_game_quips.filter((x) => /preg[uú]nt/i.test(x));
    assert.ok(rest.length >= 2, rest.join(' | '));
    const tpl = buildGameTemplate(
      { name: 'Hades', genres: 'Roguelike', released: '2020-09-17' },
      messages.dios_fua_game_quips,
      (a) => a[0],
    );
    assert.match(tpl, /^Hades.*\(2020\)\. Si quieres más, pregúntame/);
  });
});

describe('hooks fijos: config/hooks.json, sin repetir y sin reiniciar', () => {
  const generic = hooksConfig.generic;

  test('la lista editable tiene unas 30 preguntas, todas distintas y con forma de pregunta o aviso', () => {
    assert.ok(generic.length >= 30, String(generic.length));
    assert.equal(new Set(generic).size, generic.length);
    for (const h of generic) assert.ok(h.length >= 15 && h.length <= 140, h);
    assert.ok(generic.filter((h) => h.includes('?')).length >= generic.length - 2);
  });

  test('40 llamadas seguidas: ninguna repetida y, agotada la lista, ya no hay hook', () => {
    const used = new Set();
    const said = [];
    for (let i = 0; i < 40; i++) {
      const { hook } = pickStaticHook({ gameHooks: [], genericHooks: generic, used, gameHookUsed: true });
      if (!hook) continue;
      used.add(hook);
      said.push(hook);
    }
    assert.equal(said.length, generic.length);
    assert.equal(new Set(said).size, said.length);
    assert.equal(pickStaticHook({ genericHooks: generic, used }).hook, undefined, 'sin reinicio');
    assert.equal(used.size, generic.length);
  });

  test('con los de juego mezclados tampoco se repite ninguno', () => {
    const gameHooks = hooksConfig.game_plain.map((t) => fillHook(t, { game: 'Hades' }));
    const used = new Set();
    let gameUsed = false;
    const said = [];
    for (let i = 0; i < 60; i++) {
      const { hook, isGame } = pickStaticHook({ gameHooks, genericHooks: generic, used, gameHookUsed: gameUsed });
      if (!hook) continue;
      used.add(hook);
      said.push(hook);
      if (isGame) gameUsed = true;
    }
    assert.equal(new Set(said).size, said.length);
    assert.equal(said.length, generic.length + 1, 'todos los genéricos y un solo hook de juego');
  });

  test('el intervalo se duplica a partir del 70 % de la lista usada', () => {
    const total = generic.length;
    assert.equal(hookIntervalMs(0, total, 600000), 600000);
    assert.equal(hookIntervalMs(Math.ceil(total * 0.7) - 1, total, 600000), 600000);
    assert.equal(hookIntervalMs(Math.ceil(total * 0.7), total, 600000), 1200000);
    assert.equal(hookIntervalMs(total, total, 600000), 1200000);
    assert.equal(hookIntervalMs(5, 0, 600000), 600000);
  });

  test('las plantillas de juego rellenan juego, género, año y canal', () => {
    const vars = { streamer: 'ParLusorum', game: 'Hades', genres: 'Aventura', year: ', de 2020' };
    const out = hooksConfig.game_with_genres.map((t) => fillHook(t, vars));
    for (const o of out) assert.doesNotMatch(o, /[{}]/, o);
    assert.match(out[0], /^🎮 ParLusorum juega a Hades: Aventura, de 2020\./);
    assert.equal(fillHook('Sin {datos} que rellenar', {}), 'Sin {datos} que rellenar');
  });

  test('hooks.js no guarda ya la lista en el código', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai', 'hooks.js'), 'utf8');
    assert.doesNotMatch(src, /Sois más de cooperativo/);
    assert.match(src, /config\/hooks\.json/);
  });
});
