// Cohost: comentarios de eventos en cola y comentarios libres por reloj.
const channelConfig = require('../../config/channel.json');
const { getCurrentGame, lookupGameInfo } = require('../twitch/api');
const {
  getPlayer,
  isFreeCohostPaused,
  isTriviaActive,
  isSilenced,
  isReactive,
  isRaidActive,
  getRaidUsername,
  isBrb,
  getStreamNarrative,
  getBotHistory,
  addBotMessage,
  recordCohostAttempt,
  recordCohostSent,
  getDeathCount,
  getBossCount,
  markStructure,
  getUsedStructures,
  getStreamStartedAt,
  recordCohost,
  recordCohostDiscard,
  getLastCohostTime,
  getCohostTimes,
  markNamed,
  getNamedUsers,
  onNarrativeEvent,
  addCohostText,
  getCohostTexts,
} = require('../utils/state');
const { mergeBossMoments, bossInBatch, BOSS_SETTLE_MS } = require('../utils/narrative');
const {
  buildStoryBlock,
  condenseChat,
  classifyCohostMoment,
  eventCohostAllowed,
  eventExpired,
  freeCohostDue,
  pruneHourly,
  EVENT_COHOST_MAX_PER_HOUR,
  EVENT_QUEUE_TTL_MS,
  FREE_COHOST_INTERVAL_MS,
  FREE_COHOST_ACTIVITY_WINDOW_MS,
  FREE_COHOST_MIN_MESSAGES,
  FREE_COHOST_MAX_PER_HOUR,
  streakAllowed,
  STREAK_COHOST_GAP_MS,
  hourlyCapReached,
  pickFreeTopic,
} = require('../utils/narrative');
const factcheck = require('./factcheck');
const { pickBest } = require('./pick-best');
const quality = require('./quality');
const { canMakeRequest } = require('../utils/ratelimit');
const { dayLine, pickCohostForm, buildCohostSystem, parseCandidates, rankCandidates, retryNote } = require('./style');
const { getRecentSessionDeaths } = require('../utils/supabase');
const logger = require('../utils/logger');
const chatlog = require('../utils/chatlog');
const { truncate, TWITCH_MAX_LENGTH } = require('../utils/groq-utils');
const { aiChat } = require('../utils/ai-router');
const { chatHistory, getRecentHistory } = require('./chat-memory');
const { getEventSubLiveStatus, isDirectedElsewhere } = require('./common');
const { emoteLineFor, getLoreBlock, getModeConfig, refreshMode } = require('./prompt-context');

// Cohost: los eventos (jefe, muerte, sub...) se comentan siempre y esperan en cola hasta EVENT_TTL_MS; los comentarios libres
// van por reloj (FREE_INTERVAL_MS, con chat activo). MAX_PER_HOUR / FREE_MAX_PER_HOUR son solo frenos de seguridad.
// NAME_WINDOW = tiempo sin volver a nombrar al mismo usuario. Los silencios los cubre el hook, no el cohost.
const COHOST_EVENT_TTL = parseInt(process.env.COHOST_EVENT_TTL_MS || String(EVENT_QUEUE_TTL_MS), 10);

const COHOST_FREE_INTERVAL = parseInt(process.env.COHOST_FREE_INTERVAL_MS || String(FREE_COHOST_INTERVAL_MS), 10);

const COHOST_STREAK_GAP = parseInt(process.env.COHOST_STREAK_GAP_MS || String(STREAK_COHOST_GAP_MS), 10);

const COHOST_FREE_MAX_PER_HOUR = parseInt(process.env.COHOST_FREE_MAX_PER_HOUR || String(FREE_COHOST_MAX_PER_HOUR), 10);

const COHOST_MAX_PER_HOUR = parseInt(process.env.COHOST_MAX_PER_HOUR || String(EVENT_COHOST_MAX_PER_HOUR), 10);

const COHOST_NAME_WINDOW = parseInt(process.env.COHOST_NAME_WINDOW_MS || '900000', 10);

const COHOST_CANDIDATES = parseInt(process.env.COHOST_CANDIDATES || '2', 10) === 3 ? 3 : 2; // candidatos por llamada del cohost (2 por defecto: en la prueba 2 bastan y gastan menos tokens)

// --- Co-host ---
let cohostRunning = false;

