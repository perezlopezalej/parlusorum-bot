// Menciones al bot, provocaciones y orden de callarse.
const channelConfig = require('../../config/channel.json');
const messagesConfig = require('../../config/messages.json');
const { getCurrentGame } = require('../twitch/api');
const {
  getChatterNames,
  getPlayer,
  pauseFreeCohost,
  isTriviaActive,
  isSilenced,
  isReactive,
  getBotHistory,
  addBotMessage,
  getDeathCount,
  markNamed,
  noteMentionFua,
  getMentionFuaHistory,
} = require('../utils/state');
const factcheck = require('./factcheck');
const { buildGameTemplate } = require('./game-template');
const { classifyMessage, cooldownMs, cooldownGate, provocationGate, mentionBudget, isStale } = require('./patterns');
const quality = require('./quality');
const { sanitizeForAI } = require('../utils/filter');
const { canMakeRequest } = require('../utils/ratelimit');
const { buildProvocationSystem, buildMentionSystem, retryNote } = require('./style');
const logger = require('../utils/logger');
const { truncate } = require('../utils/groq-utils');
const { aiChat } = require('../utils/ai-router');
const { GENERAL_TEMPERATURE, getUserType, pickIdentityReply, pickRandom } = require('./common');
const { addToUserConversation, getUserConversation } = require('./chat-memory');
const {
  buildContextText,
  buildRoleText,
  buildToneText,
  emoteLineFor,
  getModeConfig,
  refreshMode,
} = require('./prompt-context');
const { buscarJuegoLookup } = require('./dios-fua');

// Provocaciones: solo la primera de cada usuario en esta ventana recibe réplica
const PROVOCATION_WINDOW = parseInt(process.env.PROVOCATION_WINDOW_MS || '600000', 10);

// Menciones: máximo MENTION_MAX_PER_USER respuestas por usuario cada MENTION_WINDOW_MS; una respuesta que lleva
// más de MENTION_MAX_AGE_MS esperando (IA + cola IRC) se descarta en vez de salir tarde
const MENTION_MAX_PER_USER = parseInt(process.env.MENTION_MAX_PER_USER || '3', 10);

const MENTION_WINDOW = parseInt(process.env.MENTION_WINDOW_MS || '300000', 10);

const MENTION_MAX_AGE_MS = 20000;

const PROVOCATION_MAX_RETRY_DELAY_MS = 3000; // una réplica tardía se descarta (MENTION_MAX_AGE_MS): mejor la de reserva al momento

const MENTION_MAX_RETRY_DELAY_MS = 5000;

const MENTION_MAX_CHARS = 200; // tope de las respuestas a menciones (con el @usuario), recortadas en final de frase

// --- Pattern matcher: preguntas naturales sin ! ---

// Detección en patterns.js. Menciones directas: cooldown propio (8s global + 10s por usuario), sin escalar por modo
// Separadas para permitir conversación fluida sin bloquear el global de patrones generales
let lastDirectMentionTime = 0;

const directMentionUserCooldowns = new Map();
setInterval(
  () => {
    const now = Date.now();
    for (const [k, v] of directMentionUserCooldowns) if (now > v) directMentionUserCooldowns.delete(k);
  },
  15 * 60 * 1000,
);

const mentionStamps = new Map(); // userId -> instantes de sus últimas respuestas a menciones
setInterval(
  () => {
    const now = Date.now();
    for (const [k, v] of mentionStamps) if (!v.some((t) => now - t < MENTION_WINDOW)) mentionStamps.delete(k);
  },
  15 * 60 * 1000,
);

// Provocaciones: userId -> fin de su ventana (solo la primera de cada ventana recibe réplica)
const provocationUntil = new Map();
setInterval(
  () => {
    const now = Date.now();
    for (const [k, v] of provocationUntil) if (now > v) provocationUntil.delete(k);
  },
  15 * 60 * 1000,
);

// Preguntas naturales: 45s global + 30s por usuario, escalados por pattern_cooldown_multiplier del modo
let lastPatternTime = 0;

const patternUserCooldowns = new Map();
setInterval(
  () => {
    const now = Date.now();
    for (const [k, v] of patternUserCooldowns) if (now > v) patternUserCooldowns.delete(k);
  },
  15 * 60 * 1000,
);

