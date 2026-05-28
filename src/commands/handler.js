const { loadUsers } = require('../utils/storage');
const { getChannelStats, incrementChannelStat } = require('../utils/supabase');
const { getCurrentGame, getStreamInfo, getFollowerCount, createClip, getGameInfo } = require('../twitch/api');
const { setSilenceMode, isSilenced, setBrbMode, isBrb, getBrbDuration } = require('../utils/state');
const { handleShoutout } = require('../ai/handler');
const { getSummary, trackCommand } = require('../utils/metrics');
const { isLiveViaEventSub, getStreamUptime } = require('../eventsub');
const channelConfig = require('../../config/channel.json');
const logger = require('../utils/logger');

// --- Contador de muertes --- FIX #1: exportado para que eventsub lo use
let deathCount = 0;
function getDeathCount() { return deathCount; }

// --- Contador win/loss ---
let sessionWins = 0;
let sessionLosses = 0;

// --- Cooldowns ---
const cooldowns = new Map();
setInterval(() => { const now = Date.now(); for (const [k,v] of cooldowns) if (now > v) cooldowns.delete(k); }, 30 * 60 * 1000);

// --- Títulos por participación ---
function getUserTitle(messageCount) {
  if (messageCount >= 500) return '🏆 Leyenda del FUA';
  if (messageCount >= 100) return '⭐ Veterano';
  if (messageCount >= 50) return '🔥 Habitual del canal';
  if (messageCount >= 10) return '💬 Chatero';
  if (messageCount >= 1) return '👤 Lurker del FUA';
  return '👤 Nuevo';
}

// --- Textos de ayuda actualizados ---
const helpTexts = {
  'lurk': 'Anúnciate como lurker. El bot te despide con estilo.',
  'comandos': 'Lista de comandos disponibles.',
  'chiste': 'Chiste real del banco de 169 chistes.',
  'trivia': 'Pregunta de trivia. Responde directamente en el chat.',
  'moneda': 'Cara o cruz.',
  'dios_fua': 'Preguntame cualquier cosa. Uso: !dios_fua [pregunta]',
  'juego': 'Juego actual del canal con info de RAWG.',
  'estadisticas': 'Stats del stream en tiempo real.',
  'uptime': 'Tiempo que lleva activo el bot.',
  'titulo': 'Tu titulo en el canal segun mensajes enviados.',
  'silencio': '(Mods) Activa/desactiva todos los mensajes automaticos del bot.',
  'brb': '(Mods) Avisa de ausencia del streamer con recordatorio cada 5 min.',
  'so': '(Mods) Shoutout con IA. Uso: !so @usuario',
  'muertes': 'Contador de muertes. Mods: !muertes +1 / !muertes reset',
  'win': '(Mods) Suma una victoria al marcador.',
  'loss': '(Mods) Suma una derrota al marcador.',
  'score': 'Marcador de victorias/derrotas. Session actual + total histórico.',
  'clip': '(Mods) Crea un clip del momento actual.',
  'marker': '(Mods) Marca un momento en el VOD. Uso: !marker [descripcion]',
  'resumen': '(Mods) Resumen completo del stream actual.',
  'metricas': '(Mods) Metricas de actividad del chat.',
};

// --- Handler principal ---
async function handle(client, channel, tags, command, args, config) {
  const username = tags['display-name'];
  const userId = tags['user-id'];
  const isMod = tags.mod || tags['user-type'] === 'mod' || tags.badges?.broadcaster === '1';

  trackCommand(command);

  // Comandos del config JSON
  if (config.commands[command]) {
    const cmd = config.commands[command];
    const key = `${command}-${userId}`;
    const now = Date.now();
    if (cooldowns.has(key) && now < cooldowns.get(key)) {
      client.say(channel, `@${username} espera ${Math.ceil((cooldowns.get(key) - now) / 1000)}s.`);
      return;
    }
    cooldowns.set(key, now + cmd.cooldown * 1000);
    client.say(channel, cmd.response);
    return;
  }

  switch (command) {
    case 'lurk': return handleLurk(client, channel, tags);
    case 'uptime': return handleUptime(client, channel);
    case 'juego': return await handleJuego(client, channel);
    case 'estadisticas': return await handleEstadisticas(client, channel);
    case 'titulo': return await handleTitulo(client, channel, tags);
    case 'muertes': return handleMuertes(client, channel, args, isMod);
    case 'win':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return await handleWin(client, channel);
    case 'loss':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return await handleLoss(client, channel);
    case 'score': return await handleScore(client, channel);
    case 'brb':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return handleBrb(client, channel, username);
    case 'silencio':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return handleSilencio(client, channel, username);
    case 'so': return await handleShoutout(client, channel, tags, args[1]);
    case 'clip':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return await handleClip(client, channel);
    case 'marker':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return await handleMarker(client, channel, args);
    case 'resumen':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return await handleResumen(client, channel);
    case 'metricas':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return handleMetricas(client, channel);
    case 'ayuda': return handleAyuda(client, channel, args);
  }
}