function detectChatMood(messages) {
  const text = messages.join(' ').toLowerCase();
  const hype = [
    'jaja',
    'lol',
    'gg',
    'pog',
    'hype',
    'vamo',
    'goat',
    'omg',
    'wow',
    'ez',
    'pepehype',
    'pogchamp',
    'pepega',
    'luego',
    'siuu',
  ];
  const frustracion = [
    'oof',
    'no',
    'mal',
    'wtf',
    'otra vez',
    'siempre',
    'muerto',
    'nooo',
    'noooo',
    'rip',
    'gg ez',
    'mentira',
    'dios mio',
  ];
  const hypeCount = hype.filter((w) => text.includes(w)).length;
  const frustCount = frustracion.filter((w) => text.includes(w)).length;
  if (hypeCount >= 2) return 'HYPE';
  if (frustCount >= 2) return 'FRUSTRACIÓN';
  return 'NEUTRO';
}

// Cohost: habla cuando pasa algo destacado (`moment`, siempre, en cola) y, por reloj, reaccionando a lo que se habla en el chat.
// runCohost devuelve 'sent' | 'dropped' | 'retry' (retry = ahora no puede; se reintenta mientras el evento no caduque).
// La respuesta se valida en código: lo grave (inventos del juego, muertes, latam, robot) se descarta tras un reintento; lo leve
// (nombre repetido, fórmula, parecido, ambiente) se reintenta una vez y si persiste se envía igual. Después, la comprobación
// SÍ/NO del modelo rápido, solo si el mensaje habla del juego.
let freeCohostTimes = []; // cupo compartido: comentarios libres + rachas de muertes ENVIADOS en la última hora (máx. COHOST_FREE_MAX_PER_HOUR)

let freeAttemptTimes = []; // intentos de comentario libre (enviados o no): solo freno de seguridad para los reintentos

const FREE_ATTEMPTS_MAX_PER_HOUR = 8;

let lastCohostForm = ''; // id de la última forma del cohost (rota, no se repite seguida)

let lastFreeTopic = ''; // id del último tema del cohost libre enviado (rota, no se repite seguido)

let lastSharedAt = 0; // último comentario enviado del cupo compartido (libre o racha)

let deathRecordCache = { at: 0, max: 0 };

// Máximo de muertes de los streams anteriores (para detectar el récord); caché de 30 min
async function getDeathRecord() {
  const now = Date.now();
  if (now - deathRecordCache.at < 30 * 60 * 1000) return deathRecordCache.max;
  const rows = await getRecentSessionDeaths(30).catch(() => []);
  deathRecordCache = {
    at: now,
    max: rows.reduce((m, r) => Math.max(m, Number.isFinite(r.death_count) ? r.death_count : 0), 0),
  };
  return deathRecordCache.max;
}

// Chat reciente sin las conversaciones privadas entre usuarios (para los comentarios libres)
function publicChatContext(n = 5) {
  const cutoff = Date.now() - 10 * 60 * 1000;
  return chatHistory
    .filter((m) => m.ts > cutoff && !isDirectedElsewhere(m.message))
    .slice(-n)
    .map((m) => `${m.username}: ${quality.cleanChatNoise(m.message)}`)
    .join('\n');
}

// Si la mayoría de los últimos mensajes son charla entre dos usuarios, el cohost libre no entra
function isPrivateExchange(now = Date.now(), window = 6, min = 3) {
  const last = chatHistory.filter((m) => m.ts > now - 5 * 60 * 1000).slice(-window);
  return last.filter((m) => isDirectedElsewhere(m.message)).length >= min;
}

