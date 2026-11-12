// Directo del 11-11: el cohost parte de hechos escritos por el código y devuelve { hecho, giro, frase }.
// Reglas `hecho`, `giro`, `copia`, otro juego, comparación, modismo y una metáfora por stream. Todo sin red.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';
process.env.CHANNEL = process.env.CHANNEL || 'parlusorum';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const apiPath = require.resolve('../src/twitch/api');
require(apiPath);
const api = require.cache[apiPath].exports;
api.getCurrentGame = async () => ({ game: 'Shadow of the Colossus' });
api.lookupGameInfo = async () => ({ info: null });
api.getGameInfo = async () => null;

const router = require('../src/utils/ai-router');
const state = require('../src/utils/state');
const style = require('../src/ai/style');
const q = require('../src/ai/quality');
const channel = require('../config/channel.json');
const { buildMomentFacts } = require('../src/ai/moment-facts');
const ai = require('../src/ai/handler');

const line = (username, message) => ({ username, message });
const NOW = 1_000_000_000;

describe('parseCandidates: { hecho, giro, frase }', () => {
  test('JSON completo, con ```json y con el hecho en mayúsculas', () => {
    const raw =
      '```json\n{"candidatos":[{"hecho":"H2","giro":"quitarle hierro","frase":"Primera caída del día."},{"hecho":"h1","giro":"sorpresa","frase":"Casi dos horas ya."}]}\n```';
    assert.deepEqual(style.parseCandidates(raw), [
      { hecho: 'h2', giro: 'quitarle hierro', frase: 'Primera caída del día.' },
      { hecho: 'h1', giro: 'sorpresa', frase: 'Casi dos horas ya.' },
    ]);
  });

  test('JSON cortado por max_tokens: se quedan los candidatos completos', () => {
    const cut =
      '{"candidatos":[{"hecho":"h1","giro":"ánimo","frase":"Tres seguidas, Manu."},{"hecho":"h2","giro":"sorpr';
    assert.deepEqual(style.parseCandidates(cut), [{ hecho: 'h1', giro: 'ánimo', frase: 'Tres seguidas, Manu.' }]);
    assert.deepEqual(style.parseCandidates('{"candidatos":[{"hecho":"h1","giro":"áni'), []);
  });

  test('un solo objeto, el campo «texto» y el tope de candidatos', () => {
    assert.deepEqual(style.parseCandidates('{"hecho":"h1","giro":"x","frase":"Una frase."}'), [
      { hecho: 'h1', giro: 'x', frase: 'Una frase.' },
    ]);
    assert.equal(style.parseCandidates('{"candidatos":[{"hecho":"h1","texto":"Con texto."}]}')[0].frase, 'Con texto.');
    const four = JSON.stringify({
      candidatos: [1, 2, 3, 4].map((n) => ({ hecho: 'h1', giro: 'g', frase: `Frase ${n}.` })),
    });
    assert.equal(style.parseCandidates(four, 2).length, 2);
  });

  test('rankCandidates conserva el hecho y el giro y se los pasa al validador', () => {
    const seen = [];
    const { ranked } = style.rankCandidates([{ text: 'Una frase cualquiera.', hecho: 'h2', giro: 'guasa' }], {
      validate: (text, c) => {
        seen.push([text, c.hecho, c.giro]);
        return { ok: true };
      },
    });
    assert.deepEqual(seen, [['Una frase cualquiera.', 'h2', 'guasa']]);
    assert.equal(ranked[0].hecho, 'h2');
  });
});

