// !dios_fua (preguntas con herramienta de juegos) y chistes.
const channelConfig = require('../../config/channel.json');
const messagesConfig = require('../../config/messages.json');
const { lookupGameInfo } = require('../twitch/api');
const { isSilenced, addBotMessage } = require('../utils/state');
const factcheck = require('./factcheck');
const { buildGameTemplate } = require('./game-template');
const { buildGameSheet, leaksSheetRaw } = require('./game-sheet');
const quality = require('./quality');
const { sanitizeForAI } = require('../utils/filter');
const { classifyGameMatch, recoverTruncatedName } = require('../utils/game-match');
const { canMakeRequest, canUserMakeRequest } = require('../utils/ratelimit');
const { buildQuestionSystem } = require('./style');
const { persistCooldown } = require('../utils/supabase');
const logger = require('../utils/logger');
const chatlog = require('../utils/chatlog');
const { truncate, TWITCH_MAX_LENGTH } = require('../utils/groq-utils');
const { aiChat } = require('../utils/ai-router');
const {
  GENERAL_TEMPERATURE,
  getFallback,
  getUserType,
  pickIdentityReply,
  pickInjectionReply,
  pickRandom,
} = require('./common');
const { addToUserConversation, getUserConversation, questionCooldowns, trackMessage } = require('./chat-memory');
const { buildContextText, buildRoleText, buildToneText, getModeConfig, refreshMode } = require('./prompt-context');

const QUESTION_COOLDOWN_MS = parseInt(process.env.QUESTION_COOLDOWN_MS || '10000', 10);

// --- !chiste ---
const chistesDB = require('../../data/chistes.json');

const chisteCooldowns = new Map();

let lastChisteIndex = -1;
setInterval(
  () => {
    const now = Date.now();
    for (const [k, v] of chisteCooldowns) if (now > v) chisteCooldowns.delete(k);
  },
  30 * 60 * 1000,
);

function handleChiste(client, channel, tags) {
  if (isSilenced()) return;
  const username = tags['display-name'];
  // fallback si user-id es undefined (evita cooldown compartido)
  const userId = tags['user-id'] || tags['username'] || username;
  const key = `chiste-${userId}`;
  const now = Date.now();
  if (chisteCooldowns.has(key) && now < chisteCooldowns.get(key)) {
    client.say(channel, `@${username} espera ${Math.ceil((chisteCooldowns.get(key) - now) / 1000)}s.`);
    return;
  }
  let index,
    attempts = 0;
  do {
    index = Math.floor(Math.random() * chistesDB.length);
    attempts++;
  } while (index === lastChisteIndex && attempts < 10);
  lastChisteIndex = index;
  chisteCooldowns.set(key, now + 30000);
  persistCooldown(key, now + 30000);
  client.say(channel, truncate(`😂 ${chistesDB[index]}`));
}

// --- Herramienta buscar_juego (solo !dios_fua) ---
const BUSCAR_JUEGO_TOOL = {
  type: 'function',
  function: {
    name: 'buscar_juego',
    description:
      'SOLO para videojuegos (nunca para cultura general): busca datos reales de un videojuego: fecha de salida, desarrolladora, editora, país de la desarrolladora (si consta), géneros y descripción corta',
    parameters: {
      type: 'object',
      properties: { nombre: { type: 'string', description: 'Nombre del videojuego' } },
      required: ['nombre'],
    },
  },
};