// Petición de silencio al bot ("Dios Fua, cállate un rato"): respuesta breve y amable, sin IA, y el cohost libre se pausa 10 min.
// Los eventos (jefe, raid...) y las respuestas directas siguen funcionando. Un aviso por usuario cada 2 min como mucho.
const FREE_COHOST_PAUSE_MS = parseInt(process.env.COHOST_SHUTUP_PAUSE_MS || String(10 * 60 * 1000), 10);

const shutUpCooldowns = new Map();
setInterval(
  () => {
    const now = Date.now();
    for (const [k, v] of shutUpCooldowns) if (now > v) shutUpCooldowns.delete(k);
  },
  15 * 60 * 1000,
);

function handleShutUp(client, channel, tags) {
  const now = Date.now();
  const userId = tags['user-id'] || tags['username'];
  pauseFreeCohost(FREE_COHOST_PAUSE_MS, now);
  if (now < (shutUpCooldowns.get(userId) || 0)) return 'blocked';
  shutUpCooldowns.set(userId, now + 2 * 60 * 1000);
  const reply = pickRandom(messagesConfig.shutup_replies);
  const out = truncate(`@${tags['display-name']} ${reply}`);
  client.say(channel, out, undefined, { expiresAt: now + MENTION_MAX_AGE_MS });
  addBotMessage(reply);
  logger.info(
    `Silencio pedido por ${tags['display-name']}: cohost libre en pausa ${Math.round(FREE_COHOST_PAUSE_MS / 60000)} min`,
  );
  return true;
}

