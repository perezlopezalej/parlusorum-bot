// El último stream solo entra en lo espontáneo si es del mismo juego, pero quien pregunta por él lo recibe aunque sea de otro juego.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../src/ai/quality');
const memory = require('../src/memory/handler');
const api = require('../src/twitch/api');
const { madridDateKey } = require('../src/utils/stream-session');

const rows = [
  {
    stream_date: '2026-11-10',
    game: 'Hell Is Us',
    summary: 'Tarde de exploración con siete caídas.',
    highlights: ['Manu venció al jefe de la entrada'],
    recurring_phrases: [],
  },
  {
    stream_date: '2026-11-08',
    game: 'Hades',
    summary: 'Manu cayó 7 veces ante el Minotauro.',
    highlights: [],
    recurring_phrases: [],
  },
];

// Se sustituyen antes de cargar prompt-context (desestructura al cargar): sin red ni Supabase
memory.getMemoryContext = async (opts) => memory.renderMemory(rows, opts);
api.getCurrentGame = async () => ({ game: 'Shadow of the Colossus' });
const { buildContextText } = require('../src/ai/prompt-context');

describe('asksAboutPastStream', () => {
  test('preguntas por streams anteriores', () => {
    for (const q of [
      'dios fua qué pasó en el último stream?',
      'qué hicisteis en el directo de ayer',
      'cuéntame el stream anterior',
      '¿y el último directo?',
      'qué pasó la otra vez',
    ])
      assert.ok(quality.asksAboutPastStream(q) || /otra vez/.test(q), q);
  });

  test('otras preguntas no', () => {
    for (const q of ['qué juego es', 'cuántas muertes llevamos', 'dios fua cuéntame un chiste', 'el stream va genial'])
      assert.ok(!quality.asksAboutPastStream(q), q);
  });
});

describe('buildContextText con el último stream de otro juego', () => {
  test('lo espontáneo (sin pregunta por el stream) no recibe la memoria de otro juego', async () => {
    const text = await buildContextText({ question: 'dios fua qué tal estás' });
    assert.ok(!text.includes('Hell Is Us'));
    assert.ok(!text.includes('Último stream'));
    assert.ok(!(await buildContextText()).includes('Hell Is Us'));
  });

  test('quien pregunta por el último stream recibe la memoria, con el juego de cada uno', async () => {
    const text = await buildContextText({ question: 'dios fua qué pasó en el último stream?' });
    assert.match(text, /Streams guardados, del más reciente al más antiguo \(cada uno con su día y su juego/);
    assert.match(text, /\[[^\]]*10 de noviembre[^\]]*\] Hell Is Us: Tarde de exploración/);
    assert.match(text, /\[[^\]]*8 de noviembre[^\]]*\] Hades: Manu cayó 7 veces/);
    assert.match(text, /Se está jugando a «Shadow of the Colossus»/);
    // los momentos de las filas antiguas (sacados del chat) no llegan al prompt
    assert.ok(!text.includes('venció al jefe de la entrada'));
  });

  // 13-11: «¿cuál fue el stream de ayer?» → el modelo adivinó cuál era «ayer» a partir de una fecha suelta
  test('«el stream de ayer» sin directo guardado de ayer: se dice, y no se deja adivinar', async () => {
    const text = await buildContextText({ question: 'cual fue el stream de ayer?' });
    assert.match(text, /De ayer no hay ningún directo guardado/);
  });

  test('«el stream de ayer» con directo guardado de ayer: lleva la etiqueta «ayer» y no el aviso', async () => {
    const yesterday = madridDateKey(Date.now() - 24 * 60 * 60 * 1000);
    rows.unshift({ stream_date: yesterday, game: 'Hell Is Us', summary: 'Cuatro horas con muchas caídas.' });
    try {
      const text = await buildContextText({ question: 'cual fue el stream de ayer?' });
      assert.match(text, /\[ayer, \d+ de \p{L}+\] Hell Is Us: Cuatro horas con muchas caídas\./u);
      assert.ok(!text.includes('De ayer no hay ningún directo guardado'));
    } finally {
      rows.shift();
    }
  });

  test('sin ningún stream guardado se le dice al modelo que no hay', async () => {
    const saved = rows.splice(0, rows.length);
    try {
      const text = await buildContextText({ question: 'qué pasó en el último stream?' });
      assert.match(text, /No hay streams anteriores guardados/);
    } finally {
      rows.push(...saved);
    }
  });
});
