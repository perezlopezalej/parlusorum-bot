// Frases reales del bot y del chat que antes vivían en `npm run eval` pero se resuelven solo con reglas (sin IA):
// ahora corren en cada `npm test` y en la CI. Los casos que necesitan la revisión de sentido por IA siguen en test/eval-cases.json.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';
process.env.EVENTSUB_SECRET = process.env.EVENTSUB_SECRET || 'secreto-de-pruebas-123';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const quality = require('../src/ai/quality');
const { classifyMessage } = require('../src/ai/patterns');
const { containsBlockedContent } = require('../src/utils/filter');
const { summaryProblem } = require('../src/memory/handler');
const cases = require('./fixtures/frases-reales.json');

function verdict(c) {
  const deaths = c.deaths ?? 5;
  const ctx = {
    deathCount: deaths,
    recent: c.recent || [],
    named: new Map(),
    now: c.at ? new Date(c.at).getTime() : Date.now(),
    currentGame: c.game || 'Phantom Blade Zero',
    channelGames: [],
    usedStructures: new Set(c.usedStructures || []),
    lastCitedDeaths: !!c.lastCitedDeaths,
    player: c.player || 'manu',
  };
  switch (c.filter) {
    case 'cohost':
      return quality.validateCohost(c.input, ctx).ok;
    case 'timer_ia':
      return quality.validateTimerIA(c.input, ctx).ok;
    case 'hook':
      return quality.validateHook(c.input, ctx).ok;
    case 'mention':
      return quality.validateMention(c.input, {
        question: c.question || '',
        player: ctx.player,
        names: c.names || [],
        recentToUser: c.recentToUser || [],
        usedStructures: ctx.usedStructures,
      }).ok;
    case 'inject':
      return !containsBlockedContent(c.input);
    case 'shutup':
      return classifyMessage(c.input, {}, { botNames: ['dios_fua'] }) !== 'shutup';
    case 'summary':
      return !summaryProblem(c.input);
    default:
      throw new Error(`filtro desconocido: ${c.filter}`);
  }
}

describe('frases reales: las reglas las rechazan o las dejan pasar', () => {
  for (const c of cases) {
    test(`${c.id}: ${c.expect.rejected ? 'se rechaza' : 'pasa'}`, () => {
      assert.equal(verdict(c), !c.expect.rejected, c.note);
    });
  }
});

describe('contador de muertes en las menciones', () => {
  test('la pregunta por las muertes se reconoce y el contador concuerda en singular y plural', () => {
    assert.ok(quality.isDeathQuestion('dios fua cuántas muertes llevamos?'));
    assert.equal(quality.countDeaths(7), '7 muertes');
    assert.equal(quality.countDeaths(1), '1 muerte');
  });
});