// false = no era para el bot (el cohost puede hablar); 'blocked' = sí lo era pero no se responde (cooldown, límite); true = respondido
async function checkPatternMatch(client, channel, tags, message) {
  if (isSilenced() || isTriviaActive()) return false;

  const kind = classifyMessage(message, tags, { botNames: [process.env.BOT_USERNAME] });
  if (!kind) return false;
  if (kind === 'shutup') return handleShutUp(client, channel, tags);
  // Modo reactivo: solo menciones directas; ni preguntas naturales ni provocaciones
  if (isReactive() && kind !== 'direct') return false;

  const now = Date.now();
  const startedAt = now;
  const userId = tags['user-id'] || tags['username'];
  const isProvocation = kind === 'provocation';
  const isDirect = kind === 'direct' || isProvocation;
  const cdKind = isDirect ? 'direct' : 'natural';
  const userCooldowns = isDirect ? directMentionUserCooldowns : patternUserCooldowns;

  // Provocación repetida dentro de su ventana: se ignora (y el cohost tampoco entra a la provocación)
  if (isProvocation && !provocationGate(now, provocationUntil.get(userId) || 0)) return 'blocked';

  refreshMode();
  const modeConfig = getModeConfig();
  const multiplier = modeConfig.pattern_cooldown_multiplier ?? 1;
  const prevGlobal = isDirect ? lastDirectMentionTime : lastPatternTime;
  const prevUser = userCooldowns.get(userId);
  if (!cooldownGate(cdKind, { now, lastGlobalAt: prevGlobal, userUntil: prevUser || 0, multiplier })) return 'blocked';

  const username = tags['display-name'];
  const question = sanitizeForAI(message);
  if (!question) return 'blocked';
  if (!canMakeRequest()) return 'blocked';

  // Tope por usuario: pasado el límite se ignora en silencio (y el cohost tampoco entra)
  const prevStamps = mentionStamps.get(userId);
  if (isDirect) {
    const budget = mentionBudget(prevStamps, now, MENTION_MAX_PER_USER, MENTION_WINDOW);
    if (!budget.ok) {
      mentionStamps.set(userId, budget.stamps);
      return 'blocked';
    }
    mentionStamps.set(userId, budget.stamps);
  }

  // Se reservan antes de esperar a la IA (evita dobles respuestas) y se devuelven si la IA falla
  const release = () => {
    if (isDirect) lastDirectMentionTime = prevGlobal;
    else lastPatternTime = prevGlobal;
    if (prevUser) userCooldowns.set(userId, prevUser);
    else userCooldowns.delete(userId);
    if (isProvocation) provocationUntil.delete(userId);
    if (isDirect) {
      if (prevStamps) mentionStamps.set(userId, prevStamps);
      else mentionStamps.delete(userId);
    }
  };
  const cd = cooldownMs(cdKind, multiplier);
  if (isDirect) lastDirectMentionTime = now;
  else lastPatternTime = now;
  userCooldowns.set(userId, now + cd.userMs);
  if (isProvocation) provocationUntil.set(userId, now + PROVOCATION_WINDOW);

  try {
    const emotes = channelConfig.channel_emotes || [];
    const allowEmote =
      quality.emoteAllowed(
        getBotHistory().map((e) => e.msg),
        emotes,
      ) && !isProvocation;
    const maxChars = isProvocation
      ? Math.min(160, modeConfig.max_chars ?? 160)
      : Math.min(MENTION_MAX_CHARS, modeConfig.max_chars ?? MENTION_MAX_CHARS);
    let answer = '';

    // "Cuéntame de qué va Silent Hill F": se busca el juego en IGDB y se responde con esos datos (sin IA que pueda inventar).
    // Si IGDB no contesta, a !dios_fua; si pide datos de un juego que no encuentra, se dice con humor que no se pilla.
    const identity = isProvocation ? null : quality.identityQuestion(question);
    if (identity) answer = pickIdentityReply(identity);
    if (!answer && !isProvocation && !quality.isCurrentGameQuestion(question) && !quality.isDeathQuestion(question)) {
      const gameQuery = quality.extractGameQuery(question);
      if (gameQuery) {
        const lookup = await buscarJuegoLookup(gameQuery.name, question);
        if (lookup.info) answer = buildGameTemplate(lookup.info, messagesConfig.mention_game_quips);
        else if (lookup.unavailable) answer = pickRandom(messagesConfig.mention_game_redirect);
        else if (gameQuery.strict) answer = pickRandom(messagesConfig.mention_not_understood);
      }
    }

    if (answer) {
      // consulta de juego ya resuelta
    } else if (isProvocation) {
      answer = await generateProvocationReply(username, question, maxChars);
    } else if (quality.isCurrentGameQuestion(question)) {
      // "¿Qué juego es?": el juego actual del stream, sin IA
      const current = await getCurrentGame().catch(() => null);
      answer = current?.game
        ? pickRandom(messagesConfig.mention_current_game.some).replace('{game}', current.game)
        : messagesConfig.mention_current_game.none;
    } else if (quality.isDeathQuestion(question)) {
      // Por las muertes: el contador real, sin IA
      const n = getDeathCount();
      answer =
        n === 0
          ? messagesConfig.mention_deaths.none
          : n === 1
            ? messagesConfig.mention_deaths.one
            : messagesConfig.mention_deaths.some.replace('{n}', n);
    } else if (quality.isGameQuestion(question)) {
      // Preguntas concretas del juego: a !dios_fua, que consulta IGDB
      answer = pickRandom(messagesConfig.mention_game_redirect);
    } else {
      const userType = getUserType(username, tags);
      const userConv = getUserConversation(userId);
      const system = buildMentionSystem({
        context: await buildContextText(),
        role: await buildRoleText(userType, username, tags['user-id']),
        tone: buildToneText(question),
        emoteLine: emoteLineFor(allowEmote, emotes),
        modeLine: modeConfig.prompt_extension,
      });

      let fixKey = ''; // regla fallida del intento anterior: el reintento recibe solo la corrección en positivo
      for (let attempt = 0; attempt < 2 && !answer; attempt++) {
        const response = await aiChat(
          'mention',
          {
            max_tokens: modeConfig.max_tokens ?? 120,
            temperature: GENERAL_TEMPERATURE,
            messages: [
              { role: 'system', content: `${system}${retryNote(fixKey)}` },
              ...userConv,
              { role: 'user', content: `${username}: ${question}` },
            ],
          },
          2,
          { maxDelayMs: MENTION_MAX_RETRY_DELAY_MS },
        );
        const choice = response.choices[0];
        const raw =
          choice.finish_reason === 'length'
            ? quality.dropTrailingFragment(choice.message.content)
            : (choice.message.content || '').trim();
        const check = quality.validateMention(raw, {
          question,
          player: getPlayer(),
          names: [username, ...getChatterNames()],
        });
        if (!check.ok) {
          fixKey = check.rule;
          continue;
        }
        const mentionGame = await getCurrentGame().catch(() => null);
        // Solo se vigila lo que habla de videojuegos; "resistencia" o "zona" en una pregunta de cultura general no cuentan
        const gameTalk = quality.talksAboutGames(`${question} ${raw}`, mentionGame?.game);
        if (gameTalk && quality.mentionsMechanics(raw)) {
          fixKey = 'juego';
          continue;
        }
        const invented = gameTalk ? quality.unsupportedAttributes(raw, `Juego: ${mentionGame?.game || ''}`) : '';
        if (invented) {
          fixKey = 'juego';
          continue;
        }
        // Una sola llamada: datos del juego (solo si habla de videojuegos) y sentido/redacción
        const review = await factcheck.evaluate(
          raw,
          `Juego: ${mentionGame?.game || 'desconocido'}. Muertes anotadas: ${getDeathCount()}.`,
          { game: mentionGame?.game, sense: true, checkData: gameTalk },
        );
        if (review.discard) {
          fixKey = 'juego';
          continue;
        }
        if (review.nonsense) {
          fixKey = 'sentido';
          continue;
        }
        answer = raw;
      }
      // Sin respuesta válida tras reintentar: callar. Las réplicas de reserva son solo para provocaciones reales
      if (!answer) {
        logger.info(`Mención sin respuesta válida, se calla: ${question.slice(0, 80)}`);
        release();
        return 'blocked';
      }
      addToUserConversation(userId, 'user', `${username}: ${question}`);
      addToUserConversation(userId, 'assistant', answer);
    }

    if (isStale(startedAt, Date.now(), MENTION_MAX_AGE_MS)) {
      logger.info(
        `Respuesta a ${username} descartada por tardía (${Math.round((Date.now() - startedAt) / 1000)} s): ${String(answer).slice(0, 60)}`,
      );
      release();
      return 'blocked';
    }
    if (!isProvocation) {
      // el «¡FUA!» de cierre no es una costumbre: solo en 1 de cada 3 menciones
      const closing = quality.limitTrailingFua(answer, getMentionFuaHistory());
      answer = closing.text;
      noteMentionFua(closing.had);
    }
    const out = quality.applyEmotePolicy(truncate(`@${username} ${answer}`, maxChars), allowEmote, emotes);
    client.say(channel, out, undefined, { expiresAt: startedAt + MENTION_MAX_AGE_MS });
    addBotMessage(out.replace(/^@\S+\s*/, ''));
    markNamed([username]);
    return true;
  } catch (err) {
    logger.warn(`Pattern matcher: ${err.message}`);
    release();
    return false;
  }
}