async function runCohost(client, channel, moment = null) {
  const kind = moment ? 'event' : 'free';
  const kindKey = moment ? moment.kind : 'free';
  if (!getEventSubLiveStatus()) return 'dropped';
  const blocked = isSilenced()
    ? 'silencio'
    : isReactive()
      ? 'reactivo'
      : isBrb()
        ? 'brb'
        : isTriviaActive()
          ? 'trivia'
          : null;
  if (blocked) {
    if (moment) {
      recordCohostAttempt(kind);
      recordCohostDiscard(blocked);
    }
    return 'dropped';
  }
  if (cohostRunning) return moment ? 'retry' : 'dropped';
  const now = Date.now();
  if (!moment && isFreeCohostPaused(now)) return 'dropped';
  if (
    moment &&
    !eventCohostAllowed({ now, lastAt: getLastCohostTime(), stamps: getCohostTimes(), max: COHOST_MAX_PER_HOUR })
  )
    return 'retry';
  // Las rachas de muertes comparten cupo con los comentarios libres (~4/h como máximo): fuera de cupo se descartan, no esperan en cola
  const isStreak = moment?.kind === 'streak';
  if (
    isStreak &&
    !streakAllowed({
      now,
      lastSharedAt,
      sharedStamps: freeCohostTimes,
      gapMs: COHOST_STREAK_GAP,
      max: COHOST_FREE_MAX_PER_HOUR,
    })
  ) {
    recordCohostAttempt(kind);
    recordCohostDiscard('racha_cupo');
    logger.info('Co-host: racha de muertes sin comentar (cupo compartido con los libres)');
    return 'dropped';
  }
  if (!canMakeRequest()) {
    if (moment) return 'retry';
    recordCohostAttempt(kind);
    recordCohostDiscard('ratelimit');
    return 'dropped';
  }
  const recentContext = moment ? getRecentHistory(5) : publicChatContext(5);
  if (!moment && !recentContext) return 'dropped';
  // Alguien dice que está mal o de bajón: el cohost libre no bromea con eso (calla)
  if (!moment && quality.hasPersonalDistress(recentContext)) {
    logger.info('Co-host libre: calla (alguien comenta que está mal)');
    return 'dropped';
  }
  if (!moment && isPrivateExchange(now)) {
    recordCohostAttempt(kind);
    recordCohostDiscard('privado');
    return 'dropped';
  }

  recordCohostAttempt(kind);
  if (!moment) freeAttemptTimes = pruneHourly([...freeAttemptTimes, now]);
  refreshMode();
  const modeConfig = getModeConfig();
  const recentBot = getBotHistory().map((e) => e.msg);
  const emotes = channelConfig.channel_emotes || [];
  const allowEmote = quality.emoteAllowed(recentBot, emotes);
  const deathCount = getDeathCount();
  const named = getNamedUsers();
  const namesAllowed = !!moment && (moment.kind === 'sub' || moment.kind === 'raid');

  cohostRunning = true;
  let reason = 'error';

  try {
    const gameInfo = await getCurrentGame();
    const mood = detectChatMood(chatHistory.slice(-10).map((m) => m.message || ''));
    const startedAt = getStreamStartedAt();
    const minutes = startedAt ? Math.floor((now - startedAt) / 60000) : null;
    const baseDeathLine =
      deathCount === 0
        ? 'Aún sin caídas anotadas: el tema es la partida, el chat o el FUA.'
        : `${deathCount} ${deathCount === 1 ? 'caída anotada' : 'caídas anotadas'}.`;
    const raidLine = isRaidActive()
      ? ` Acaba de llegar una raid de @${getRaidUsername()}: los raiders son visitantes de otro canal, no los espectadores del directo.`
      : '';
    const nameLine = namesAllowed
      ? 'Puedes nombrar a quien aparece en el suceso.'
      : 'Dirígete a Manu o al chat en general.';
    const emoteLine = emoteLineFor(allowEmote, emotes, recentBot);
    const loreBlock = await getLoreBlock();
    const windowLines = chatHistory.filter((m) => m.ts > now - 5 * 60 * 1000).slice(-25);
    const chatSummary = condenseChat(windowLines);
    const maxChars = modeConfig.max_chars ?? TWITCH_MAX_LENGTH;
    // Ficha del juego actual (caché de IGDB) para que el revisor reconozca como respaldados el año, el estudio o el género
    const gameFacts = gameInfo?.game
      ? factcheck.gameFactsText((await lookupGameInfo(gameInfo.game, { detail: true }).catch(() => ({}))).info)
      : '';
    const facts = `Juego: ${gameInfo?.game || 'desconocido'}. Muertes anotadas: ${deathCount}. ${gameFacts} ${moment ? `Suceso: ${moment.description}. ` : ''}Chat reciente: ${recentContext}`;

    // El número de muertes no se cita en dos mensajes seguidos del bot (salvo en la primera muerte y el récord, que son el dato)
    const countIsTheNews = moment && ['first_death', 'record'].includes(moment.kind);
    const lastCitedDeaths =
      !countIsTheNews && quality.citesDeathCount(recentBot[recentBot.length - 1] || '', deathCount);
    const deathLine = `${baseDeathLine}${lastCitedDeaths ? ' Esta vez deja fuera la cifra de caídas.' : ''}${raidLine}`;
    const validateCtx = {
      player: getPlayer(),
      deathCount,
      recent: recentBot,
      sameKind: getCohostTexts(kindKey),
      named: namesAllowed ? new Map() : named,
      now,
      nameWindowMs: COHOST_NAME_WINDOW,
      usedStructures: getUsedStructures(),
      lastCitedDeaths,
      game: gameInfo?.game || '',
    };
    // Revisión en una llamada: datos del juego (si habla de él) y sentido/redacción
    let generatorModel; // modelo que escribió los candidatos: el selector es de otra familia
    const reviewText = async (text, { sense = true } = {}) => {
      const review = await factcheck.evaluate(text, facts, { game: gameInfo?.game, sense });
      if (review.discard) {
        logger.info(`Co-host descartado (datos del juego sin respaldo): ${text.slice(0, 80)}`);
        return { ok: false, reason: 'factcheck' };
      }
      if (review.nonsense) {
        logger.info(`Co-host descartado (sin sentido o mal escrito): ${text.slice(0, 80)}`);
        return { ok: false, reason: 'sentido' };
      }
      return { ok: true };
    };
    // Un candidato listo para validar: recorte, política de emotes y, si abre con un nombre ya citado, sin él
    const prepare = (candidate) => {
      let text = quality.applyEmotePolicy(truncate(candidate, maxChars), allowEmote, emotes, recentBot);
      if (!namesAllowed) {
        const repeated = quality.recentlyNamedIn(text, named, now, COHOST_NAME_WINDOW);
        const stripped = repeated.length ? quality.stripLeadingNames(text, repeated) : null;
        if (stripped) text = stripped;
      }
      return text;
    };

    let reply = '';
    let fixKey = ''; // regla fallida del intento anterior: el reintento recibe solo la corrección en positivo
    const form = pickCohostForm(lastCohostForm); // la forma cambia en cada comentario, sin repetir la anterior
    lastCohostForm = form.id;
    // Cohost libre: el código elige el tema (rotando) y el modelo solo devuelve la lista vacía si de verdad no puede hablar de él
    const topicCtx = {
      minutes: minutes || 0,
      bosses: getBossCount(),
      game: gameInfo?.game || '',
      deathCount,
      canCiteDeaths: !lastCitedDeaths,
    };
    let freeTopic = moment ? null : pickFreeTopic({ ...topicCtx, last: lastFreeTopic });
    for (let attempt = 0; attempt < 2 && !reply; attempt++) {
      if (attempt > 0 && !canMakeRequest()) {
        reason = 'ratelimit';
        break;
      }
      const system =
        buildCohostSystem({
          game: gameInfo?.game || '',
          minutes,
          deathLine,
          player: getPlayer(),
          mood,
          form,
          emoteLine,
          nameLine,
          loreBlock,
          candidates: COHOST_CANDIDATES,
          modeLine: modeConfig.prompt_extension,
          event: !!moment,
          weekday: !getUsedStructures().has('dia-semana'),
        }) + retryNote(fixKey);
      const chatBlock = recentContext ? `<chat>\n${recentContext}\n</chat>` : '';
      const user = moment
        ? `<suceso>${moment.description}</suceso>\n${chatBlock}\nComenta el suceso.`
        : `${chatBlock}${chatSummary ? `\n<resumen_chat>${chatSummary}</resumen_chat>` : ''}${buildStoryBlock(getStreamNarrative(), now)}\n<tema>${freeTopic.note}</tema>\nComenta el tema.`;
      const response = await aiChat('cohost', {
        max_tokens: 220,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      generatorModel = response._ai?.model;
      const raw = (response.choices[0].message.content || '').trim();
      const candidates = /^SKIP\b/i.test(raw) ? [] : parseCandidates(raw, COHOST_CANDIDATES);
      if (!candidates.length) {
        if (moment) {
          fixKey = 'vacio';
          reason = 'quality:vacio';
          continue;
        }
        recordCohostDiscard('skip'); // cuenta cada lista vacía del modelo (sale en el resumen de fin de stream)
        if (attempt === 0) {
          // segundo intento con otro tema
          freeTopic = pickFreeTopic({ ...topicCtx, last: freeTopic.id });
          logger.info(`Co-host: sin candidatos, reintento con otro tema (${freeTopic.id})`);
          continue;
        }
        reason = 'sin_tema';
        logger.info('Co-host: sin tema tras el reintento');
        break;
      }
      // El código elige: pasa todos los filtros y es el que menos se parece a los últimos mensajes del bot
      const { ranked, failures } = rankCandidates(candidates.map(prepare), {
        validate: (t) => quality.validateCohost(t, validateCtx),
        recent: recentBot,
      });
      for (const f of failures) logger.info(`Co-host descartado (${f.reason}): ${f.text.slice(0, 80)}`);
      if (ranked.length) {
        // Un modelo pequeño elige el mejor comparándolos con el chat y el juego, o dice que ninguno vale (entonces se calla)
        const pick = await pickBest(
          ranked.map((r) => r.text),
          {
            dayLine: dayLine(new Date(now)),
            game: gameInfo?.game || '',
            facts: `Caídas anotadas: ${deathCount}. Juega ${getPlayer() === 'pao' ? 'Pao' : 'Manu'}.${minutes != null ? ` Llevan ${quality.approxDuration(minutes)} de directo.` : ''}${moment ? ` Suceso: ${moment.description}.` : ''}`,
            chat: getRecentHistory(8),
            activity: chatHistory.filter((m) => m.ts > now - 5 * 60 * 1000).length,
            generator: generatorModel,
          },
        );
        if (pick.status === 'ok') {
          const chosen = ranked[pick.index].text;
          const review = await reviewText(chosen, { sense: false }); // el sentido ya lo ha mirado el selector: aquí solo los datos del juego
          if (review.ok) reply = chosen;
          else {
            fixKey = review.reason;
            reason = review.reason;
          }
        } else if (pick.status === 'none') {
          logger.info('Co-host: el selector no ve bueno ningún candidato');
          fixKey = 'selector';
          reason = 'selector';
        } else {
          // el selector no pudo (cupo o fallo): orden del código y la revisión de siempre
          for (const candidate of ranked.slice(0, 2)) {
            const review = await reviewText(candidate.text);
            if (review.ok) {
              reply = candidate.text;
              break;
            }
            fixKey = review.reason;
            reason = review.reason;
          }
        }
      }
      if (!reply && !ranked.length) {
        const counts = {};
        for (const f of failures) counts[f.rule] = (counts[f.rule] || 0) + 1;
        fixKey = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 'vacio';
        reason = `quality:${fixKey}`;
      }
    }

    if (!reply) {
      recordCohostDiscard(reason);
      return 'dropped';
    } // los candidatos fallaron: se calla
    if (freeTopic) lastFreeTopic = freeTopic.id;
    client.say(channel, reply, { origin: 'cohost' });
    addBotMessage(reply);
    addCohostText(kindKey, reply);
    for (const key of quality.streamMarks(reply, gameInfo?.game || '')) markStructure(key);
    markNamed(quality.namesIn(reply, [...chatHistory.slice(-60).map((m) => m.username), 'pao']));
    recordCohost();
    recordCohostSent(kind);
    if (isStreak || !moment) {
      // cupo compartido: solo cuentan los enviados (un SKIP o un descarte no gasta cupo)
      lastSharedAt = Date.now();
      lastFreeAt = lastSharedAt; // el reloj de los libres vuelve a empezar
      freeCohostTimes = pruneHourly([...freeCohostTimes, lastSharedAt]);
    }
    return 'sent';
  } catch (err) {
    logger.error(`Co-host: ${err.message}`);
    recordCohostDiscard(err.code === 'NO_QUOTA' ? 'sin_cupo' : err.status === 429 ? 'groq429' : 'error');
    return 'dropped';
  } finally {
    cohostRunning = false;
  }
}

// Cola de eventos: se comentan todos, de uno en uno; los que esperan más de COHOST_EVENT_TTL caducan
const EVENT_QUEUE_MAX = 6;

const EVENT_SETTLE_MS = 3000; // deja que salga antes el mensaje propio del evento (alerta, contador...)

const eventQueue = [];

let drainTimer = null;

let draining = false;

function scheduleDrain(ms) {
  if (drainTimer) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    drainEventQueue().catch((err) => logger.warn(`Cola de cohost: ${err.message}`));
  }, ms);
  drainTimer.unref?.();
}

