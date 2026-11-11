// Calidad de las frases automáticas: casos reales de los directos del 31-10 y 1-11 (logs/chat-2026-10-31.txt, chat-2026-11-01.txt)
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/ai/quality');
const { parseReview } = require('../src/ai/factcheck');
const { parseBossArgs, applyBossDelta } = require('../src/commands/stats');
const state = require('../src/utils/state');
const { IDENTITY } = require('../src/ai/style');

const base = { deathCount: 3, recent: [], named: new Map(), now: Date.now() };

describe('cohost: vida personal y conversaciones ajenas', () => {
  test('rechaza los comentarios personales reales (paella, sueño, la niña)', () => {
    for (const t of [
      'La paella suena mejor que cualquier hechizo de fuego, gangar79, ¡el FUA ya se prepara para la próxima ronda de tapas!',
      'Gangar79 parece que el sueño le está cobrando su entrada al stream, ¡FUAAAAA!',
      'Mujica90 cuenta que su niña ya se ha dormido, qué ternura.',
    ]) {
      const r = q.validateCohost(t, base);
      assert.equal(r.ok, false, t);
      assert.equal(r.rule, 'personal', t);
    }
  });
  test('lo del stream y la partida sigue pasando', () => {
    assert.equal(q.validateCohost('Tres muertes y Manu ni se despeina, qué máquina.', base).ok, true);
    assert.equal(q.validateCohost('El chat se ha puesto a debatir si el último jefe era para tanto.', base).ok, true);
  });
});

describe('frases cortadas', () => {
  test('dropTrailingFragment: sin frase completa devuelve vacío, nunca un fragmento con punto', () => {
    assert.equal(q.dropTrailingFragment('Mujica90, que dice que cuando la niña'), '');
    assert.equal(q.dropTrailingFragment('Qué locura. Y además el stream y'), 'Qué locura.');
    assert.equal(q.dropTrailingFragment('Frase completa.'), 'Frase completa.');
  });
  test('isCutOff detecta finales colgando aunque lleven punto', () => {
    assert.equal(q.isCutOff('Hoy hablamos del stream y.'), true);
    assert.equal(q.isCutOff('Se acabó cuando la.'), true);
    assert.equal(q.isCutOff('Tremendo FUA, Manu.'), false);
    assert.equal(q.isCutOff('Esto es increíble parlus1Kelokekelowa'), false);
  });
  test('el cohost descarta una frase cortada', () => {
    const r = q.validateCohost('Mira cómo el chat reacciona al stream y.', base);
    assert.equal(r.ok, false);
    assert.equal(r.rule, 'cortada');
  });
});

describe('estilo y español de España', () => {
  test('parcero, enojarse y concha son latinoamericanos', () => {
    for (const t of [
      '¡Vamos con todo, parceros!',
      'No te enojes, hombre.',
      'Se enojó con el jefe.',
      'El FUA hace la concha de la victoria.',
    ]) {
      assert.equal(q.hasLatam(t), true, t);
    }
    assert.equal(q.hasLatam('Vamos con todo, tíos.'), false);
  });
  test('"el FUA" va en masculino', () => {
    assert.equal(q.styleProblem('La FUA ha hablado hoy.').rule, 'fua');
    assert.equal(q.styleProblem('El FUA ha hablado hoy.'), null);
  });
  test('no habla de sí mismo como "el bot"', () => {
    assert.equal(q.styleProblem('El bot está tan con la llaga que necesita terapia.').rule, 'bot');
  });
  test('quien juega es Manu: "Manu y Pao" jugando o muriendo se rechaza', () => {
    assert.equal(q.styleProblem('Manu y Pao siguen firme, que la acción no se detiene.').rule, 'manu');
    assert.equal(q.styleProblem('Manu y Pao os dan la bienvenida.'), null);
  });
  test('no repite insultos ni groserías del chat', () => {
    assert.equal(q.styleProblem('Dice que eres un subnormal, qué fuerte.').rule, 'grosería');
    assert.equal(q.styleProblem('Qué mierda de ronda, Manu.').rule, 'grosería');
  });
});

