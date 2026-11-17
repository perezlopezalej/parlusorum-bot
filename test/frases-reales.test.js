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
const { gameVocabulary, buildRecapFacts } = require('../src/ai/moment-facts');
const { loadExamples } = require('../src/ai/style');
const cases = require('./fixtures/frases-reales.json');

// Datos del directo de un caso de resumen o de !quemeperdi (game, player, minutes, deaths, bosses, startedAt): los hechos con
// los que se habría escrito y el contexto de las reglas de quality/recap.js
function recapOf(c, ended) {
  const player = c.player || 'manu';
  const deathCount = c.deaths ?? 0;
  const startedAt = c.startedAt ? Date.parse(c.startedAt) : null;
  return {
    facts: buildRecapFacts({
      game: c.game,
      minutes: c.minutes,
      deathCount,
      bosses: c.bosses ?? 0,
      player: { pao: 'Pao', ambos: 'Manu y Pao' }[player] || 'Manu',
      ended,
    }),
    game: c.game || '',
    player,
    minutes: c.minutes,
    deathCount,
    gameWords: gameVocabulary(c.game || ''),
    startedAt,
    endedAt: startedAt ? startedAt + (c.minutes || 0) * 60000 : null,
  };
}

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
    // window: caídas y racha de la ventana que cuenta el timer/hook (windowFacts): su cifra también vale, además del total
    extraDeathNumbers: c.window ? [c.window.deaths, c.window.streak ?? 0] : [],
    player: c.player || 'manu',
    // chat: líneas del chat de ese momento (regla `copia`); el vocabulario del juego sale de su nombre
    chatLines: c.chat || [],
    // allowed: textos legítimos (hechos del momento): activa la regla `inventado`
    allowedWords: c.allowed || [],
    gameWords: gameVocabulary(c.game || ''),
    minutes: c.directoMinutes ?? null, // minutos reales de directo: regla `tiempo_redondeado`
  };
  switch (c.filter) {
    case 'cohost':
      // timeOffered: si el rato de directo estaba entre los hechos ofrecidos (regla `tiempo`); examples: true compara con
      // los ejemplos del prompt (regla `ejemplo`)
      return quality.validateCohost(c.input, {
        ...ctx,
        game: ctx.currentGame,
        timeOffered: c.timeOffered ?? null,
        facts: c.facts || [],
        hecho: c.hecho || '',
        examples: c.examples ? loadExamples().cohost.map((e) => e.texto) : [],
      }).ok;
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
        botQuestion: c.botQuestion || '',
        usedStructures: ctx.usedStructures,
        deathCount: c.deaths ?? null,
      }).ok;
    case 'inject':
      return !containsBlockedContent(c.input);
    case 'shutup':
      return classifyMessage(c.input, {}, { botNames: ['dios_fua'] }) !== 'shutup';
    case 'summary':
      // con `minutes` el caso trae los datos del directo: se comprueba también que el resumen cuente solo esos hechos
      return !summaryProblem(c.input, c.minutes != null ? recapOf(c, true) : null);
    case 'quemeperdi':
      return !quality.validateQueMePerdi(c.input, { bosses: c.bosses ?? 0, ...recapOf(c, false) });
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
