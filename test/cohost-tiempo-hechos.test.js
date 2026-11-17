// Directo del 13-11, puntos 4 y 11: el cohost habló del rato de directo en 9 de 25 comentarios y los tres candidatos partían
// del mismo hecho. Ahora: el rato sale como mucho una vez por hora, cada candidato parte de un hecho distinto, sin sucesos ni
// charla se pregunta al chat por el juego (ficha de IGDB) y no se copian los ejemplos del prompt. Todo sin red.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';
process.env.CHANNEL = process.env.CHANNEL || 'parlusorum';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const GAME = 'Shadow of the Colossus';
let sheet = null; // ficha de IGDB que ve el cohost en cada test
const apiPath = require.resolve('../src/twitch/api');
require(apiPath);
const api = require.cache[apiPath].exports;
api.getCurrentGame = async () => ({ game: GAME });
api.lookupGameInfo = async () => ({ info: sheet });
api.getGameInfo = async () => null;

const router = require('../src/utils/ai-router');
const state = require('../src/utils/state');
const style = require('../src/ai/style');
const q = require('../src/ai/quality');
const {
  buildMomentFacts,
  blockedChatTopics,
  chatTopic,
  factDue,
  gameQuestion,
  FACT_GAP_MS,
} = require('../src/ai/moment-facts');
const { cachedSummaryEs, resetSummaryCache, summarizeGameEs } = require('../src/ai/game-sheet');
const ai = require('../src/ai/handler');

const NOW = 1_000_000_000;
const EXAMPLES = style.loadExamples().cohost.map((e) => e.texto);
const PREMISE = 'Un joven recorre una tierra prohibida para salvar a una chica.';
const SHEET = {
  name: GAME,
  released: '2005-10-18',
  developers: 'Team Ico',
  genres: 'Adventure, Puzzle',
  description: 'Tales recount the story of Wander and his horse Agro.',
};

// Los comentarios de tiempo reales de la tarde del 13-11
const TIME_13_11 = [
  'Una hora ya, ¿quién sigue despierto?',
  '¡Dos horas en el stream y yo sigo aquí, como si el tiempo fuera un bucle celestial!',
  'Una hora y pico ya. ¿Quién sigue aquí desde el principio?',
  'Ya casi dos horas, ¿quién se atreve a marcar el récord de paciencia?',
  'Dos horas y media y todavía no se han cansado, ¿o será que el FUA les da energía infinita?',
  'FUA, ¡tres horas de directo y aún no han dicho ‘fin’!',
  'Cuatro horas al mando, ¿qué ha pasado ya en el chat que todavía no nos habéis contado?',
  'Cuatro horas y media y seguimos aquí, ¿qué no se les ha caído el móvil?',
];

describe('talksStreamTime y la regla `tiempo`', () => {
  test('los comentarios de tiempo del 13-11 se reconocen', () => {
    for (const t of TIME_13_11) assert.equal(q.talksStreamTime(t), true, t);
  });

  test('todo lo que escribe approxDuration se reconoce como tiempo', () => {
    for (const m of [25, 45, 60, 75, 95, 110, 125, 150, 215, 290])
      assert.equal(q.talksStreamTime(`Llevan ${q.approxDuration(m)} de directo`), true, q.approxDuration(m));
  });

  test('lo que no habla del rato de directo no cuenta', () => {
    for (const t of [
      'Manu lleva un buen rato peleando con ese jefe.',
      'A estas horas el FUA no perdona.',
      'Menuda partida se está marcando Manu, que conste en acta.',
      'Cinco caídas y Manu sigue en pie, eso es tener FUA.',
      '¡Jefe fuera! Manu lo tumba y el FUA lo celebra a gritos.',
    ])
      assert.equal(q.talksStreamTime(t), false, t);
  });

  test('sin el hecho de tiempo entre los ofrecidos, un comentario de tiempo se rechaza', () => {
    for (const t of TIME_13_11)
      assert.equal(q.validateCohost(t, { deathCount: 1, timeOffered: false }).rule, 'tiempo', t);
    const ok = 'Dos horas y media y todavía no se han cansado, ¿o será que el FUA les da energía infinita?';
    assert.equal(q.validateCohost(ok, { deathCount: 1, timeOffered: true }).ok, true);
    assert.equal(q.validateCohost(ok, { deathCount: 1 }).ok, true, 'sin timeOffered la regla no se aplica');
    assert.equal(style.positiveFix('tiempo'), 'Cuenta otro hecho de la lista: la partida, el chat o quien juega.');
  });

  test('«como si el tiempo fuera un bucle celestial»: metáfora, vetada si ya salió una en el stream', () => {
    const t = TIME_13_11[1];
    assert.equal(q.isMetaphor(t), true);
    assert.equal(
      q.validateCohost(t, { deathCount: 1, timeOffered: true, usedStructures: new Set(['metafora']) }).rule,
      'metafora',
    );
  });
});

