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

describe('menciones: si el usuario pide repetir, repetir no es un fallo', () => {
  const before = ['@Ana ¡Son cuarenta y nueve minutos, no metros! FUA.'];
  const again = '¡Son cuarenta y nueve minutos, no metros! FUA.';
  test('«vuelve a decirlo bien» deja pasar la misma idea; sin esa petición, sigue rechazándola', () => {
    assert.equal(
      q.validateMention(again, { question: 'dios fua vuelve a decirlo bien', recentToUser: before }).ok,
      true,
    );
    assert.equal(q.validateMention(again, { question: 'repite eso', recentToUser: before }).ok, true);
    assert.equal(q.validateMention(again, { question: 'y ahora qué opinas', recentToUser: before }).rule, 'repetido');
  });
});

describe('revisión del eval del 14-11: Lusorum, ustedes, ficha, muertes a cero y verbos', () => {
  test('«Lusorum» a una persona se mantiene al contestarle, con el límite de 1 de cada 4', () => {
    assert.equal(q.limitLusorums('@Ana ¡Buena, Lusorum!', []).text, '@Ana ¡Buena, Lusorum!');
    assert.equal(q.limitLusorums('@Ana ¡Buena, Lusorum!', [true]).text, '@Ana ¡Buena!');
    const lore = fs.readFileSync(path.join(__dirname, '..', 'config', 'lore.json'), 'utf8');
    assert.doesNotMatch(lore, /nunca para una sola persona/);
    assert.match(lore, /en singular, para una persona del chat/);
  });

  test('«ustedes» y sus formas verbales al hablar al chat se rechazan; con vosotros pasa', () => {
    for (const t of [
      'Lusorums, ¿cuántos colosos creen que caerán hoy?',
      '¿Qué piensan, chat?',
      'Chat, ¿quieren más caídas?',
      'Lusorums, vean cómo se levanta Manu.',
      'Ustedes son geniales, Lusorums.',
    ]) {
      assert.equal(q.hasLatam(t), true, t);
      assert.equal(q.validateMention(t).rule, 'latam', t);
      assert.equal(q.validateCohost(t, { deathCount: 1 }).rule, 'latam', t);
    }
    for (const t of [
      'Lusorums, ¿cuántos colosos creéis que caerán hoy?',
      '¿Qué pensáis, chat?',
      'Chat, ¿queréis más caídas?',
      'Manu y Pao creen que el chat anima mucho.',
      'El chat dice que Manu va fenomenal.',
    ])
      assert.equal(q.hasLatam(t), false, t);
    assert.match(style.positiveFix('latam'), /vosotros/);
    assert.match(summaryProblem('Lusorums, ¿qué piensan del jefe de hoy?'), /latinoamericanas/);
  });

  test('«ficha» y «datos del juego» son términos internos: no salen en el chat', () => {
    for (const t of [
      'De lo que no dice la ficha, ni idea.',
      'Sin los datos del juego no te digo nada.',
      'Mi base de datos no lo trae.',
    ])
      assert.equal(q.mentionsSheet(t), true, t);
    for (const t of [
      'Te tengo fichado desde hace rato.',
      'De eso no tengo ni idea, la verdad.',
      'Salió en 2005, del estudio Team Ico.',
    ])
      assert.equal(q.mentionsSheet(t), false, t);
    assert.equal(q.validateMention('De lo que no dice la ficha, ni idea.').rule, 'tech');
    assert.doesNotMatch(style.buildQuestionSystem({}), /datos no dicen/);
    assert.doesNotMatch(JSON.stringify(messages), /ficha de/);
    assert.doesNotMatch(style.positiveFix('ficha'), /ficha/);
  });

  test('con el contador a cero no se mencionan muertes ni se da a entender que las hubo', () => {
    const closing = 'Llevan una hora y media de Hell Is Us. El FUA sigue vivo, el streamer no tanto.';
    assert.match(q.validateQueMePerdi(closing, { deathCount: 0 }), /muertes/);
    assert.match(q.validateQueMePerdi('Una hora y media de Hell Is Us con 0 muertes.', { deathCount: 0 }), /muertes/);
    assert.equal(
      q.validateQueMePerdi(closing, { deathCount: 3 }),
      null,
      'con caídas anotadas la frase no contradice nada',
    );
    assert.equal(
      q.validateQueMePerdi('Una hora y media de Hell Is Us y el chat tan animado.', { deathCount: 0 }),
      null,
    );
    assert.match(summaryProblem(closing, { deathCount: 0, facts: [] }), /muertes/);
    assert.equal(q.validateCohost('Manu resucita otra vez, qué grande es el FUA.', { deathCount: 0 }).rule, 'muertes');
    assert.equal(q.mentionsUnrecordedDeaths('El chat sigue vivo y Manu a lo suyo.', 0), false);
  });

  test('verbos regulares poco frecuentes («domar») no son detalles inventados; lo inventado sigue cayendo', () => {
    const ctx = { allowed: ['Manu lleva cinco caídas hoy'], gameWords: ['shadow', 'colossus'], names: [] };
    for (const t of [
      '¡Mira cómo Manu intenta domar al coloso!',
      'Domando colosos como si nada.',
      'Hoy amansamos al jefe.',
      'Manu domaba al coloso con calma.',
    ])
      assert.equal(q.inventedDetail(t, ctx), '', t);
    assert.equal(q.inventedDetail('Manu busca esa costra otra vez.', ctx), 'costra');
    assert.equal(q.inventedDetail('Menudas Colosales.', ctx), 'Colosales');
    assert.equal(q.inventedDetail('Camino hacia Valisthea.', ctx), 'Valisthea');
    assert.equal(q.inventedDetail('Aquí tienes: Bahamut.', ctx), 'Bahamut');
    assert.equal(q.inventedDetail('El FUA y los colosos con Walker.', ctx), 'Walker');
  });
});