describe('regla `hecho`: cada comentario parte de un hecho de la lista', () => {
  const facts = buildMomentFacts({
    game: 'Shadow of the Colossus',
    minutes: 110,
    player: 'Manu',
    deathCount: 3,
    events: [{ type: 'death', ts: NOW - 60_000, description: 'x' }],
    chatLines: [line('a', 'tienes que subir'), line('b', 'dale ya'), line('c', 'salta ahora')],
    now: NOW,
  });
  const id = (tipo) => facts.find((f) => f.tipo === tipo).id;
  const rule = (text, hecho) => q.validateCohost(text, { deathCount: 3, facts, hecho }).rule;

  test('un hecho declarado que no existe se rechaza', () => {
    assert.equal(rule('Tres seguidas, Manu. A la cuarta sale, que lo dice el FUA.', 'h9'), 'hecho');
  });

  test('declarar un hecho y hablar de otra cosa se rechaza', () => {
    assert.equal(rule('El FUA hoy viene con ganas de fiesta y de ruido.', id('tiempo')), 'hecho');
    assert.match(
      q.factProblem('El FUA hoy viene con ganas de fiesta.', { facts, hecho: id('tiempo') }),
      /no habla de él/,
    );
  });

  test('las frases que parten de su hecho pasan', () => {
    assert.equal(rule('Tres seguidas, Manu. A la cuarta sale, que lo dice el FUA.', id('suceso')), undefined);
    assert.equal(rule('Casi dos horas ya. ¿Quién sigue aquí desde el principio?', id('tiempo')), undefined);
    assert.equal(rule('Chat, ¿esos consejos los habéis probado vosotros alguna vez?', id('chat')), undefined);
  });

  test('sin hecho declarado vale el que toque la frase; si no toca ninguno, se rechaza', () => {
    assert.equal(rule('Casi dos horas ya. ¿Quién sigue aquí desde el principio?', ''), undefined);
    assert.equal(rule('El FUA hoy viene con ganas de fiesta y de ruido.', ''), 'hecho');
    assert.equal(q.factFor('Casi dos horas ya.', facts).tipo, 'tiempo');
  });

  test('el suceso que se comenta es un hecho abierto: no exige palabras concretas', () => {
    const withMoment = buildMomentFacts({
      game: 'Hades',
      player: 'Manu',
      moment: { kind: 'milestone', description: 'El canal llega a 100 seguidores.' },
      now: NOW,
    });
    assert.equal(withMoment[0].id, 'h1');
    assert.equal(withMoment[0].texto, 'El canal llega a 100 seguidores');
    assert.equal(
      q.factProblem('¡Cien ya! Esto se celebra con FUA.', { facts: withMoment.slice(0, 1), hecho: 'h1' }),
      '',
    );
    // un suceso solo se comenta a sí mismo: declarar otro hecho se rechaza
    assert.match(q.factProblem('¡Cien ya!', { facts: withMoment.slice(0, 1), hecho: 'h2' }), /no está en la lista/);
  });

  test('sin lista de hechos la regla no se aplica (hooks, tests antiguos)', () => {
    assert.equal(q.factProblem('Cualquier cosa.', { facts: [] }), '');
  });
});

describe('regla `giro`: la idea de la broma no va por temas vetados', () => {
  test('grupos de personas, etnias, vida personal y groserías', () => {
    assert.match(q.giroProblem('reírse de los gordos'), /grupos/);
    assert.match(q.giroProblem('chiste de gitanos'), /grupos|etnias/);
    assert.match(q.giroProblem('lo de la gordi y el gimnasio'), /vida personal/);
    assert.match(q.giroProblem('mandarlo a la mierda'), /grosería/);
    assert.equal(
      q.validateCohost('Tres seguidas, Manu. A la cuarta sale.', { deathCount: 3, giro: 'burla a las mujeres' }).rule,
      'giro',
    );
  });
  test('los giros de los ejemplos pasan; un giro vacío no se juzga', () => {
    for (const e of style.loadExamples().cohost) assert.equal(q.giroProblem(e.giro), '', e.giro);
    assert.equal(q.giroProblem(''), '');
  });
});