describe('moldes gastados y copias de los ejemplos', () => {
  test('«¿quién sigue despierto?» y «¿quién sigue aquí…?» se rechazan aunque el tiempo esté ofrecido', () => {
    for (const t of [
      TIME_13_11[0],
      TIME_13_11[2],
      'Tres horas ya. ¿Quiénes siguen aquí con nosotros?',
      'Lusorums, ¿seguís ahí desde el principio o habéis llegado tarde?',
    ]) {
      assert.ok(q.wornMould(t), t);
      assert.equal(q.validateCohost(t, { deathCount: 1, timeOffered: true }).rule, 'molde', t);
    }
    for (const t of ['Manu sigue aquí, peleando con el mando.', '¿Quién se atreve a decir cuántos intentos más?'])
      assert.equal(q.wornMould(t), '', t);
    assert.equal(style.positiveFix('molde'), 'Cambia de enfoque con una idea nueva y tuya.');
  });

  test('una frase casi idéntica a un ejemplo del prompt se rechaza', () => {
    const copies = [
      'Chat, ¿esos consejos los habéis probado vosotros alguna vez?',
      'Chat, ¿esos consejos los habéis probado alguna vez vosotros en casa?',
      'Primera caída del día. Ya nos la hemos quitado de encima.',
    ];
    for (const t of copies) {
      assert.ok(q.copiesExample(t, EXAMPLES), t);
      assert.equal(q.validateCohost(t, { deathCount: 3, examples: EXAMPLES }).rule, 'ejemplo', t);
    }
    assert.equal(style.positiveFix('ejemplo'), 'Escribe una frase propia, con otra idea que la de los ejemplos.');
  });

  test('una frase propia que comparte una o dos palabras con un ejemplo pasa', () => {
    for (const t of [
      'Cinco caídas y Manu sigue en pie, eso es tener FUA.',
      '¡Jefe fuera! Manu lo tumba y el FUA lo celebra a gritos.',
      'Primera caída de Manu, que no cunda el pánico.',
      'Chat, menudos consejos le dais a Manu, ¿vosotros los seguís?',
    ])
      assert.equal(q.copiesExample(t, EXAMPLES), '', t);
    assert.equal(q.copiesExample('Cualquier frase', []), '');
  });

  test('ningún ejemplo del prompt es un molde gastado ni copia de otro ejemplo', () => {
    for (const e of EXAMPLES) {
      assert.equal(q.wornMould(e), '', e);
      assert.equal(
        q.copiesExample(
          e,
          EXAMPLES.filter((x) => x !== e),
        ),
        '',
        e,
      );
    }
  });
});