describe('identidad', () => {
  test('Dios Fua no es el creador del canal', () => {
    assert.equal(q.styleProblem('Soy dios_fua, creador del canal.', { personal: false }).rule, 'creador');
    assert.equal(q.validateMention('Soy dios_fua, creador del canal. Si quieres que haga algo, dime.').ok, false);
    assert.equal(q.validateMention('Soy Dios Fua, el bot del canal de Manu y Pao. Me creó vlxj97.').ok, true);
  });
  test('la identidad nombra a Manu, Pao y vlxj97', () => {
    assert.match(IDENTITY, /Manu y Pao/);
    assert.match(IDENTITY, /creado por vlxj97/);
  });
});

describe('menciones: sin tips ni redirecciones inventadas', () => {
  test('no ofrece tips que nadie pidió', () => {
    assert.equal(
      q.validateMention('¡Qué bueno que te mola! Si quieres más tips, solo pregunta.', {
        question: 'me mola mucho este juego',
      }).ok,
      false,
    );
    assert.equal(
      q.validateMention('Aquí tienes un par de tips para el jefe.', { question: 'dame tips para el jefe' }).ok,
      true,
    );
  });
  test('no dice "no me mola hablar de mecánicas" si nadie las ha mencionado', () => {
    const t = 'No me mola hablar de mecánicas, pero si buscas nostalgia, Resident Evil es un clásico.';
    assert.equal(q.validateMention(t, { question: 'qué juego recomiendas de nostalgia' }).ok, false);
    assert.equal(q.validateMention(t, { question: 'cuéntame las mecánicas' }).ok, true);
  });
});

describe('nombres repetidos: se quita el vocativo inicial', () => {
  test('stripLeadingNames quita "Mujica90," y deja la frase', () => {
    assert.equal(q.stripLeadingNames('Mujica90, ¡qué locura de jefe!', ['mujica90']), '¡Qué locura de jefe!');
    assert.equal(
      q.stripLeadingNames('@Harocho: esos subs son de otro nivel.', ['harocho']),
      'Esos subs son de otro nivel.',
    );
  });
  test('un nombre a mitad de frase no se puede quitar sin romperla (se queda para descartar)', () => {
    const named = new Map([['harocho', Date.now()]]);
    const text = 'Qué bueno lo de harocho con los subs.';
    const stripped = q.stripLeadingNames(text, ['harocho']);
    assert.equal(q.recentlyNamedIn(stripped, named, Date.now(), 900000).length, 1);
  });
});

describe('avisos con IA (inicio, canjes, encuestas)', () => {
  test('validateAuto rechaza latam, robot, cortadas y groserías', () => {
    assert.equal(q.validateAuto('¡Vamos con todo, parceros! ¿Qué arma probáis primero?').ok, false);
    assert.equal(q.validateAuto('Lo siento, no puedo participar en eso.').ok, false);
    assert.equal(q.validateAuto('Bienvenidos al stream de hoy y.').ok, false);
    assert.equal(q.validateAuto('¡Bienvenidos al directo! ¿Qué tal vais?').ok, true);
  });
  test('vetAuto lanza para que actúe la reserva fija', () => {
    assert.throws(() => q.vetAuto('¡Ey, parcero!'), /descartado/);
    assert.equal(q.vetAuto('  ¡Qué bien verte por aquí!  '), '¡Qué bien verte por aquí!');
  });
});

describe('revisión de sentido en la misma llamada', () => {
  test('parseReview lee las dos líneas', () => {
    assert.deepEqual(parseReview('DATOS: NO\nSENTIDO: SÍ'), { data: 'no', sense: 'yes' });
    assert.deepEqual(parseReview('DATOS: SÍ\nSENTIDO: NO'), { data: 'yes', sense: 'no' });
    assert.deepEqual(parseReview('SENTIDO: NO'), { data: null, sense: 'no' });
    assert.deepEqual(parseReview('hola'), { data: null, sense: null });
  });
});

