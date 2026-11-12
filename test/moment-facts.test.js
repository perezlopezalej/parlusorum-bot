// Hechos del momento: frases neutras del código, sin nicks ni jerga del chat.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildMomentFacts, chatTopic, classifyLine, gameVocabulary, renderFacts } = require('../src/ai/moment-facts');

const line = (username, message) => ({ username, message });
const NOW = 1_000_000_000;

describe('classifyLine', () => {
  test('categorías', () => {
    assert.equal(classifyLine('jajajajaja'), 'risas');
    assert.equal(classifyLine('KEKW'), 'risas');
    assert.equal(classifyLine('tienes que subir por la derecha'), 'consejos');
    assert.equal(classifyLine('vamos Manu tu puedes'), 'animos');
    assert.equal(classifyLine('qué tal el boss este?'), 'juego');
    assert.equal(classifyLine('alguien sabe cuánto dura esto?'), 'preguntas');
  });

  test('charla ajena, comandos, etnias y vida personal no cuentan', () => {
    assert.equal(classifyLine('hoy he comido arroz con pollo'), null);
    assert.equal(classifyLine('!muertes'), null);
    assert.equal(classifyLine('mira que gitano es el boss'), null);
    assert.equal(classifyLine('tienes que ir al gimnasio con la gordi'), null);
  });
});

describe('chatTopic', () => {
  test('consejos de 2+ usuarios → frase neutra sin copiar palabras del chat', () => {
    const t = chatTopic(
      [
        line('ana', 'tienes que chupar la pared con el escudo'),
        line('bea', 'dale por la espalda'),
        line('carlos', 'jajaja'),
      ],
      { player: 'Manu' },
    );
    assert.equal(t.categoria, 'consejos');
    assert.equal(t.texto, 'El chat le está dando consejos a Manu');
    assert.ok(!/chupar|pared|escudo|espalda/.test(t.texto));
  });

  test('un solo usuario no hace tema', () => {
    const t = chatTopic([line('ana', 'dale por la espalda'), line('ana', 'sube ya'), line('ana', 'baja un poco')]);
    assert.equal(t, null);
  });

  test('pocas líneas o charla ajena: sin tema', () => {
    assert.equal(chatTopic([line('a', 'jajaja'), line('b', 'jajaja')]), null);
    assert.equal(
      chatTopic([line('a', 'mañana cobro la nómina'), line('b', 'yo trabajo el finde'), line('c', 'qué calor hace')]),
      null,
    );
  });

  test('un sustantivo del juego solo si 2+ usuarios lo usan', () => {
    const gameWords = gameVocabulary('Shadow of the Colossus', 'coloso gigantes');
    const con = chatTopic(
      [
        line('a', 'el coloso de arriba es enorme'),
        line('b', 'ese coloso me da miedo'),
        line('c', 'el caballo corre mucho'),
      ],
      { gameWords },
    );
    assert.equal(con.categoria, 'juego');
    assert.equal(con.palabra, 'coloso');
    const sin = chatTopic(
      [line('a', 'el coloso de arriba es enorme'), line('b', 'el boss se mueve mucho'), line('c', 'el mapa es grande')],
      { gameWords },
    );
    assert.equal(sin.palabra, null);
    assert.equal(sin.texto, 'El chat comenta el juego');
  });
});

describe('buildMomentFacts', () => {
  test('estado, tiempo y suceso, sin inventar nada', () => {
    const facts = buildMomentFacts({
      game: 'Shadow of the Colossus',
      minutes: 170,
      player: 'Manu',
      deathCount: 3,
      events: [{ type: 'death', ts: NOW - 60_000, description: 'x' }],
      now: NOW,
    });
    const texts = facts.map((f) => f.texto);
    assert.ok(texts.includes('Juegan a Shadow of the Colossus y juega Manu'));
    assert.ok(texts.some((t) => /^Llevan .* de directo$/.test(t)));
    assert.ok(texts.includes('Manu acaba de caer; van tres caídas hoy'));
    assert.deepEqual(
      facts.map((f) => f.id),
      facts.map((_, i) => `h${i + 1}`),
    );
    assert.ok(facts.length >= 2 && facts.length <= 5);
  });

  test('sin datos no hay hechos', () => {
    assert.deepEqual(buildMomentFacts({}), []);
  });

  test('tipos usados recientemente pasan al final y se recortan', () => {
    const base = {
      game: 'Hades',
      minutes: 90,
      player: 'Manu',
      deathCount: 2,
      bosses: 1,
      events: [{ type: 'boss', ts: NOW - 1000, description: 'x' }],
      chatLines: [line('a', 'tienes que esquivar'), line('b', 'dale ya'), line('c', 'sube')],
      now: NOW,
    };
    const normal = buildMomentFacts(base);
    assert.equal(normal[0].tipo, 'suceso');
    const evitando = buildMomentFacts({ ...base, avoid: ['suceso'] });
    assert.notEqual(evitando[0].tipo, 'suceso');
    assert.ok(evitando.length <= 5);
  });

  test('el chat real del 11-11 no mete nicks ni jerga en los hechos', () => {
    const chat = [
      line('lola_77', 'jajaja chupar el coloso dice, cómo está el chat'),
      line('manolo', 'tienes que chupar la espalda al gitano ese'),
      line('pepa', 'la gordi dice que vayas al gimnasio'),
      line('lola_77', 'dale arriba que se mueve'),
      line('manolo', 'sube por la derecha'),
    ];
    const facts = buildMomentFacts({
      game: 'Shadow of the Colossus',
      minutes: 100,
      player: 'Manu',
      chatLines: chat,
      now: NOW,
    });
    const all = facts.map((f) => f.texto).join(' | ');
    assert.ok(!/lola|manolo|pepa|chupar|gitan|gordi|gimnasio/i.test(all), all);
    assert.ok(facts.some((f) => f.tipo === 'chat'));
  });

  test('claves: palabras que el hecho legitima', () => {
    const [f] = buildMomentFacts({ game: 'Hades', player: 'Manu' });
    assert.ok(f.claves.includes('hades'));
    assert.ok(f.claves.includes('juegan'));
  });
});

describe('renderFacts', () => {
  test('bloque <hechos> numerado; vacío si no hay', () => {
    assert.equal(renderFacts([]), '');
    const out = renderFacts([
      { id: 'h1', texto: 'Uno' },
      { id: 'h2', texto: 'Dos' },
    ]);
    assert.equal(out, '<hechos>\nh1. Uno\nh2. Dos\n</hechos>');
  });
});