describe('abbreviatedGame: siglas de sagas', () => {
  test('«FF XVI», «GTA», «RE» y «SOTC» en vez del título entero', () => {
    assert.equal(q.abbreviatedGame('Manu en FF XVI, ¿será él el héroe?', 'FINAL FANTASY XVI'), 'FF');
    assert.equal(q.abbreviatedGame('Manu con el GTA de siempre', 'Grand Theft Auto V'), 'GTA');
    assert.equal(q.abbreviatedGame('Manu con el gta de siempre', 'Grand Theft Auto V'), 'GTA');
    assert.equal(q.abbreviatedGame('Otra tarde de RE, Manu', 'Resident Evil 4'), 'RE');
    assert.equal(q.abbreviatedGame('Vaya SOTC se está marcando', GAME), 'SOTC');
    const v = q.validateCohost('Manu en FF XVI, ¿será él el héroe o el villano que nos hace perder la partida?', {
      deathCount: 1,
      game: 'FINAL FANTASY XVI',
    });
    assert.equal(v.rule, 'juego_nombre');
    assert.match(v.reason, /«FF»/);
  });

  test('el título entero, las palabras corrientes y las siglas que también son palabras no cuentan', () => {
    assert.equal(q.abbreviatedGame('Manu en Final Fantasy XVI, qué tarde', 'FINAL FANTASY XVI'), '');
    assert.equal(q.abbreviatedGame('Al final del directo lo vemos', 'FINAL FANTASY XVI'), '');
    assert.equal(q.abbreviatedGame('Esto me recuerda a otra cosa', 'Resident Evil 4'), '', '«re» en minúsculas');
    assert.equal(q.abbreviatedGame('Un sos de manual, Manu', 'Sea of Stars'), '', '«sos» es una palabra');
    assert.equal(q.abbreviatedGame('Hades es otra cosa', 'Hades'), '');
  });
});

describe('hechos que salen una vez por hora', () => {
  test('factDue: nunca comentado o hace una hora o más', () => {
    assert.equal(FACT_GAP_MS, 60 * 60 * 1000);
    assert.equal(factDue(0, NOW), true);
    assert.equal(factDue(NOW - 59 * 60000, NOW), false);
    assert.equal(factDue(NOW - 60 * 60000, NOW), true);
  });

  test('state: markFactUse / getFactUse cuentan y se reinician con el stream', () => {
    state.resetBotHistory();
    assert.deepEqual(state.getFactUse('tiempo'), { at: 0, count: 0 });
    state.markFactUse('tiempo', 500);
    state.markFactUse('tiempo', 900);
    assert.deepEqual(state.getFactUse('tiempo'), { at: 900, count: 2 });
    assert.deepEqual(state.getFactUse('pregunta'), { at: 0, count: 0 });
    state.resetBotHistory();
    assert.deepEqual(state.getFactUse('tiempo'), { at: 0, count: 0 });
  });

  test('offerTime=false: el rato de directo no se ofrece', () => {
    const base = { game: GAME, minutes: 150, player: 'Manu', deathCount: 2, now: NOW };
    assert.ok(buildMomentFacts(base).some((f) => f.tipo === 'tiempo'));
    const sin = buildMomentFacts({ ...base, offerTime: false });
    assert.ok(!sin.some((f) => f.tipo === 'tiempo'));
    assert.ok(!sin.some((f) => q.talksStreamTime(f.texto)));
  });

  test('si el único hecho es el rato de directo, no hay nada que comentar', () => {
    assert.deepEqual(buildMomentFacts({ minutes: 150, now: NOW }), []);
    assert.deepEqual(buildMomentFacts({ minutes: 150, now: NOW, offerTime: false }), []);
  });
});