describe('regla `copia`: palabras del chat que no vienen de los hechos', () => {
  const chat = [
    line('gangar79', 'Si té he dicho que té tiene que separar para marcarlo'),
    line('gangar79', 'A chuparla'),
  ];

  test('una palabra poco común del chat basta («chupar» con «chuparla»)', () => {
    assert.ok(q.copiedFromChat('El chat sugiere chupar, pero la lucha es no caer', chat));
    assert.equal(q.copiedFromChat('cada coto de vlxj97 tendría gravedad propia', [line('vlxj97', 'coto')]), 'coto');
  });

  test('dos palabras corrientes del chat también; una sola no', () => {
    const lines = [line('a', 'mira debajo del asiento, a la derecha')];
    assert.ok(q.copiedFromChat('El chat mirando debajo del asiento', lines));
    assert.equal(q.copiedFromChat('Manu mira debajo de cada piedra', lines), '');
  });

  test('una cifra que solo está en el chat', () => {
    assert.equal(q.copiedFromChat('El directo va a 110 por hora', [line('a', 'levanto 110 en banca')]), '110');
    assert.equal(q.copiedFromChat('Van 12 caídas', [line('a', 'ya van 12')], { numbers: [12] }), '');
  });

  test('lo que viene de los hechos, del canal o del juego no es copia', () => {
    const lines = [line('a', 'ese coloso es enorme'), line('b', 'vaya consejos le dais al jefe')];
    assert.equal(
      q.copiedFromChat('El chat dando consejos y el jefe tan tranquilo', lines, {
        allowed: ['El chat le está dando consejos a Manu'],
      }),
      '',
    );
    assert.equal(q.copiedFromChat('Manu peleando con colosos', lines, { gameWords: ['shadow', 'colossus'] }), '');
    assert.equal(q.copiedFromChat('Manu peleando con colosos', lines), 'colosos');
    assert.equal(q.copiedFromChat('Cualquier frase', []), '');
  });

  test('wordRank: frecuentes delante, poco comunes fuera de la lista', () => {
    assert.ok(q.wordRank('de') < 10);
    assert.ok(q.wordRank('caída') < 5000);
    assert.equal(q.wordRank('chupar'), Infinity);
    assert.equal(q.wordRank('bozal'), Infinity);
  });

  test('validateCohost y validateTimerIA la aplican', () => {
    assert.equal(
      q.validateCohost('El chat sugiere separar y chupar, pero la lucha es no caer, ¿no?', {
        deathCount: 3,
        chatLines: chat,
      }).rule,
      'copia',
    );
    const timer = q.validateTimerIA('Manu sigue con calma mientras el chat insiste en chupar sin parar.', {
      deathCount: 3,
      chatLines: chat,
    });
    assert.equal(timer.ok, false);
    assert.match(timer.reason, /copia del chat/);
    assert.equal(style.positiveFix(timer.reason), 'Cuenta el hecho con tus propias palabras.');
  });
});

