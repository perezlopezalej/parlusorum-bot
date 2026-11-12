// El último stream solo entra en lo espontáneo si es del mismo juego, pero quien pregunta por él lo recibe aunque sea de otro juego.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../src/ai/quality');
const memory = require('../src/memory/handler');
const api = require('../src/twitch/api');

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
    assert.match(text, /Streams anteriores \(cada uno con su fecha y su juego/);
    assert.match(text, /\[2026-11-10\] Hell Is Us: Tarde de exploración/);
    assert.match(text, /\[2026-11-08\] Hades: Manu cayó 7 veces/);
    assert.match(text, /Se está jugando a «Shadow of the Colossus»/);
  });
});