describe('hecho `pregunta`: una pregunta al chat sobre el juego', () => {
  test('gameQuestion se basa en de qué va el juego (el resumen en español), no en género ni año', () => {
    assert.equal(
      gameQuestion(SHEET, { game: GAME, premise: PREMISE }),
      `${GAME} va de esto: Un joven recorre una tierra prohibida para salvar a una chica`,
    );
    assert.doesNotMatch(gameQuestion(SHEET, { game: GAME, premise: PREMISE }), /género|aventura|2005/);
  });

  test('sin resumen en caché (o sin ficha) no hay pregunta: no se inventa', () => {
    assert.equal(gameQuestion(SHEET, { game: GAME }), null);
    assert.equal(gameQuestion(SHEET, { game: GAME, premise: '  ' }), null);
    assert.equal(gameQuestion(null, { game: GAME }), null);
    assert.equal(gameQuestion({ name: GAME }, { game: GAME }), null);
    assert.equal(
      gameQuestion(SHEET, { premise: PREMISE }),
      `${GAME} va de esto: Un joven recorre una tierra prohibida para salvar a una chica`,
      'usa el nombre de la ficha',
    );
  });

  test('cachedSummaryEs no llama a la IA: sin caché devuelve vacío', () => {
    resetSummaryCache();
    assert.equal(cachedSummaryEs(GAME), '');
  });

  test('solo entra si no hay sucesos ni charla que contar', () => {
    const question = gameQuestion(SHEET, { game: GAME, premise: PREMISE });
    const calm = buildMomentFacts({ game: GAME, minutes: 150, player: 'Manu', now: NOW, question });
    assert.deepEqual(
      calm.map((f) => f.tipo),
      ['estado', 'pregunta', 'tiempo'],
    );
    assert.equal(
      calm[1].texto,
      `Para preguntar al chat: ${GAME} va de esto: Un joven recorre una tierra prohibida para salvar a una chica`,
    );
    const withDeaths = buildMomentFacts({
      game: GAME,
      minutes: 150,
      player: 'Manu',
      deathCount: 3,
      now: NOW,
      question,
    });
    assert.ok(!withDeaths.some((f) => f.tipo === 'pregunta'));
    const withChat = buildMomentFacts({
      game: GAME,
      player: 'Manu',
      now: NOW,
      question,
      chatLines: ['a', 'b', 'c'].map((username) => ({ username, message: 'tienes que saltar ya' })),
    });
    assert.ok(!withChat.some((f) => f.tipo === 'pregunta'));
    const event = buildMomentFacts({
      game: GAME,
      player: 'Manu',
      now: NOW,
      question,
      moment: { description: 'Sub nueva.' },
    });
    assert.ok(!event.some((f) => f.tipo === 'pregunta'));
  });

  test('el comentario de ese hecho tiene que ser una pregunta', () => {
    const facts = buildMomentFacts({
      game: GAME,
      player: 'Manu',
      now: NOW,
      question: gameQuestion(SHEET, { game: GAME, premise: PREMISE }),
    });
    const id = facts.find((f) => f.tipo === 'pregunta').id;
    const rule = (t) => q.validateCohost(t, { deathCount: 0, facts, hecho: id, game: GAME }).rule;
    assert.equal(rule('¿A quién le gustan los juegos de aventura como este, Lusorums?'), undefined);
    assert.equal(rule('A los Lusorums les gustan los juegos de aventura, eso está claro.'), 'pregunta');
    assert.equal(style.positiveFix('pregunta'), 'Termina con una pregunta al chat.');
  });
});

