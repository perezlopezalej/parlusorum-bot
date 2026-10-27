process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildSubContext } = require('../src/alerts/sub-context');
const { buildChannelQuestion, channelQuestionCandidates } = require('../src/games/channel-questions');

const first = () => 0;

describe('buildSubContext', () => {
  test('sin datos devuelve cadena vacía', () => {
    assert.equal(buildSubContext('ana', []), '');
    assert.equal(buildSubContext('ana', undefined), '');
  });

  test('con apodo oficial lo usa y menciona al usuario', () => {
    const out = buildSubContext('ana', [], { nickname: 'La Reina', rng: first });
    assert.match(out, /@ana/);
    assert.match(out, /La Reina/);
  });

  test('solo usa datos de la lista blanca', () => {
    const out = buildSubContext('ana', [{ fact_type: 'last_game_mentioned', value: 'Zelda' }]);
    assert.equal(out, '');
  });

  test('trivia_wins solo cuenta desde 2 victorias', () => {
    assert.equal(buildSubContext('ana', [{ fact_type: 'trivia_wins', value: '1' }]), '');
    assert.match(buildSubContext('ana', [{ fact_type: 'trivia_wins', value: '3' }]), /3 trivias/);
  });

  test('descarta un chiste que toca un tema evitado', () => {
    const facts = [{ fact_type: 'recurring_joke', value: 'algo vetado' }];
    assert.equal(buildSubContext('ana', facts, { isAvoided: () => true }), '');
  });

  test('elige un único dato entre varios', () => {
    const facts = [{ fact_type: 'is_regular', value: 'true' }, { fact_type: 'trivia_wins', value: '5' }];
    const out = buildSubContext('ana', facts, { rng: first });
    assert.match(out, /5 trivias/);
    assert.doesNotMatch(out, /habitual/);
  });
});

describe('buildChannelQuestion', () => {
  const sessions = [
    { game: 'Black Myth: Wukong', death_count: 12 },
    { game: 'It Takes Two', death_count: 4 },
    { game: 'Ghost of Yōtei', death_count: 7 },
  ];

  test('sin datos suficientes no hay pregunta', () => {
    assert.equal(buildChannelQuestion({ sessions: sessions.slice(0, 2) }), null);
    assert.equal(buildChannelQuestion({}), null);
  });

  test('récord de muertes y juego del récord', () => {
    const c = channelQuestionCandidates({ sessions });
    const record = c.find(x => /récord de muertes en un solo stream del canal/.test(x.question));
    assert.equal(record.answer, '12');
    const game = c.find(x => /En qué juego/.test(x.question));
    assert.equal(game.answer, 'black myth: wukong');
    assert.deepEqual(game.aliases, ['Black Myth']);
  });

  test('empate en el récord no genera la pregunta del juego', () => {
    const tied = [...sessions, { game: 'Otro', death_count: 12 }];
    assert.ok(!channelQuestionCandidates({ sessions: tied }).some(x => /En qué juego/.test(x.question)));
  });

  test('campeón solo con 2+ victorias', () => {
    assert.ok(!channelQuestionCandidates({ champion: { username: 'ana', count: 1 } }).length);
    assert.equal(channelQuestionCandidates({ champion: { username: 'ana', count: 4 } })[0].answer, 'ana');
  });

  test('lore: solo meme/frase/chiste de 3+ palabras; oculta la última', () => {
    const lore = [
      { kind: 'apodo', term: 'el gran maestro fua' },
      { kind: 'enemigo', term: 'jefe final malo' },
      { kind: 'frase', term: 'dos palabras' },
      { kind: 'frase', term: 'ya no puedo más' },
    ];
    const c = channelQuestionCandidates({ lore });
    assert.equal(c.length, 1);
    assert.equal(c[0].answer, 'más');
    assert.ok(!c[0].question.includes('más'));
  });

  test('no repite preguntas ya hechas', () => {
    const data = { champion: { username: 'ana', count: 4 } };
    const q = buildChannelQuestion(data);
    assert.ok(q);
    assert.equal(buildChannelQuestion(data, { isRecent: x => x === q.question }), null);
  });
});
