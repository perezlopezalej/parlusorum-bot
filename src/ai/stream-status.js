// Estado del directo (online/offline), mensajes de inicio y fin, modo warmup.
const channelConfig = require('../../config/channel.json');
const messagesConfig = require('../../config/messages.json');
const { getStreamInfo } = require('../twitch/api');
const { isSilenced, isReactive, claimStartAnnouncement, resetStartAnnouncement } = require('../utils/state');
const quality = require('./quality');
const { canMakeRequest } = require('../utils/ratelimit');
const logger = require('../utils/logger');
const { truncate } = require('../utils/groq-utils');
const { aiChat } = require('../utils/ai-router');
const { throttleSay } = require('../alerts/handler');
const { getEventSubLiveStatus, pickRandom } = require('./common');

// --- Stream status ---
let streamWasLive = false;

let streamStatusInitialized = false;

let streamEndPostedByEventSub = false;

async function initStreamStatus() {
  const isLive = getEventSubLiveStatus();
  if (isLive) {
    streamWasLive = true;
    streamStatusInitialized = true;
    logger.info(`Iniciando: EN DIRECTO (EventSub)`);
    return;
  }
  const info = await getStreamInfo().catch(() => null);
  streamWasLive = info?.live === true;
  streamStatusInitialized = true;
  logger.info(`Iniciando: ${streamWasLive ? 'EN DIRECTO' : 'OFFLINE'}`);
}

const streamStartMessages = messagesConfig.stream_start_messages || [];

const streamEndMessages = messagesConfig.stream_end_messages || [];

async function checkStreamStatus(client, channel) {
  if (!streamStatusInitialized) return;
  const isLive = getEventSubLiveStatus();

  if (!streamWasLive && isLive) {
    streamWasLive = true;
    streamEndPostedByEventSub = false;
    if (claimStartAnnouncement()) client.say(channel, pickRandom(streamStartMessages));
  } else if (streamWasLive && !isLive) {
    streamWasLive = false;
    resetStartAnnouncement();
    // EventSub ya posteó el resumen IA; solo usar fallback si no lo hizo
    if (!streamEndPostedByEventSub) {
      client.say(channel, pickRandom(streamEndMessages));
    }
  }
}

// Llamado desde eventsub.js cuando arrancan con pocos viewers
async function onWarmupMode(client, channel, game) {
  if (!canMakeRequest()) return;
  // Un solo mensaje de inicio: si el aviso normal ya salió, el calentamiento no añade otro
  if (!claimStartAnnouncement()) {
    logger.info('Warmup: ya salió el mensaje de inicio, no se añade otro');
    return;
  }
  try {
    const gameContext = game ? ` El juego de hoy: "${game}".` : '';
    const response = await aiChat('alert', {
      max_tokens: 100,
      messages: [
        {
          role: 'system',
          content: `Eres dios_fua, bot del canal de ${channelConfig.streamer}. Canal: ${channelConfig.vibe}. Emotes si encajan: ${(channelConfig.channel_emotes || []).join(', ')}. El stream acaba de empezar y hay pocos viewers — momento ideal para calentar el chat.${gameContext} Genera un mensaje de calentamiento: una bienvenida energetica + UNA pregunta directa al chat sobre ${game ? 'el juego de hoy' : 'lo que se viene'} que invite a responder. SIEMPRE en espanol. Max 2 frases cortas que se lean bien en voz alta, con numeros y tiempos en palabras y sin simbolos. Usa FUA. Sin presentarte.`,
        },
        { role: 'user', content: `Calienta el chat` },
      ],
    });
    client.say(channel, truncate(quality.vetAuto(response.choices[0].message.content)));
    logger.info(`🔥 Warmup mode activado`);
  } catch (err) {
    logger.warn(`Warmup mode: ${err.message}`);
    if (!isSilenced()) client.say(channel, truncate(messagesConfig.warmup_fallback));
  }
}

// Llamado desde eventsub.js tras generar la memoria del stream
function postStreamEnd(client, channel, aiSummary) {
  streamWasLive = false;
  streamEndPostedByEventSub = true;
  if (isReactive()) return; // modo reactivo: sin resumen espontáneo de fin de stream
  const msg = aiSummary
    ? `🎬 ¡Fin del stream! ${aiSummary} ¡Hasta la próxima! FUA! 💜🔥`
    : pickRandom(streamEndMessages);
  throttleSay(client, channel, truncate(msg));
}

module.exports = { checkStreamStatus, initStreamStatus, onWarmupMode, postStreamEnd };