describe('prompt del cohost: un candidato por hecho', () => {
  const base = { form: style.COHOST_FORMS[0] };
  const task = (opts) => /<tarea>([\s\S]*)<\/tarea>/.exec(style.buildCohostSystem({ ...base, ...opts }))[1];
  const fact = (n, tipo = 'estado') => ({ id: `h${n}`, tipo });

  test('con tres hechos: el primero de h1, el segundo de h2 y el tercero de h3', () => {
    const t = task({ facts: [fact(1), fact(2, 'suceso'), fact(3, 'chat'), fact(4, 'tiempo')] });
    assert.match(t, /^Escribe 3 comentarios, todos con esa forma y cada uno sobre un hecho distinto/);
    assert.match(t, /el primero parte del hecho h1, el segundo parte del hecho h2 y el tercero parte del hecho h3/);
    assert.match(t, /\{"hecho":"h1","giro":"…","frase":"…"\},\{"hecho":"h2",[^}]+\},\{"hecho":"h3",[^}]+\}/);
    assert.doesNotMatch(t, /h4/);
  });

  test('con dos hechos: dos candidatos; con COHOST_CANDIDATES=2 nunca más de dos', () => {
    const t = task({ facts: [fact(1), fact(2, 'tiempo')] });
    assert.match(t, /^Escribe 2 comentarios, /);
    assert.match(t, /el primero parte del hecho h1 y el segundo parte del hecho h2/);
    assert.doesNotMatch(t, /h3/);
    const two = task({ facts: [fact(1), fact(2), fact(3)], candidates: 2 });
    assert.match(two, /^Escribe 2 comentarios, /);
    assert.doesNotMatch(two, /h3/);
  });

  test('con un solo hecho: dos giros distintos; si es el rato de directo, uno', () => {
    const one = task({ facts: [fact(1)] });
    assert.match(one, /^Escribe 2 comentarios con giros distintos entre sí sobre el hecho h1/);
    assert.equal((one.match(/"hecho":"h1"/g) || []).length, 2);
    const time = task({ facts: [fact(1, 'tiempo')] });
    assert.match(time, /^Escribe 1 comentario sobre el hecho h1/);
    assert.equal((time.match(/"hecho":"h1"/g) || []).length, 1);
  });

  test('el hecho `pregunta` pide una pregunta al chat', () => {
    assert.match(
      task({ facts: [fact(1), fact(2, 'pregunta')] }),
      /El comentario del hecho h2 es una pregunta al chat sobre de qué va el juego, con la idea del dato\./,
    );
    assert.doesNotMatch(task({ facts: [fact(1), fact(2, 'tiempo')] }), /pregunta al chat/);
  });

  test('con suceso todo sigue igual: tres ángulos del hecho h1', () => {
    const t = task({ event: true, facts: [fact(1, 'suceso'), fact(2)] });
    assert.match(t, /^Escribe 3 comentarios distintos entre sí, todos con esa forma, sobre el suceso \(el hecho h1\)/);
    assert.equal((t.match(/"hecho":"h1"/g) || []).length, 3);
    assert.doesNotMatch(t, /h2|candidatos":\[\]/);
  });

  test('el rato de directo no está en <stream>: solo llega como hecho', () => {
    const p = style.buildCohostSystem({ ...base, game: GAME, minutes: 150, deathLine: '2 caídas anotadas.' });
    const stream = /<stream>([^<]*)<\/stream>/.exec(p)[1];
    assert.match(stream, /Juegan a «Shadow of the Colossus»\. 2 caídas anotadas\./);
    assert.equal(q.talksStreamTime(stream), false, stream);
    assert.doesNotMatch(stream, /Llevan|directo/);
  });
});

describe('rankCandidates: como mucho un candidato por hecho', () => {
  const ok = () => ({ ok: true });
  const three = [
    { text: 'Dos horas de directo y Manu sin soltar el mando.', hecho: 'h1' },
    { text: 'Dos horas ya y el FUA tan fresco, Lusorums.', hecho: 'h1' },
    { text: 'Dos horas jugando y nadie quiere parar todavía.', hecho: 'h1' },
  ];

  test('tres candidatos del mismo hecho: se queda uno', () => {
    const { ranked, failures } = style.rankCandidates(three, { validate: ok, groupOf: (c) => c.hecho });
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].text, three[0].text);
    assert.deepEqual(
      failures.map((f) => f.rule),
      ['mismo_hecho', 'mismo_hecho'],
    );
    assert.equal(style.positiveFix('mismo_hecho'), 'Cada comentario parte de un hecho distinto de la lista.');
  });

  test('declaran hechos distintos pero los tres hablan del rato: cuentan como el mismo', () => {
    const disguised = three.map((c, i) => ({ ...c, hecho: `h${i + 1}` }));
    const groupOf = (c) => (q.talksStreamTime(c.text) ? 'tiempo' : c.hecho);
    assert.equal(style.rankCandidates(disguised, { validate: ok, groupOf }).ranked.length, 1);
  });

  test('uno por hecho pasa entero; si el primero falla la validación, vale el siguiente del mismo hecho', () => {
    const mixed = [
      { text: 'Menuda partida se está marcando Manu.', hecho: 'h1' },
      { text: 'Cinco caídas y Manu sigue en pie.', hecho: 'h2' },
      { text: 'Chat, menudos consejos le dais a Manu.', hecho: 'h3' },
    ];
    assert.equal(style.rankCandidates(mixed, { validate: ok, groupOf: (c) => c.hecho }).ranked.length, 3);
    const { ranked } = style.rankCandidates(three, {
      validate: (t) => ({ ok: t !== three[0].text, rule: 'x' }),
      groupOf: (c) => c.hecho,
    });
    assert.deepEqual(
      ranked.map((r) => r.text),
      [three[1].text],
    );
  });

  test('sin groupOf (sucesos) no se agrupa; un hecho sin declarar tampoco', () => {
    assert.equal(style.rankCandidates(three, { validate: ok }).ranked.length, 3);
    const undeclared = three.map((c) => ({ ...c, hecho: '' }));
    assert.equal(style.rankCandidates(undeclared, { validate: ok, groupOf: (c) => c.hecho }).ranked.length, 3);
  });
});

