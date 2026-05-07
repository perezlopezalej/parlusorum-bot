const fs = require('fs');
const { loadUsers } = require('../utils/storage');
const { getCurrentGame, getStreamInfo, getFollowerCount, createClip } = require('../twitch/api');
const { setSilenceMode, isSilenced, setBrbMode, isBrb, getBrbDuration } = require('../utils/state');
const { handleShoutout } = require('../ai/handler');
const { addTodo, getTodos } = require('../utils/todolist');
const { getSummary, trackCommand } = require('../utils/metrics');
const channelConfig = require('../../config/channel.json');
const logger = require('../utils/logger');

// --- Contador de muertes ---
let deathCount = 0;

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

// --- Ayuda ---
const helpTexts = {
  // Comandos públicos
  'comandos': 'Lista de comandos principales.',
  'cita': 'Frase épica o inspiradora.',
  'chiste': 'Chiste real.',
  'consejo': 'Consejo random.',
  'meme': 'Meme en texto.',
  'trivia': 'Pregunta de trivia. Responde directamente.',
  'moneda': 'Cara o cruz.',
  'dios_fua': 'Pregúntame cualquier cosa. Uso: !dios_fua [pregunta]',
  'juego': 'Juego actual del canal.',
  'estadisticas': 'Stats del stream.',
  'uptime': 'Tiempo activo del bot.',
  'titulo': 'Tu título en el canal.',
  // Comandos de mods
  'silencio': '(Mods) Activa/desactiva el silencio del bot.',
  'brb': '(Mods) Avisa de ausencia del streamer.',
  'so': '(Mods) Shoutout inteligente. Uso: !so @usuario',
  'todo': '(Mods) Añade tarea. Uso: !todo [tarea]',
  'pendientes': 'Lista de tareas pendientes.',
  'muertes': 'Contador de muertes. Mods: !muertes +1 / !muertes reset',
  'clip': '(Mods) Crea un clip del momento actual.',
  'metricas': '(Mods) Métricas de actividad del chat.',
};

// --- Handler principal (async) ---
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
    case 'uptime': return handleUptime(client, channel);
    case 'juego': return await handleJuego(client, channel);
    case 'estadisticas': return await handleEstadisticas(client, channel);
    case 'titulo': return await handleTitulo(client, channel, tags);
    case 'pendientes': return handlePendientes(client, channel);
    case 'muertes': return handleMuertes(client, channel, args, isMod);
    case 'brb':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return handleBrb(client, channel, username);
    case 'silencio':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return handleSilencio(client, channel, username);
    case 'so': return await handleShoutout(client, channel, tags, args[1]);
    case 'todo':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return handleTodo(client, channel, username, args);
    case 'clip':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return await handleClip(client, channel);
    case 'metricas':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return handleMetricas(client, channel);
    case 'ayuda': return handleAyuda(client, channel, args);
  }
}

const botStartTime = Date.now();
function handleUptime(client, channel) {
  const e = Date.now() - botStartTime;
  const h = Math.floor(e / 3600000), m = Math.floor((e % 3600000) / 60000), s = Math.floor((e % 60000) / 1000);
  client.say(channel, `⏱️ Bot activo: ${h > 0 ? h + 'h ' : ''}${m > 0 ? m + 'm ' : ''}${s}s`);
}

async function handleJuego(client, channel) {
  const g = await getCurrentGame();
  client.say(channel, g?.game ? `🎮 ${g.game}${g.title ? ` — "${g.title}"` : ''}` : `🎮 Sin información del juego actual.`);
}

async function handleEstadisticas(client, channel) {
  try {
    const [s, f] = await Promise.all([getStreamInfo(), getFollowerCount(channelConfig.broadcaster_id)]);
    if (s?.live) {
      const mins = s.startedAt ? Math.floor((Date.now() - new Date(s.startedAt)) / 60000) : null;
      const uptime = mins ? `${Math.floor(mins/60)}h ${mins%60}m` : '?';
      client.say(channel, `📊 ${s.game || '?'} | 👁️ ${s.viewers} viewers | 👥 ${f ?? '?'} seguidores | ⏱️ ${uptime}`);
    } else {
      client.say(channel, `📊 Canal offline. 👥 ${f ?? '?'} seguidores.`);
    }
  } catch (err) { logger.error(`!estadisticas: ${err.message}`); client.say(channel, `No puedo obtener stats ahora.`); }
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
    client.say(channel, `🔙 ¡@${username} ha vuelto después de ${mins} min! 🎉`);
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

function handleTodo(client, channel, username, args) {
  const task = args.slice(1).join(' ');
  if (!task) { client.say(channel, `Uso: !todo [tarea]`); return; }
  const num = addTodo(task, username);
  client.say(channel, `📝 Tarea #${num}: "${task}"`);
}

function handlePendientes(client, channel) {
  const todos = getTodos().filter(t => !t.done);
  if (todos.length === 0) { client.say(channel, `✅ ¡Sin tareas pendientes!`); return; }
  const list = todos.slice(0, 5).map((t, i) => `${i + 1}. ${t.task}`).join(' | ');
  client.say(channel, `📋 ${list}`.slice(0, 490));
}

async function handleClip(client, channel) {
  const s = await getStreamInfo();
  if (!s?.live) { client.say(channel, `❌ El canal no está en directo.`); return; }
  client.say(channel, `🎬 Creando clip...`);
  const url = await createClip();
  client.say(channel, url ? `🎬 ¡Clip creado! ${url}` : `❌ No se pudo crear el clip.`);
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
    client.say(channel, `❓ Comandos principales: !cita !chiste !consejo !meme !trivia !moneda !dios_fua !juego !estadisticas !titulo !uptime | Mods: !so !brb !silencio !todo !muertes !clip | !ayuda [comando] para más info`);
  }
}

module.exports = { handle };