// Jefes seguidos: varios !boss en ~2 min se comentan una sola vez (el primero espera BOSS_SETTLE_MS por si llegan más)
let lastBossAt = 0;

const BOSS_SETTLE = parseInt(process.env.COHOST_BOSS_SETTLE_MS || String(BOSS_SETTLE_MS), 10);

function enqueueCohostMoment(client, channel, moment, now = Date.now()) {
  if (moment.kind === 'boss') {
    const inBatch = bossInBatch(lastBossAt, now);
    lastBossAt = now;
    if (inBatch) {
      const pending = eventQueue.find((i) => i.moment.kind === 'boss' && !i.started);
      if (pending) {
        pending.moment = mergeBossMoments(pending.moment, moment, getBossCount());
        pending.notBefore = now + BOSS_SETTLE;
        scheduleDrain(BOSS_SETTLE);
      } else {
        recordCohostAttempt('event');
        recordCohostDiscard('jefe_seguido');
      } // la tanda ya se comentó
      return;
    }
    eventQueue.push({ client, channel, moment, queuedAt: now, notBefore: now + BOSS_SETTLE });
    scheduleDrain(BOSS_SETTLE);
    return;
  }
  eventQueue.push({ client, channel, moment, queuedAt: now, notBefore: now + EVENT_SETTLE_MS });
  if (eventQueue.length > EVENT_QUEUE_MAX) {
    eventQueue.shift();
    recordCohostAttempt('event');
    recordCohostDiscard('cola_llena');
  }
  scheduleDrain(EVENT_SETTLE_MS);
}

