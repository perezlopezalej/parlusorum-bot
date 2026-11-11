// Hooks: preguntas al chat cuando hay silencio.
const channelConfig = require('../../config/channel.json');
const { getCurrentGame, getGameInfo } = require('../twitch/api');
const {
  getPlayer,
  isFreeCohostPaused,
  isTriviaActive,
  isSilenced,
  isReactive,
  isRaidActive,
  getRaidUsername,
  getStreamNarrative,
  getBotHistory,
  addBotMessage,
  getDeathCount,
  markStructure,
  getUsedStructures,
  claimHookPause,
} = require('../utils/state');
const { windowFacts } = require('../utils/narrative');
const factcheck = require('./factcheck');
const { translateGenres } = require('../utils/genres');
const quality = require('./quality');
const { canMakeRequest } = require('../utils/ratelimit');
const { buildHookSystem, retryNote } = require('./style');
const { countSessionsOfGame } = require('../utils/supabase');
const logger = require('../utils/logger');
const { truncate } = require('../utils/groq-utils');
const { aiChat } = require('../utils/ai-router');
const { getViewersWithAppToken } = require('../eventsub');
const { getEventSubLiveStatus } = require('./common');
const { getLastChatTime } = require('./chat-memory');

// --- Conversation hooks --- game hooks enriquecidos con la ficha del juego + comentarios IA espontáneos
let lastHookTime = 0;

const recentHooks = [];

const usedStaticHooks = new Set(); // hooks estáticos ya dichos en este stream

const HOOK_INTERVAL = parseInt(process.env.HOOK_INTERVAL_MS || '600000', 10);

const HOOK_MIN_SILENCE = parseInt(process.env.HOOK_SILENCE_MS || '300000', 10);

const MIN_VIEWERS_FOR_HOOKS = 3;

// Los hooks fijos sobre el juego ("¿Alguien lo conocía ya?") solo valen en los primeros streams de un juego nuevo
const NEW_GAME_HOOK_STREAMS = 2;

const HOOK_FACTS_WINDOW_MS = 45 * 60 * 1000;

const gameHookCache = new Map(); // juego → { ok, at }

async function gameHooksAllowed(game) {
  const cached = gameHookCache.get(game);
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.ok;
  const count = await countSessionsOfGame(game);
  const ok = count !== null && count <= NEW_GAME_HOOK_STREAMS; // sin base de datos, mejor ningún hook fijo del juego
  gameHookCache.set(game, { ok, at: Date.now() });
  return ok;
}