describe('revisor de datos del juego: no descarta lo que solo nombra el juego', () => {
  const router = require('../src/utils/ai-router');
  const factcheck = require('../src/ai/factcheck');
  const GAME = 'Shadow of the Colossus';
  const NAME_ONLY = 'Manu lleva dos caídas en Shadow of the Colossus y el chat dándole consejos.';
  const CLAIM = 'En Shadow of the Colossus hay un nivel de lava con un arma secreta.';
  const reply = (content) => ({ choices: [{ message: { content }, finish_reason: 'stop' }] });
  const stub = (fn) => router.setTransport('groq', async (p) => fn(p));

  test('mentionsGameFacts: nombrar el juego no es afirmar algo de él', () => {
    assert.equal(q.mentionsGameFacts(NAME_ONLY), false);
    assert.equal(q.mentionsGameFacts(CLAIM), true);
    assert.equal(q.mentionsGameFacts('Manu entra en la mazmorra'), q.mentionsMechanics('Manu entra en la mazmorra'));
  });

  test('con el revisor caído (429) o ilegible, el texto que solo nombra el juego pasa; el que afirma algo, no', async () => {
    stub(() => {
      throw Object.assign(new Error('429'), { status: 429 });
    });
    for (const sense of [false, true]) {
      assert.equal(
        (await factcheck.evaluate(NAME_ONLY, `Juego: ${GAME}.`, { game: GAME, sense })).discard,
        false,
        `sense=${sense}`,
      );
      assert.equal(
        (await factcheck.evaluate(CLAIM, `Juego: ${GAME}.`, { game: GAME, sense })).discard,
        true,
        `sense=${sense}`,
      );
    }
    stub(() => reply('¿?'));
    assert.equal((await factcheck.evaluate(NAME_ONLY, `Juego: ${GAME}.`, { game: GAME })).discard, false);
    assert.equal((await factcheck.evaluate(CLAIM, `Juego: ${GAME}.`, { game: GAME })).discard, true);
  });

  test('un SÍ del revisor sigue descartando, y !dios_fua (source juego) sigue siendo estricto', async () => {
    stub(() => reply('SÍ'));
    assert.equal((await factcheck.evaluate(NAME_ONLY, `Juego: ${GAME}.`, { game: GAME })).discard, true);
    stub(() => {
      throw Object.assign(new Error('429'), { status: 429 });
    });
    assert.equal((await factcheck.evaluate(NAME_ONLY, 'Nombre: X', { game: GAME, source: 'juego' })).discard, true);
  });

  test('la pregunta al revisor aclara que los consejos del chat y las caídas son hechos del stream', () => {
    const p = factcheck.buildCheckPrompt(NAME_ONLY, `Juego: ${GAME}.`, 'stream');
    assert.match(p, /el chat dé consejos, ayuda o ánimos a Manu[^.]*NO son datos del juego/);
    assert.doesNotMatch(p, /historia, consejos, fechas/);
    assert.match(
      factcheck.buildReviewPrompt(NAME_ONLY, `Juego: ${GAME}.`, { checkData: true }),
      /NO son datos del juego/,
    );
  });
});