describe('!boss -N', () => {
  test('parseBossArgs', () => {
    assert.deepEqual(parseBossArgs(['boss']), { type: 'show' });
    assert.deepEqual(parseBossArgs(['boss', '-1']), { type: 'sub', n: 1 });
    assert.equal(parseBossArgs(['boss', '-0']).type, 'bad_format');
    assert.equal(parseBossArgs(['boss', '-abc']).type, 'bad_format');
    assert.equal(parseBossArgs(['boss', '-1', 'x']).type, 'bad_format');
  });
  test('applyBossDelta resta sin bajar de 0', () => {
    assert.deepEqual(applyBossDelta(3, { type: 'sub', n: 1 }), { wins: 2, removed: 1 });
    assert.deepEqual(applyBossDelta(1, { type: 'sub', n: 5 }), { wins: 0, removed: 1 });
    assert.deepEqual(applyBossDelta(0, { type: 'sub', n: 1 }), { wins: 0, removed: 0 });
    assert.deepEqual(applyBossDelta(2, { type: 'add' }), { wins: 3, removed: 0 });
  });
});

describe('variedad en el mismo stream', () => {
  test('textos del cohost por tipo: se guardan y se reinician con el stream', () => {
    state.resetBotHistory();
    state.addCohostText('boss', 'El jefe cae al suelo y el FUA lo celebra.');
    assert.deepEqual(state.getCohostTexts('boss'), ['El jefe cae al suelo y el FUA lo celebra.']);
    assert.deepEqual(state.getCohostTexts('free'), []);
    state.resetBotHistory();
    assert.deepEqual(state.getCohostTexts('boss'), []);
  });
  test('un segundo comentario de jefe parecido (umbral 0.4) se marca como repetido', () => {
    const before = 'El segundo jefe se ha caído y el FUA ya está rugiendo con el rugido del triunfo.';
    const r = q.validateCohost('El tercer jefe se ha caído y el FUA ya está rugiendo con el triunfo.', {
      ...base,
      sameKind: [before],
    });
    assert.equal(r.ok, false);
    assert.equal(r.soft, true);
    assert.equal(r.rule, 'parecido');
  });
});

describe('identidad: el canal es de Manu y Pao, vlxj97 solo creó el bot', () => {
  const quality = require('../src/ai/quality');
  test('descarta atribuir el canal a vlxj97 (caso real del 120b)', () => {
    for (const t of [
      'El canal lo lleva @vlxj97',
      'vlxj97 lleva el canal con mano de hierro',
      'Lo dirige vlxj97, claro',
      'Es el canal de vlxj97',
      'vlxj97 es el dueño, que lo sepas',
      'vlxj97 creó el canal hace años',
    ]) {
      assert.ok(quality.claimsChannelOwner(t), t);
      assert.equal(quality.styleProblem(t, { personal: false })?.rule, 'canal', t);
    }
  });
  test('deja pasar lo correcto', () => {
    for (const t of [
      'El canal lo llevan Manu y Pao; vlxj97 solo creó el bot.',
      'Me creó vlxj97, pero el canal es de Manu y Pao.',
      'Manu y Pao llevan el canal, vlxj97 me programó a mí.',
    ])
      assert.equal(quality.claimsChannelOwner(t), false, t);
  });
  test('eval abejas: acepta respuestas correctas sin "sí"', () => {
    const cases = require('./eval-cases.json');
    const any = cases.find((c) => c.id === 'abejas').expect.matchAny.map((p) => new RegExp(p, 'i'));
    for (const t of [
      'Acortan su vida con el trabajo',
      'Viven más en invierno, sí o sí',
      'Tienen una vida más corta en verano',
      'Duran menos en verano',
    ])
      assert.ok(
        any.some((re) => re.test(t)),
        t,
      );
  });
});