// ─────────────────────────────── De punta a punta (IA falsa) ───────────────────────────────
describe('runCohost: tiempo una vez por hora, un candidato por hecho y pregunta sobre el juego', () => {
  let sent, calls, offset;
  const realNow = Date.now;
  const client = { say: (ch, msg) => sent.push({ msg, at: Date.now() }) };
  const text = (c) => ({ choices: [{ message: { content: c }, finish_reason: 'stop' }] });
  const kindOf = (p) =>
    /editor de un chat/.test(p.messages[0].content)
      ? 'selector'
      : /(?:verificador|revisor) estricto/.test(p.messages[0].content)
        ? 'review'
        : 'gen';
  const stubModels = (fn) =>
    router.setTransport('groq', async (p) => {
      const kind = kindOf(p);
      calls.push({ kind, messages: p.messages });
      if (kind === 'review') return text('NO');
      if (kind === 'selector') return text('{"mejor": 1}');
      return text(JSON.stringify({ candidatos: fn(p.messages[1].content, p.messages[0].content) }));
    });
  const generated = () => calls.filter((c) => c.kind === 'gen');
  const factId = (prompt, re) => (new RegExp(`(h\\d)\\. [^\\n]*${re.source}`).exec(prompt) || [])[1];
  const chatter = (n) => ai.addToHistory(`lusorum${n % 3}`, ['hola buenas', 'qué tal todo', 'buenas tardes'][n % 3]);
  const startStream = (minutesAgo) => {
    state.setStreamIsLive(true);
    state.setStreamStartedAt(Date.now() - minutesAgo * 60000);
  };

  beforeEach(() => {
    sent = [];
    calls = [];
    offset = 0;
    sheet = null;
    Date.now = () => realNow() + offset;
    state.resetAiBlocks();
    state.resetAiUsage();
    state.resetBotHistory();
    state.resetNamedUsers();
    state.resetStreamNarrative();
    state.setDeathCount(0);
  });
  afterEach(() => {
    Date.now = realNow;
  });

  test('tarde del 13-11 (sin sucesos, el modelo insiste con el tiempo): un comentario de tiempo por hora como mucho', async () => {
    // Una frase distinta por hora, para que no las tumbe el parecido con las anteriores
    const PHRASES = [
      'Una hora de directo y Manu sin soltar el mando.',
      'Dos horas ya, Lusorums, y el FUA tan fresco.',
      'Tres horas jugando y nadie quiere parar todavía.',
      'Cuatro horas de aventura, menudo aguante tiene Manu.',
    ];
    offset = 24 * 60 * 60000; // lejos de los demás tests: los topes por hora no se cruzan
    startStream(60);
    const t0 = Date.now();
    stubModels((user) => {
      const hours = Math.floor((Date.now() - t0) / 3600000);
      const time = factId(user, /de directo/);
      const frase = PHRASES[hours];
      // los tres candidatos hablan del rato, declaren el hecho que declaren (como el 13-11)
      return [
        { hecho: time || 'h1', giro: 'el aguante', frase },
        { hecho: 'h1', giro: 'el aguante', frase: frase.replace(/\.$/, ', que conste en la partida.') },
        { hecho: 'h1', giro: 'el aguante', frase: frase.replace(/\.$/, ' con este juego.') },
      ];
    });
    const offered = [];
    for (let step = 0; step < 16; step++) {
      chatter(step);
      const before = generated().length;
      await ai.runCohost(client, '#parlusorum', null);
      const prompt = generated()[before]?.messages[1].content || '';
      offered.push(/de directo/.test(prompt));
      offset += 15 * 60000;
    }
    // 4 horas, un intento cada cuarto de hora: el hecho de tiempo solo se ofrece una vez por hora…
    assert.deepEqual(
      offered.map((o, i) => (o ? i : null)).filter((i) => i !== null),
      [0, 4, 8, 12],
    );
    // …y aunque el modelo hable del rato en los 16 intentos, solo salen 4 comentarios, separados una hora
    assert.deepEqual(
      sent.map((s) => s.msg),
      PHRASES,
    );
    for (let i = 1; i < sent.length; i++) assert.ok(sent[i].at - sent[i - 1].at >= 60 * 60000, `hueco ${i}`);
    assert.ok(state.getCohostStats().discards['quality:tiempo'] >= 12, JSON.stringify(state.getCohostStats().discards));
  });

  test('cada candidato parte de un hecho distinto; tres del mismo hecho dejan uno solo para el selector', async () => {
    offset = 48 * 60 * 60000;
    startStream(110);
    state.setDeathCount(5);
    ai.addToHistory('ana', 'tienes que saltar ya');
    ai.addToHistory('luis', 'dale por arriba');
    ai.addToHistory('eva', 'sube ahora');
    stubModels((user) => {
      const h = factId(user, /cinco caídas/);
      return [
        { hecho: h, giro: 'ánimo', frase: 'Cinco caídas y Manu sigue en pie, eso es tener FUA.' },
        { hecho: h, giro: 'exagerar', frase: 'Cinco caídas ya, Manu, y el suelo empieza a saludar.' },
        { hecho: h, giro: 'vacile', frase: 'Cinco caídas lleva Manu y el FUA no se rinde nunca.' },
      ];
    });
    assert.equal(await ai.runCohost(client, '#parlusorum', null), 'sent');
    const [gen] = generated();
    assert.match(gen.messages[0].content, /el primero parte del hecho h1, el segundo parte del hecho h2 y el tercero/);
    assert.match(gen.messages[1].content, /Cada comentario parte de un hecho distinto de la lista/);
    assert.doesNotMatch(/<stream>[^<]*<\/stream>/.exec(gen.messages[0].content)[0], /Llevan|de directo/);
    const pick = calls.find((c) => c.kind === 'selector').messages[1].content;
    assert.equal(pick.split('\n').filter((l) => /^\d+\) /.test(l)).length, 1, pick);
    assert.equal(sent.length, 1);
  });

  test('sin sucesos ni charla: pregunta al chat sobre de qué va el juego, solo con resumen en caché y una vez por directo', async () => {
    offset = 72 * 60 * 60000;
    sheet = SHEET;
    startStream(10); // aún no hay rato de directo que contar
    const QUESTION = '¿Quién sabe de qué va Shadow of the Colossus, Lusorums?';
    const offered = () => generated().at(-1).messages[1].content;
    const ask = () =>
      stubModels((user) => {
        const h = factId(user, /Para preguntar al chat/);
        return h ? [{ hecho: h, giro: 'curiosidad', frase: QUESTION }] : [];
      });

    // sin resumen en caché la pregunta no se ofrece (ni género ni año como sustituto)
    resetSummaryCache();
    ask();
    chatter(0);
    await ai.runCohost(client, '#parlusorum', null);
    assert.doesNotMatch(offered(), /Para preguntar al chat/);
    assert.equal(state.getFactUse('pregunta').count, 0);

    // con el resumen ya generado sí, con la premisa
    router.setTransport('groq', async () => text(PREMISE));
    await summarizeGameEs(SHEET);
    ask();
    offset += 15 * 60000;
    chatter(1);
    assert.equal(await ai.runCohost(client, '#parlusorum', null), 'sent');
    assert.match(offered(), new RegExp(`Para preguntar al chat: ${GAME} va de esto: Un joven recorre`));
    assert.match(generated().at(-1).messages[0].content, /El comentario del hecho h\d es una pregunta al chat/);
    assert.equal(sent.at(-1).msg, QUESTION);
    assert.equal(state.getFactUse('pregunta').count, 1);

    // una sola vez por directo: ni una hora ni cuatro después
    for (const extra of [50, 180]) {
      offset += extra * 60000;
      chatter(2);
      const before = generated().length;
      await ai.runCohost(client, '#parlusorum', null);
      assert.doesNotMatch(generated()[before].messages[1].content, /Para preguntar al chat/);
    }
  });

  test('un tema del chat (risas) sale como mucho una vez por hora y cae al siguiente tema', async () => {
    offset = 72 * 60 * 60000;
    startStream(10);
    resetSummaryCache();
    const laugh = (n) => ai.addToHistory(`risas${n}`, 'jajajajaja');
    stubModels((user) => {
      const h = factId(user, /El chat/);
      return h ? [{ hecho: h, giro: 'reaccion', frase: 'Qué risa tiene el chat, Manu, pura guasa del FUA.' }] : [];
    });
    laugh(1);
    laugh(2);
    laugh(3);
    await ai.runCohost(client, '#parlusorum', null);
    assert.match(generated().at(-1).messages[1].content, /El chat se está riendo bastante/);
    assert.equal(state.getFactUse('chat_risas').count, 1);

    // 20 minutos después: las risas ya salieron; sin otro tema, el hecho de chat no se ofrece
    offset += 20 * 60000;
    laugh(4);
    laugh(5);
    laugh(6);
    await ai.runCohost(client, '#parlusorum', null);
    assert.doesNotMatch(generated().at(-1).messages[1].content, /El chat se está riendo/);

    // pasada la hora vuelve a poder salir
    offset += 61 * 60000;
    laugh(7);
    laugh(8);
    laugh(9);
    await ai.runCohost(client, '#parlusorum', null);
    assert.match(generated().at(-1).messages[1].content, /El chat se está riendo bastante/);
  });
});