async function drainEventQueue() {
  if (draining) return;
  draining = true;
  try {
    while (eventQueue.length) {
      const item = eventQueue[0];
      const now = Date.now();
      if (eventExpired(item.queuedAt, now, COHOST_EVENT_TTL)) {
        eventQueue.shift();
        recordCohostAttempt('event');
        recordCohostDiscard('caducado');
        logger.info(`Co-host: evento caducado en cola (${item.moment.kind})`);
        continue;
      }
      if (now < item.notBefore) {
        scheduleDrain(item.notBefore - now);
        return;
      }
      item.started = true; // un jefe nuevo ya no se suma a este comentario
      const outcome = await chatlog
        .runWithOrigin('cohost', () => runCohost(item.client, item.channel, item.moment))
        .catch((err) => {
          logger.warn(`Cohost por evento: ${err.message}`);
          return 'dropped';
        });
      if (outcome === 'retry') {
        item.started = false;
        scheduleDrain(5000);
        return;
      }
      eventQueue.shift();
    }
  } finally {
    draining = false;
  }
}

// Comentario libre por reloj: cada COHOST_FREE_INTERVAL, si el chat tiene actividad reciente. Tras un fallo reintenta en 3 min.
const FREE_RETRY_MS = 3 * 60 * 1000;

let lastFreeAt = 0;