async function checkChatHook(client, channel) {
  if (isSilenced() || isReactive() || isTriviaActive()) return;
  if (!getEventSubLiveStatus()) return;
  const now = Date.now();
  if (isFreeCohostPaused(now)) return; // alguien pidió silencio: tampoco el hook anti-silencio (los timers fijos siguen)
  const silenceTime = now - getLastChatTime();

  if (now - lastHookTime < HOOK_INTERVAL) return;

  // Si hay raid activa y el chat lleva al menos 1 min sin actividad, dar bienvenida a raiders
  if (isRaidActive() && silenceTime >= 60000) {
    if (!claimHookPause(getLastChatTime(), now)) return;
    lastHookTime = now;
    client.say(
      channel,
      `👋 ¡Bienvenidos a los raiders de @${getRaidUsername()}! Si tenéis preguntas sobre el canal usad !dios_fua, y si os apetece un desafío probad !trivia 🔥`,
    );
    return;
  }

  if (silenceTime < HOOK_MIN_SILENCE) return;
  // Si el chat lleva más de 10 min muerto, no forzar — no hay nadie
  try {
    const viewers = await getViewersWithAppToken(channelConfig.broadcaster_id);
    if (viewers !== null && viewers < MIN_VIEWERS_FOR_HOOKS) return;
  } catch {}

  if (!claimHookPause(getLastChatTime(), now)) return; // en esta pausa ya habló un hook
  lastHookTime = now;
  const gameInfo = await getCurrentGame().catch(() => null);
  const game = gameInfo?.game;

  // IA: una pregunta al chat sobre lo que ha pasado en el stream (caídas, jefes, rachas). Sin sucesos, hooks fijos.
  const hookFacts = windowFacts(getStreamNarrative(), now, HOOK_FACTS_WINDOW_MS);
  if (game && hookFacts.relevant && canMakeRequest()) {
    try {
      const gi = await getGameInfo(game, { detail: true }).catch(() => null);
      const gameFacts = factcheck.gameFactsText(gi);
      const gameContext = gi
        ? `${game} (${translateGenres(gi.genres) || 'sin género'}, ${gi.released?.slice(0, 4) || '?'})`
        : game;
      const deathCount = getDeathCount();
      const eventText = `${hookFacts.lines.join('; ')}. Caídas anotadas hoy: ${deathCount}.`;
      const system = buildHookSystem({ game, player: getPlayer(), weekday: !getUsedStructures().has('dia-semana') });
      const lastCitedDeaths = quality.citesDeathCount((getBotHistory().slice(-1)[0] || {}).msg || '', deathCount);

      let text = '';
      let feedback = '';
      for (let attempt = 0; attempt < 2 && !text; attempt++) {
        if (attempt > 0 && !canMakeRequest()) break;
        const response = await aiChat('hook', {
          max_tokens: 80,
          messages: [
            { role: 'system', content: `${system}${retryNote(feedback)}` },
            { role: 'user', content: `<suceso>${eventText}</suceso>` },
          ],
        });
        const out = truncate((response.choices[0].message.content || '').trim());
        const check = quality.validateHook(out, {
          deathCount,
          recent: recentHooks,
          player: getPlayer(),
          lastCitedDeaths,
          requireQuestion: true,
          extraDeathNumbers: [hookFacts.deaths, hookFacts.streak],
        });
        if (!check.ok) {
          feedback = check.reason;
          logger.info(`Hook descartado (${check.reason}): ${out.slice(0, 80)}`);
          continue;
        }
        const review = await factcheck.evaluate(
          out,
          `Juego: ${gameContext}. Muertes anotadas: ${deathCount}. ${gameFacts}`,
          { game, sense: true },
        );
        if (review.discard) {
          logger.info(`Hook descartado (datos del juego sin respaldo): ${out.slice(0, 80)}`);
          break;
        }
        if (review.nonsense) {
          feedback = 'la frase no tiene sentido o está mal escrita';
          logger.info(`Hook descartado (sin sentido o mal escrito): ${out.slice(0, 80)}`);
          continue;
        }
        text = out;
      }
      if (!text) throw new Error('hook IA sin respuesta válida');
      recentHooks.push(text);
      if (recentHooks.length > 12) recentHooks.shift();
      for (const key of quality.streamMarks(text, game)) markStructure(key);
      addBotMessage(text);
      client.say(channel, text, { origin: 'hook' });
      return;
    } catch (err) {
      logger.warn(`Hook IA espontaneo fallo: ${err.message}`);
      // Si falla la IA, caemos al hook genérico
    }
  }

  // Hooks estáticos de fallback
  const genericHooks = [
    '¿Sois más de cooperativo o en solitario? 💬',
    '¡Chat! ¿Alguien se anima con un !trivia? 🧠',
    '¿Cuántas muertes creéis que habrá hoy? 💀',
    '¿Cuál es vuestro juego favorito de todos los tiempos? 🎮',
    '¡Usad !chiste para que cuente un chiste! 😂',
  ];

  let gameHooks = [];
  if (game && (await gameHooksAllowed(game))) {
    try {
      const gi = await getGameInfo(game, { detail: true }); // misma clave de caché que la ficha precalentada del juego actual
      const genres = translateGenres(gi?.genres);
      if (genres) {
        const year = gi.released?.slice(0, 4) || '';
        gameHooks = [
          `🎮 ${channelConfig.streamer} jugando a ${game} (${genres}${year ? ', ' + year : ''}). ¿Alguien lo ha jugado?`,
          `¿Qué os parece ${game} hasta ahora? Género: ${genres} 🎮`,
          `${game} - ${genres}${year ? ', ' + year : ''}. ¿Alguien lo conocía ya? 🤔`,
        ];
      } else {
        gameHooks = [`¿Qué os parece ${game} hasta ahora? 🎮`, `¿Alguien ha jugado ${game} antes? ¿Es difícil? 🤔`];
      }
    } catch {
      gameHooks = [`¿Qué os parece ${game} hasta ahora? 🎮`, `¿Alguien ha jugado ${game}? ¿Qué tal? 🤔`];
    }
  }

  // Sin repetir en este stream: se descartan los ya usados; si se agotan, se vuelve a empezar
  let allHooks = [...gameHooks, ...genericHooks].filter((h) => !usedStaticHooks.has(h));
  if (!allHooks.length) {
    usedStaticHooks.clear();
    allHooks = [...gameHooks, ...genericHooks];
  }
  const hook = allHooks[Math.floor(Math.random() * allHooks.length)];
  usedStaticHooks.add(hook);
  client.say(channel, hook, { origin: 'hook' });
}

module.exports = { recentHooks, usedStaticHooks, checkChatHook };