// Réplicas de reserva (config/messages.json), sin repetir la última
let lastProvocationReply = '';

function pickProvocationReply() {
  const pool = (messagesConfig.provocation_replies || []).filter((r) => r !== lastProvocationReply);
  const pick = pool[Math.floor(Math.random() * pool.length)] || '';
  lastProvocationReply = pick;
  return pick;
}

// Réplica corta con personalidad; si la IA falla, rechaza o suena latina, se usa la de reserva
async function generateProvocationReply(username, question, maxChars) {
  try {
    const response = await aiChat(
      'provocation',
      {
        max_tokens: 60,
        messages: [
          { role: 'system', content: buildProvocationSystem() },
          { role: 'user', content: `${username}: ${question}` },
        ],
      },
      1,
      { maxDelayMs: PROVOCATION_MAX_RETRY_DELAY_MS },
    );
    const choice = response.choices[0];
    const text =
      choice.finish_reason === 'length'
        ? quality.dropTrailingFragment(choice.message.content)
        : (choice.message.content || '').trim();
    // Revisión de sentido (sin datos de juego): si no se entiende, va la de reserva
    if (
      quality.validateMention(text, { names: [username, ...getChatterNames()] }).ok &&
      text.length <= maxChars &&
      !(await factcheck.evaluate(text, '', { sense: true, checkData: false })).nonsense
    )
      return text;
  } catch (err) {
    logger.warn(`Réplica a provocación: ${err.message}`);
  }
  return pickProvocationReply();
}

module.exports = { checkPatternMatch };