const lurkMessages = [
  '👀 @{username} entra en modo lurker. ¡El FUA te acompaña en las sombras! 🌙',
  '🕵️ @{username} activa el modo espía. ¡Te vemos aunque no hables! 👀',
  '🌙 @{username} se funde con la oscuridad del lurk. ¡Gracias por quedarte! 💜',
  '🐱 @{username} en modo fantasma. El canal te da las gracias por estar aquí! 🔥',
  '😴 @{username} se va al lurk. ¡El FUA cuida de los lurkers! 💪',
];

function handleLurk(client, channel, tags) {
  const username = tags['display-name'];
  const userId = tags['user-id'] || tags['username'] || username;
  const key = `lurk-${userId}`;
  const now = Date.now();
  if (cooldowns.has(key) && now < cooldowns.get(key)) {
    client.say(channel, `@${username} ya estás en modo lurk, ¡te vemos! 👀`);
    return;
  }
  cooldowns.set(key, now + 60000);
  const msg = lurkMessages[Math.floor(Math.random() * lurkMessages.length)];
  client.say(channel, msg.replace('{username}', username));
}

const botStartTime = Date.now();
function handleUptime(client, channel) {
  const streamUptime = isLiveViaEventSub() ? getStreamUptime() : null;
  if (streamUptime) {
    client.say(channel, `⏱️ Stream activo: ${streamUptime}`);
  } else {
    const e = Date.now() - botStartTime;
    const h = Math.floor(e / 3600000), m = Math.floor((e % 3600000) / 60000), s = Math.floor((e % 60000) / 1000);
    client.say(channel, `⏱️ Bot activo: ${h > 0 ? h + 'h ' : ''}${m > 0 ? m + 'm ' : ''}${s}s (canal offline)`);
  }
}

async function handleJuego(client, channel) {
  const g = await getCurrentGame();
  if (!g?.game) { client.say(channel, '🎮 Sin informacion del juego actual.'); return; }
  try {
    const rawg = await getGameInfo(g.game);
    if (rawg?.genres && rawg?.rating) {
      const year = rawg.released ? rawg.released.slice(0, 4) : '';
      const title = g.title ? ` | "${g.title}"` : '';
      client.say(channel, `🎮 ${g.game}${year ? ` (${year})` : ''} — ${rawg.genres} — ⭐ ${rawg.rating}/5 en RAWG${title}`);
      return;
    }
  } catch {}
  client.say(channel, `🎮 ${g.game}${g.title ? ` — "${g.title}"` : ''}`);
}

async function handleEstadisticas(client, channel) {
  try {
    const eventsub = require('../eventsub');
    const [gameInfo, followers] = await Promise.all([
      getCurrentGame(),
      getFollowerCount(channelConfig.broadcaster_id)
    ]);
    const live = eventsub.isLiveViaEventSub();
    const uptime = eventsub.getStreamUptime();
    let viewers = null;
    if (live) viewers = await eventsub.getViewersWithAppToken(channelConfig.broadcaster_id).catch(() => null);

    if (live) {
      const parts = [];
      if (gameInfo?.game) parts.push(`🎮 ${gameInfo.game}`);
      if (viewers !== null) parts.push(`👁️ ${viewers} viewers`);
      parts.push(`👥 ${followers ?? '?'} seguidores`);
      if (uptime) parts.push(`⏱️ ${uptime}`);
      client.say(channel, `📊 ${parts.join(' | ')}`);
    } else {
      client.say(channel, `📊 Canal offline 😴 | 👥 ${followers ?? '?'} seguidores. ¡Vuelve pronto! 💜`);
    }
  } catch (err) {
    logger.error(`!estadisticas: ${err.message}`);
    client.say(channel, `No puedo obtener stats ahora.`);
  }
}

async function handleWin(client, channel) {
  sessionWins++;
  incrementChannelStat('total_wins').catch(() => {});
  client.say(channel, `🏆 ¡Victoria! ${sessionWins}W / ${sessionLosses}L este stream FUA! 💪`);
}

async function handleLoss(client, channel) {
  sessionLosses++;
  incrementChannelStat('total_losses').catch(() => {});
  client.say(channel, `💀 Derrota... ${sessionWins}W / ${sessionLosses}L este stream 😅`);
}

async function handleScore(client, channel) {
  const stats = await getChannelStats().catch(() => null);
  const session = `🎮 Este stream: ${sessionWins}W / ${sessionLosses}L`;
  if (stats) {
    client.say(channel, `${session} | All-time: ${stats.total_wins}W / ${stats.total_losses}L`);
  } else {
    client.say(channel, session);
  }
}