describe('temas del chat: una vez por hora (chatTopic con skip)', () => {
  const lines = (msg, users = ['a', 'b', 'c']) => users.map((username) => ({ username, message: msg }));
  const NOW2 = 5_000_000_000;

  test('chatTopic salta las categorías bloqueadas y cae a la siguiente', () => {
    const both = [...lines('jajajajaja'), ...lines('tienes que esquivar a la izquierda', ['d', 'e', 'f'])];
    assert.equal(chatTopic(both, { player: 'Manu' }).categoria, 'consejos');
    assert.equal(chatTopic(both, { player: 'Manu', skip: ['consejos'] }).categoria, 'risas');
    assert.equal(chatTopic(both, { player: 'Manu', skip: ['consejos', 'risas'] }), null);
    assert.equal(chatTopic(lines('jajajajaja'), { player: 'Manu', skip: ['risas'] }), null);
  });

  test('blockedChatTopics: bloqueadas durante una hora tras comentarse', () => {
    state.resetBotHistory();
    assert.deepEqual(blockedChatTopics(state.getFactUse, NOW2), []);
    state.markFactUse('chat_risas', NOW2 - 10 * 60000);
    assert.deepEqual(blockedChatTopics(state.getFactUse, NOW2), ['risas']);
    assert.deepEqual(blockedChatTopics(state.getFactUse, NOW2 + 51 * 60000), []);
    state.resetBotHistory();
  });

  test('buildMomentFacts con skipChat no ofrece el tema bloqueado', () => {
    const chatLines = lines('jajajajaja');
    const base = { game: GAME, player: 'Manu', now: NOW2, chatLines };
    assert.ok(buildMomentFacts(base).some((f) => f.tipo === 'chat' && f.categoria === 'risas'));
    assert.ok(!buildMomentFacts({ ...base, skipChat: ['risas'] }).some((f) => f.tipo === 'chat'));
  });
});