describe('otro juego, comparaciones, modismos y metáforas', () => {
  test('el cohost no nombra otro juego (del canal o conocido)', () => {
    const ctx = { deathCount: 3, game: 'Shadow of the Colossus', channelGames: channel.games_played };
    assert.equal(q.validateCohost('Manu juega esto con el oficio que le dejó Elden Ring.', ctx).rule, 'otro_juego');
    assert.equal(q.validateCohost('Esto ya huele a It Takes Two, Manu, y a mucho FUA.', ctx).rule, 'otro_juego');
    assert.equal(
      q.validateCohost('Manu sigue peleando con Shadow of the Colossus y el FUA lo aplaude con ganas.', ctx).ok,
      true,
    );
  });

  test('comparación forzada con objetos cotidianos', () => {
    assert.equal(
      q.validateCohost('El FUA aprieta igual que un despertador un lunes, Manu.', { deathCount: 3 }).rule,
      'comparacion',
    );
  });

  test('modismos fuera de sitio: vetados en los mensajes automáticos, no en las menciones', () => {
    const t = 'Media hora tan limpia que hasta el FUA tiene la cola entre las patas.';
    assert.equal(q.misusedIdiom(t), true);
    assert.equal(q.validateCohost(t, { deathCount: 3 }).rule, 'modismo');
    assert.equal(q.validateTimerIA(t, { deathCount: 3 }).ok, false);
    assert.equal(
      q.validateHook('¿Quién se va hoy con el rabo entre las piernas, Lusorums?', { deathCount: 3 }).ok,
      false,
    );
    assert.equal(q.validateMention('Te vas con el rabo entre las piernas, campeón.').ok, true);
    assert.equal(style.positiveFix('modismo'), 'Dilo con palabras llanas.');
  });

  test('isMetaphor reconoce las marcas y deja pasar las frases directas', () => {
    for (const t of [
      'Si el FUA fuera una ley de la física, el chat tendría gravedad propia.',
      'El chat ya está tirando FUA como si fueran confeti.',
      'El FUA es la gravedad del chat, siempre te tira hacia abajo.',
      'El ritmo está más intenso que una banca en plena noche.',
      'Ni que fuera el último jefe del mundo.',
    ])
      assert.equal(q.isMetaphor(t), true, t);
    for (const t of [
      'Primera caída del día. Ya está, ya nos la hemos quitado de encima.',
      '¡Jefe fuera! Yo no he hecho nada, pero me lo apunto.',
      '¿De qué os reís, que yo también quiero?',
    ])
      assert.equal(q.isMetaphor(t), false, t);
  });

  test('una metáfora por stream entre cohost, hook y resumen de media hora', () => {
    const first = 'Una hora y pico de directo y el chat ya está tirando FUA como si fueran confeti.';
    assert.equal(q.validateCohost(first, { deathCount: 3 }).ok, true);
    const used = new Set(q.streamMarks(first, 'Hades'));
    assert.ok(used.has('metafora'));
    const second = 'El FUA es la gravedad del chat, siempre te tira hacia abajo justo cuando te levantas!';
    assert.equal(q.validateCohost(second, { deathCount: 3, usedStructures: used }).rule, 'metafora');
    assert.equal(q.validateTimerIA(second, { deathCount: 3, usedStructures: used }).ok, false);
    assert.equal(
      q.validateHook('¿Manu juega como si fuera su primer día, Lusorums?', { deathCount: 3, usedStructures: used }).ok,
      false,
    );
    assert.equal(
      q.validateCohost('Manu sigue en pie y el FUA lo celebra a gritos.', { deathCount: 3, usedStructures: used }).ok,
      true,
    );
    assert.equal(style.positiveFix('metafora'), 'Di la idea directa, tal cual pasa.');
  });

  test('con la metáfora ya usada, el prompt pide frases directas', () => {
    const base = { form: style.COHOST_FORMS[0] };
    assert.doesNotMatch(style.buildCohostSystem(base), /tal cual pasan/);
    assert.match(
      style.buildCohostSystem({ ...base, plain: true }),
      /<ajustes>[^<]*Frase directa, que cuente las cosas tal cual pasan\./,
    );
  });
});

describe('formas y ejemplos del cohost', () => {
  test('las formas sencillas pesan más y nunca se repite la anterior', () => {
    const count = {};
    for (let i = 0; i < 900; i++) {
      const f = style.pickCohostForm('', () => i / 900);
      count[f.id] = (count[f.id] || 0) + 1;
    }
    assert.deepEqual(count, { reaccion: 300, exageracion: 200, pregunta: 200, autoironia: 100, vacile: 100 });
    for (let i = 0; i < 50; i++) assert.notEqual(style.pickCohostForm('reaccion', () => i / 50).id, 'reaccion');
  });

  test('ejemplos del cohost: hecho, giro y frase; pasan los filtros, sin nicks ni otros juegos, como mucho 2 metáforas', () => {
    const examples = style.loadExamples().cohost;
    assert.equal(examples.length, 10);
    for (const e of examples) {
      assert.ok(e.hecho && e.giro && e.texto, JSON.stringify(e));
      const check = q.validateCohost(e.texto, { deathCount: 12 });
      assert.equal(check.ok, true, `${e.texto} → ${check.reason}`);
      assert.doesNotMatch(e.texto, /@|\b\w*[a-z]\d\w*\b|vlxj97|markosssx|gangar/i, e.texto);
      assert.equal(q.mentionsOtherGame(e.texto, '', channel.games_played), null, e.texto);
      assert.doesNotMatch(e.texto, /abad[ií]a|Grecia|esbirros/i, e.texto);
    }
    assert.ok(examples.filter((e) => q.isMetaphor(e.texto)).length <= 2);
  });

  test('ejemplos del resumen de media hora: sin detalles de un juego concreto', () => {
    for (const e of style.loadExamples().timer) {
      assert.doesNotMatch(e, /puzle|exploraci[oó]n|forja/i, e);
      assert.equal(q.validateTimerIA(e, { deathCount: 3 }).ok, true, e);
    }
  });

  test('el ejemplo enseña el camino del hecho a la frase', () => {
    const out = style.renderExamples([{ hecho: 'Jefe superado', giro: 'presumir', texto: '¡Jefe fuera!' }]);
    assert.equal(
      out,
      '<ejemplos>\n<example><hecho>Jefe superado</hecho><giro>presumir</giro><frase>¡Jefe fuera!</frase></example>\n</ejemplos>',
    );
  });
});