// { text, info }: text es lo que ve la IA; info solo viene con coincidencia exacta (para la plantilla de reserva)
async function buscarJuegoLookup(nombre, question = '') {
  const recovered = recoverTruncatedName(nombre, question);
  if (recovered.truncated || recovered.recovered)
    logger.info(
      `!dios_fua buscar_juego: nombre truncado "${nombre}" → "${recovered.name}"${recovered.truncated ? ' (sin recuperar)' : ''}`,
    );
  const clean = sanitizeForAI(recovered.name || '');
  if (!clean) return { text: 'SIN DATOS: no se indicó ningún juego.', info: null };
  const { info, error } = await lookupGameInfo(clean.slice(0, 80), { detail: true }).catch(() => ({
    info: null,
    error: true,
  }));
  if (error) {
    logger.warn(`!dios_fua buscar_juego: fuentes no disponibles para "${clean.slice(0, 80)}"`);
    return { info: null, unavailable: true, text: 'SIN DATOS: no se puede consultar ahora.' };
  }
  let match = info ? classifyGameMatch(clean, info.name) : 'none';
  if (match === 'match' && recovered.truncated) match = 'maybe'; // nombre cortado y sin recuperar: nunca coincidencia segura
  logger.info(`!dios_fua buscar_juego: "${clean.slice(0, 80)}" → ${info ? `${info.name} (${match})` : 'sin datos'}`);
  if (match === 'none')
    return {
      info: null,
      text: `SIN DATOS: no hay información de "${clean}". Si es un videojuego no inventes nada y dilo con humor sin hablar de datos ni de fuentes; si no es un videojuego, responde con lo que sepas.`,
    };
  if (match === 'maybe')
    return {
      info: null,
      text: `SIN DATOS, quizá se refiera a ${info.name}. Sin hablar de datos ni de fuentes: no presentes ese juego como el pedido ni uses sus datos; pregunta si se refiere a ese.`,
    };
  // Ficha en español y en limpio (fecha legible, géneros traducidos, resumen en español de la caché): el modelo nunca ve el inglés de IGDB
  const text = await buildGameSheet(info);
  return { text, info };
}