function handleMuertes(client, channel, args, isMod) {
  if (isMod && args[1] === '+1') { deathCount++; client.say(channel, `💀 Muerte #${deathCount} en este stream 😅`); }
  else if (isMod && args[1] === 'reset') { deathCount = 0; client.say(channel, `💀 Contador reseteado.`); }
  else client.say(channel, `💀 Muertes hoy: ${deathCount}`);
}

function handleBrb(client, channel, username) {
  if (isBrb()) {
    const mins = getBrbDuration();
    setBrbMode(false, null, null);
    client.say(channel, `🔙 ¡@${username} ha vuelto despues de ${mins} min! 🎉`);
  } else {
    setBrbMode(true, client, `#${process.env.CHANNEL}`);
    client.say(channel, `🚪 El streamer ha salido un momento. ¡Ahora vuelve! 👀`);
  }
}

function handleSilencio(client, channel, username) {
  const newState = !isSilenced();
  setSilenceMode(newState);
  client.say(channel, newState ? `🔇 Modo silencio activado por @${username}.` : `🔊 ¡De vuelta! ¡FUA! 💪`);
}

async function handleClip(client, channel) {
  const eventsub = require('../eventsub');
  if (!eventsub.isLiveViaEventSub()) { client.say(channel, `❌ El canal no esta en directo.`); return; }
  client.say(channel, `🎬 Creando clip...`);
  try {
    const url = await createClip();
    client.say(channel, url ? `🎬 ¡Clip creado! ${url}` : `❌ No se pudo crear el clip. Revisa scope channel:manage:clips.`);
  } catch (err) {
    logger.error(`!clip: ${err.message}`);
    client.say(channel, `❌ Error al crear el clip.`);
  }
}

async function handleMarker(client, channel, args) {
  const eventsub = require('../eventsub');
  if (!eventsub.isLiveViaEventSub()) { client.say(channel, '❌ El canal no esta en directo.'); return; }
  const { createStreamMarker } = require('../twitch/api');
  const desc = args.slice(1).join(' ') || 'Momento marcado manualmente';
  try {
    const marker = await createStreamMarker(desc.slice(0, 140));
    if (marker) client.say(channel, `🏁 Marker creado: "${desc.slice(0, 50)}" FUA!`);
    else client.say(channel, '❌ No se pudo crear el marker. Revisa scope user:edit:broadcast.');
  } catch (err) {
    logger.error(`!marker: ${err.message}`);
    client.say(channel, '❌ Error al crear el marker.');
  }
}

async function handleResumen(client, channel) {
  try {
    const eventsub = require('../eventsub');
    const s = getSummary();
    const uptime = eventsub.getStreamUptime() || s.uptime;
    const gameInfo = await getCurrentGame().catch(() => null);
    const game = gameInfo?.game ? `🎮 ${gameInfo.game}` : '';
    const topCmds = s.topCommands || 'ninguno';
    const parts1 = [`📊 Duracion: ${uptime}`, `💬 Msgs/hora: ${s.messagesLastHour}`, game].filter(Boolean);
    const parts2 = [`👁️ Pico: ${s.peakViewers}`, `💀 Muertes: ${deathCount}`, `🏆 Cmds: ${topCmds}`];
    client.say(channel, parts1.join(' | '));
    setTimeout(() => client.say(channel, parts2.join(' | ')), 1500);
  } catch (err) {
    logger.error(`!resumen: ${err.message}`);
    client.say(channel, 'No pude generar el resumen.');
  }
}

function handleMetricas(client, channel) {
  const s = getSummary();
  client.say(channel, `📊 Activo: ${s.uptime} | 💬 Msgs/hora: ${s.messagesLastHour} | 👁️ Pico: ${s.peakViewers} | Top: ${s.topCommands || 'ninguno'}`);
}

async function handleTitulo(client, channel, tags) {
  const username = tags['display-name'];
  try {
    const users = await loadUsers();
    const userData = users[tags['user-id']];
    if (userData) {
      const title = getUserTitle(userData.messageCount || 0);
      client.say(channel, `🏅 @${username} — ${title} (${userData.messageCount || 0} msgs)`);
      return;
    }
  } catch {}
  client.say(channel, `🏅 @${username} — 👤 Nuevo`);
}

function handleAyuda(client, channel, args) {
  const sub = args[1]?.toLowerCase();
  if (sub && helpTexts[sub]) {
    client.say(channel, `❓ !${sub}: ${helpTexts[sub]}`);
  } else {
    client.say(channel, `❓ Comandos: !chiste !trivia !moneda !dios_fua !juego !estadisticas !titulo !uptime | Mods: !so !brb !silencio !muertes !clip !marker !resumen | !ayuda [cmd] para más info`);
  }
}

module.exports = { handle, getDeathCount };