// ─────────────────────────────── De punta a punta (IA falsa) ───────────────────────────────
describe('runCohost con hechos', () => {
  let sent, calls;
  const client = { say: (ch, msg) => sent.push(msg) };
  const text = (c) => ({ choices: [{ message: { content: c }, finish_reason: 'stop' }] });
  const isSelector = (p) => /editor de un chat/.test(p.messages[0].content);
  const stubModels = (fn) =>
    router.setTransport('groq', async (p) => {
      calls.push({ selector: isSelector(p), messages: p.messages });
      return fn(p, isSelector(p));
    });
  const generated = () => calls.filter((c) => !c.selector);
  const selectorCalls = () => calls.filter((c) => c.selector);
  // id del hecho de la lista del prompt cuyo texto casa con `re`
  const factId = (prompt, re) => (new RegExp(`(h\\d)\\. [^\\n]*${re.source}`).exec(prompt) || [])[1];
  // el selector elige el candidato que contiene `wanted` (llegan en orden aleatorio)
  const choose = (p, wanted) =>
    text(
      JSON.stringify({
        mejor:
          p.messages[1].content
            .split('\n')
            .filter((l) => /^\d+\) /.test(l))
            .findIndex((l) => l.includes(wanted)) + 1,
      }),
    );

  beforeEach(() => {
    sent = [];
    calls = [];
    state.resetAiBlocks();
    state.resetAiUsage();
    state.setStreamIsLive(true);
    state.setStreamStartedAt(Date.now() - 110 * 60000);
    state.resetBotHistory();
    state.resetNamedUsers();
    state.resetStreamNarrative();
    state.setDeathCount(5);
    ai.addToHistory('gangar79', 'Si té he dicho que té tiene que separar para marcarlo');
    ai.addToHistory('gangar79', 'A chuparla');
    ai.addToHistory('stewar32', 'dale por la espalda ya');
  });

  test('el modelo recibe hechos y no el chat; el candidato que copia jerga del chat se descarta', async () => {
    const GOOD = 'Cinco caídas y Manu sigue en pie, eso es tener FUA.';
    stubModels((p, sel) => {
      if (sel) return choose(p, 'sigue en pie');
      const h = factId(p.messages[1].content, /cinco caídas/);
      return text(
        JSON.stringify({
          candidatos: [
            {
              hecho: h,
              giro: 'repetir al chat',
              frase: 'El chat sugiere separar y chupar, pero la lucha es no caer, Manu.',
            },
            { hecho: h, giro: 'ánimo', frase: GOOD },
          ],
        }),
      );
    });
    assert.equal(await ai.runCohost(client, '#parlusorum', null), 'sent');
    assert.deepEqual(sent, [GOOD]);
    const user = generated()[0].messages[1].content;
    assert.match(user, /^<hechos>\nh1\. /);
    assert.match(user, /Manu lleva cinco caídas hoy/);
    assert.match(user, /Juegan a Shadow of the Colossus y juega Manu/);
    assert.match(user, /El chat le está dando consejos a Manu/);
    assert.doesNotMatch(user, /chupar|separar|espalda|gangar79|stewar32|user\d/);
    assert.doesNotMatch(generated()[0].messages[0].content, /chupar|separar|espalda|gangar79|stewar32/);
    // el selector recibe los mismos hechos y cada candidato con el hecho del que parte
    const pick = selectorCalls()[0].messages[1].content;
    assert.match(pick, /<hechos>\nh1\. /);
    assert.match(pick, /1\) \[h\d\] Cinco caídas y Manu sigue en pie/);
    assert.doesNotMatch(pick, /<chat>|chupar|separar|gangar79/);
  });

  test('si todos copian del chat, reintenta con la corrección en positivo y calla', async () => {
    stubModels((p, sel) => {
      if (sel) return text('{"mejor": 1}');
      return text(
        JSON.stringify({
          candidatos: [
            {
              hecho: 'h1',
              giro: 'repetir',
              frase: 'El chat sugiere separar y chupar, pero la lucha es no caer, Manu.',
            },
          ],
        }),
      );
    });
    assert.equal(await ai.runCohost(client, '#parlusorum', null), 'dropped');
    assert.equal(sent.length, 0);
    assert.equal(generated().length, 2);
    assert.match(
      generated()[1].messages[0].content,
      /<correccion>Cuenta el hecho con tus propias palabras\.<\/correccion>/,
    );
    assert.doesNotMatch(generated()[1].messages[0].content, /chupar|separar/);
  });

  test('el hecho que se comenta rota de tipo entre comentarios libres', async () => {
    const heads = [];
    stubModels((p, sel) => {
      if (sel) return text('{"mejor": 1}');
      const user = p.messages[1].content;
      heads.push(/h1\. ([^\n]+)/.exec(user)[1]);
      // cada comentario habla de su h1
      const frase = /caídas/.test(heads.at(-1))
        ? 'Cinco caídas y Manu sigue en pie, eso es tener FUA.'
        : /consejos/.test(heads.at(-1))
          ? 'Chat, ¿esos consejos los habéis probado vosotros alguna vez?'
          : /Juegan/.test(heads.at(-1))
            ? 'Menuda partida se está marcando Manu, que conste en acta.'
            : 'Casi dos horas ya. ¿Quién sigue aquí desde el principio?';
      return text(JSON.stringify({ candidatos: [{ hecho: 'h1', giro: 'guasa', frase }] }));
    });
    for (let i = 0; i < 4; i++) {
      state.resetBotHistory(); // sin parecido con el comentario anterior
      assert.equal(await ai.runCohost(client, '#parlusorum', null), 'sent', `comentario ${i + 1}`);
    }
    assert.equal(new Set(heads).size, 4, heads.join(' | '));
  });

  test('suceso: es el hecho h1 y un candidato que declara otro hecho se descarta', async () => {
    const GOOD = '¡Jefe fuera! Yo no he hecho nada, pero me lo apunto.';
    stubModels((p, sel) => {
      if (sel) return choose(p, 'Jefe fuera');
      return text(
        JSON.stringify({
          candidatos: [
            { hecho: 'h2', giro: 'el rato', frase: 'Casi dos horas ya. ¿Quién sigue aquí desde el principio?' },
            { hecho: 'h1', giro: 'presumir sin mérito', frase: GOOD },
          ],
        }),
      );
    });
    // un minuto después del comentario anterior: los sucesos guardan una separación mínima entre sí
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    let out;
    try {
      out = await ai.runCohost(client, '#parlusorum', {
        kind: 'boss',
        description: 'Jefe derrotado, el primero de este stream',
      });
    } finally {
      Date.now = realNow;
    }
    assert.equal(out, 'sent');
    assert.deepEqual(sent, [GOOD]);
    const user = generated()[0].messages[1].content;
    assert.match(user, /^<hechos>\nh1\. Jefe derrotado, el primero de este stream\n/);
    assert.match(user, /Comenta el suceso, que es el hecho h1/);
    assert.equal(
      selectorCalls()[0].messages[1].content.includes('Casi dos horas'),
      false,
      'solo llega al selector el que parte del suceso',
    );
  });
});