async function freeCohostTick(client, channel) {
  if (!getEventSubLiveStatus()) {
    lastFreeAt = 0;
    return;
  }
  const now = Date.now();
  if (!lastFreeAt) {
    lastFreeAt = now;
    return;
  }
  if (cohostRunning || eventQueue.length) return;
  if (isFreeCohostPaused(now)) return; // alguien pidió silencio: los libres esperan
  const recentMessages = chatHistory.filter((m) => m.ts > now - FREE_COHOST_ACTIVITY_WINDOW_MS).length;
  if (hourlyCapReached(freeCohostTimes, COHOST_FREE_MAX_PER_HOUR, now)) return;
  if (
    !freeCohostDue({
      now,
      lastFreeAt,
      intervalMs: COHOST_FREE_INTERVAL,
      recentMessages,
      minMessages: FREE_COHOST_MIN_MESSAGES,
      lastAnyAt: getLastCohostTime(),
      freeStamps: freeAttemptTimes,
      maxFree: FREE_ATTEMPTS_MAX_PER_HOUR,
    })
  )
    return;
  const outcome = await chatlog.runWithOrigin('cohost', () => runCohost(client, channel, null));
  lastFreeAt = outcome === 'sent' ? Date.now() : Date.now() - COHOST_FREE_INTERVAL + FREE_RETRY_MS;
}

// Engancha el cohost a los eventos nuevos de la narrativa (muerte, boss, sub, raid, explosión del chat...) y arranca el reloj de los libres.
function startEventCohost(client, channel) {
  onNarrativeEvent(async (event, events) => {
    if (!getEventSubLiveStatus()) return;
    const deathCount = getDeathCount();
    const recordToBeat = event.type === 'death' ? await getDeathRecord() : 0;
    const moment = classifyCohostMoment(event, { events, deathCount, recordToBeat });
    if (moment) enqueueCohostMoment(client, channel, moment);
  });
  const clock = setInterval(() => {
    freeCohostTick(client, channel).catch((err) => logger.warn(`Cohost libre: ${err.message}`));
  }, 30 * 1000);
  clock.unref?.();
}

module.exports = { runCohost, enqueueCohostMoment, startEventCohost };