async function handleQuestion(client, channel, tags, args) {
  if (isSilenced()) return;
  const username = tags['display-name'];
  // fallback si user-id es undefined
  const userId = tags['user-id'] || tags['username'] || username;
  const now = Date.now();

  if (questionCooldowns.has(userId) && now < questionCooldowns.get(userId)) {
    client.say(channel, `@${username} espera ${Math.ceil((questionCooldowns.get(userId) - now) / 1000)}s.`);
    return;
  }

  const rawQuestion = args.slice(1).join(' ');
  if (!rawQuestion) {
    client.say(channel, `@${username} escribe algo después de !dios_fua 😅`);
    return;
  }
  // Intento de dar órdenes al bot: no llega a la IA; plantilla fija con humor
  if (quality.injectionAttempt(rawQuestion)) {
    const reply = pickInjectionReply();
    client.say(channel, truncate(`@${username} ${reply}`));
    addBotMessage(reply);
    questionCooldowns.set(userId, now + QUESTION_COOLDOWN_MS);
    return;
  }
  const question = sanitizeForAI(rawQuestion);
  if (!question) {
    client.say(channel, `@${username} esa pregunta no la puedo responder 🙅`);
    return;
  }
  // Identidad (quién eres, quién te creó, quién lleva el canal): plantilla fija, sin IA ni cupo
  const identity = quality.identityQuestion(question);
  if (identity) {
    const reply = pickIdentityReply(identity);
    client.say(channel, truncate(`@${username} ${reply}`));
    addBotMessage(reply);
    questionCooldowns.set(userId, now + QUESTION_COOLDOWN_MS);
    return;
  }
  if (!canMakeRequest()) {
    client.say(channel, `@${username} demasiadas peticiones globales ⏳`);
    return;
  }

  const userType = getUserType(username, tags);
  if (!canUserMakeRequest(userId, userType)) {
    client.say(channel, `@${username} espera un momento antes de volver a preguntar ⏳`);
    return;
  }

  try {
    trackMessage();
    refreshMode();
    const userConv = getUserConversation(userId);
    const questionMode = getModeConfig();
    const systemContent = buildQuestionSystem({
      context: await buildContextText(),
      role: await buildRoleText(userType, username, tags['user-id']),
      tone: buildToneText(question),
      modeLine: questionMode.prompt_extension,
    });
    const messages = [
      { role: 'system', content: systemContent },
      ...userConv,
      { role: 'user', content: `${username}: ${question}` },
    ];
    const qModeConfig = getModeConfig();
    const qMaxTokens = qModeConfig.max_tokens ?? 150;
    // Si la pregunta nombra un juego, su ficha de IGDB se busca ANTES de llamar al modelo y se le pasa siempre (como en las menciones):
    // no se depende de que el modelo llame a buscar_juego. Sin ficha (no hay nombre o IGDB no lo conoce) sigue el flujo con la herramienta.
    const gameName = quality.extractGameMention(question);
    const pre = gameName ? await buscarJuegoLookup(gameName, question) : null;
    const prefetched = !!pre?.info;
    if (prefetched) {
      chatlog.noteTool('buscar_juego');
      const last = messages[messages.length - 1];
      last.content = `<ficha_igdb>\n${pre.text}\n</ficha_igdb>\n${last.content}`;
    }
    let response = await aiChat('diosfua', {
      max_tokens: qMaxTokens,
      ...(quality.isGameQuestion(question) || quality.talksAboutGames(question)
        ? {}
        : { temperature: GENERAL_TEMPERATURE }),
      ...(prefetched ? {} : { tools: [BUSCAR_JUEGO_TOOL], tool_choice: 'auto' }),
      messages,
    });
    // Una sola ronda de herramienta: ejecutar buscar_juego y pedir la respuesta final sin tools
    const toolCalls = response.choices[0]?.message?.tool_calls;
    let gameText = prefetched ? `${pre.text}\n` : '';
    let gameData = prefetched ? pre.info : null;
    let gameDown = false;
    if (toolCalls?.length) {
      messages.push(response.choices[0].message);
      for (const call of toolCalls.slice(0, 2)) {
        let result = 'Herramienta desconocida.';
        if (call.function?.name === 'buscar_juego') {
          let nombre = '';
          try {
            nombre = String(JSON.parse(call.function.arguments || '{}').nombre || '');
          } catch {
            /* args inválidos */
          }
          chatlog.noteTool('buscar_juego');
          const lookup = await buscarJuegoLookup(nombre, question);
          result = lookup.text;
          gameData = gameData || lookup.info;
          if (lookup.unavailable) gameDown = true;
          gameText += `${result}\n`;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      // datos de juegos caídos (no es "juego no encontrado"): se dice con humor, sin pedirle nada más a la IA
      if (gameDown && !gameData) {
        client.say(channel, truncate(`@${username} ${pickRandom(messagesConfig.dios_fua_game_down)}`));
        questionCooldowns.set(userId, now + QUESTION_COOLDOWN_MS);
        return;
      }
      response = await aiChat('diosfua', {
        max_tokens: qMaxTokens,
        messages,
      });
    }
    let answer = quality.fixFuaGender(response.choices[0].message.content);
    // El canal es de Manu y Pao: si la respuesta se lo atribuye a vlxj97, un reintento con la corrección; si repite, se descarta
    if (quality.claimsChannelOwner(answer)) {
      messages.push({
        role: 'user',
        content: 'Recuerda: el canal lo llevan Manu y Pao, y vlxj97 creó el bot. Responde otra vez.',
      });
      const fix = await aiChat('diosfua', { max_tokens: qMaxTokens, messages });
      answer = fix.choices[0].message.content;
    }
    const ownerClaim = quality.claimsChannelOwner(answer);
    const qMaxChars = qModeConfig.max_chars ?? TWITCH_MAX_LENGTH;
    // Datos del juego: solo los que devolvió buscar_juego (IGDB); si afirma algo más, no se envía.
    // Solo si hablan de videojuegos: la cultura general se responde con el conocimiento del modelo.
    const gameTopic =
      quality.isGameQuestion(question) ||
      quality.talksAboutGames(`${question} ${answer}`) ||
      ((prefetched || !!toolCalls?.length) && gameText.length > 0 && !gameText.startsWith('SIN DATOS'));
    const techLeak = quality.leaksTech(answer) || ownerClaim;
    let discard = techLeak;
    if (!techLeak && gameTopic) ({ discard } = await factcheck.evaluate(answer, gameText, { source: 'juego' }));
    // País, nacionalidad, personas y cifras solo valen si están en los datos de IGDB (el verificador de IA a veces los deja pasar)
    // Sin datos de buscar_juego (no encontrado), ni estudio ni editora ni nacionalidad: todo sería inventado
    const noGameData = !!toolCalls?.length && !/^Nombre: /m.test(gameText);
    const inventedAttr =
      !techLeak && (gameTopic || noGameData)
        ? noGameData
          ? quality.inventedCompany(answer, gameText)
          : quality.unsupportedAttributes(answer, gameText)
        : '';
    if (inventedAttr && !discard) {
      discard = true;
    }
    // Ficha volcada en bruto (inglés, fechas ISO, campos copiados): no se envía; con datos de IGDB, un reintento y si no la plantilla
    const rawLeak = !techLeak
      ? leaksSheetRaw(answer, { names: [gameData?.name, gameName, ...(channelConfig.games_played || [])] })
      : '';
    if (rawLeak && !discard) {
      discard = true;
      logger.info(`!dios_fua: respuesta con la ficha en bruto (${rawLeak})`);
    }
    // Con datos reales de IGDB, un único reintento diciéndole qué frase no estaba respaldada
    if (discard && !techLeak && /^Nombre: /m.test(gameText)) {
      messages.push({
        role: 'user',
        content:
          'Responde otra vez en español y con tus palabras, en una o dos frases, contestando directamente a lo que pregunta con la ficha; para lo que la ficha no diga, di con humor que no tienes ni idea.',
      });
      const retry = await aiChat('diosfua', { max_tokens: qMaxTokens, messages });
      const retryAnswer = retry.choices[0].message.content;
      if (
        retryAnswer &&
        !quality.leaksTech(retryAnswer) &&
        !leaksSheetRaw(retryAnswer, { names: [gameData?.name, gameName, ...(channelConfig.games_played || [])] }) &&
        !quality.unsupportedAttributes(retryAnswer, gameText) &&
        !(await factcheck.shouldDiscard(retryAnswer, gameText, { source: 'juego' }))
      ) {
        answer = retryAnswer;
        discard = false;
      }
    }
    // Sigue fallando pero IGDB sí tiene el juego: plantilla solo con datos de IGDB en vez de la frase de reserva
    if (discard && !techLeak && gameData) {
      const tpl = buildGameTemplate(gameData, messagesConfig.dios_fua_game_quips);
      if (tpl) {
        answer = tpl;
        discard = false;
        logger.info(`!dios_fua: plantilla de juego para "${gameData.name}"`);
      }
    }
    if (discard) {
      logger.info(
        `!dios_fua descartado (${techLeak ? 'respuesta técnica' : 'datos del juego sin respaldo'}): ${String(answer).slice(0, 80)}`,
      );
      // Juego que IGDB no conoce: lo dice con humor en vez de la frase de reserva genérica
      const unknownGame = !techLeak && gameText.includes('SIN DATOS') && !/^Nombre: /m.test(gameText);
      client.say(
        channel,
        truncate(
          `@${username} ${pickRandom(unknownGame ? messagesConfig.dios_fua_unknown_game : messagesConfig.dios_fua_no_data)}`,
        ),
      );
      questionCooldowns.set(userId, now + QUESTION_COOLDOWN_MS);
      return;
    }
    answer = String(answer)
      .replace(/\s*\n+\s*/g, ' ')
      .trim(); // una sola línea
    client.say(channel, truncate(`@${username} ${answer}`, qMaxChars));
    addBotMessage(truncate(answer, qMaxChars));
    questionCooldowns.set(userId, now + QUESTION_COOLDOWN_MS);
    persistCooldown(`question-${userId}`, now + QUESTION_COOLDOWN_MS);
    addToUserConversation(userId, 'user', `${username}: ${question}`);
    addToUserConversation(userId, 'assistant', answer);
  } catch (err) {
    logger.error(`!dios_fua: ${err.message}`);
    const isTimeout = err.message?.includes('timeout') || err.code === 'ETIMEDOUT';
    const is429 = err.status === 429;
    const ftype = is429 ? 'ratelimit' : isTimeout ? 'timeout' : 'error';
    client.say(channel, truncate(getFallback(ftype, `@${username}`)));
  }
}

module.exports = { buscarJuegoLookup, chisteCooldowns, handleChiste, handleQuestion };
