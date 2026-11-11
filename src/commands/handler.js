const { getChannelStats, incrementChannelStat, persistCooldown, saveSessionDeaths, saveSessionBosses, getSessionsDeathsByGame, getSessionsBossesByGame, getCurrentSessionId } = require('../utils/supabase');
const { loadUsers } = require('../utils/storage');
const { MAX_DEATHS_ADD, gameTotalReply, parseMuertesArgs, parseBossArgs, applyBossDelta, sumGameDeaths, formatSince, findUserByName } = require('./stats');
const { getCurrentGame, getStreamInfo, getFollowerCount, createClip, getGameInfo, createStreamMarker } = require('../twitch/api');
const { setMuteUntil, getMuteUntil, setBotMode, getBotMode, setSilenceMode, isSilenced, setBrbMode, isBrb, getBrbDuration, getDeathCount, incrementDeathCount, resetDeathCount, getBossCount, setBossCount, resetBossCount, resetTriviaStats, addNarrativeEvent, getPlayer, setPlayer } = require('../utils/state');
const { handleShoutout } = require('../ai/handler');
const { getLoreOverview, approveLore, deleteLore } = require('../lore/handler');
const { buildCommandList, getHelpText } = require('./help');
const { formatJuegoLine } = require('./juego');
const { sanitizeForAI } = require('../utils/filter');
const { persistBotState } = require('../utils/bot-state');
const { parseMinutes, parseMode, clockMadrid, MAX_MUTE_MIN } = require('../utils/bot-control');
const { truncate } = require('../utils/groq-utils');
const { template } = require('../utils/plantillas');
const { getSummary, trackCommand, resetStreamMetrics } = require('../utils/metrics');
const { isLiveViaEventSub, getStreamUptime, getViewersWithAppToken } = require('../eventsub');
const channelConfig = require('../../config/channel.json');
const allMsgs = require('../../config/messages.json');
const loreMsgs = allMsgs.lore;
const muertesMsgs = allMsgs.muertes;
const bossMsgs = allMsgs.boss;
const tiempoMsgs = allMsgs.tiempo;
const logger = require('../utils/logger');

function resetSessionCounters() { resetDeathCount(); resetBossCount(); resetStreamMetrics(); resetTriviaStats(); }

// --- Cooldowns ---
const cooldowns = new Map();
setInterval(() => { const now = Date.now(); for (const [k,v] of cooldowns) if (now > v) cooldowns.delete(k); }, 30 * 60 * 1000);

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
    case 'muertes': return await handleMuertes(client, channel, args, isMod, username);
    case 'tiempo': return await handleTiempo(client, channel, username, userId, args[1]);
    case 'boss': return await handleBoss(client, channel, args, isMod, username);
    case 'score': return await handleScore(client, channel);
    case 'brb':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return handleBrb(client, channel, username);
    case 'silencio':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return handleSilencio(client, channel, username);
    case 'fua_callate':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return handleCallate(client, channel, username, args);
    case 'fua_modo':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return handleModo(client, channel, username, args);
    case 'juega':
      if (!isMod) { client.say(channel, `@${username} solo mods.`); return; }
      return handleJuega(client, channel, username, args);
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
    case 'lore':
      if (!isMod) { client.say(channel, truncate(loreMsgs.mods_only.replace('{username}', username))); return; }
      return await handleLore(client, channel, username, args);
    case 'fua_olvidame': return await require('../privacy/commands').handleForgetMe(client, channel, tags);
    case 'fua_olvidar': return await require('../privacy/commands').handleForgetUser(client, channel, tags, args, isMod);
    case 'privacidad': return require('../privacy/commands').handlePrivacy(client, channel, tags);
    case 'comandos': return handleComandos(client, channel, username, userId, isMod);
    case 'ayuda': return handleAyuda(client, channel, args, isMod);
    case 'moneda':
    case 'titulo':
    case 'loss':
    case 'metricas':
      client.say(channel, `@${username} ese comando ya no existe. Usa !comandos para ver los disponibles.`);
      return;
  }
}

// !juega pao|manu (solo mods): quién tiene el mando ahora; sin argumento, dice quién juega
function handleJuega(client, channel, username, args) {
  const arg = args.slice(1).join(' ').trim().toLowerCase();
  const label = () => ({ pao: 'Pao', ambos: 'Manu y Pao' }[getPlayer()] || 'Manu');
  const verb = () => (getPlayer() === 'ambos' ? 'juegan' : 'juega');
  if (!arg) { client.say(channel, `@${username} ahora ${verb()} ${label()}. Cambia con !juega pao | manu | ambos.`); return; }
  if (!setPlayer(arg)) { client.say(channel, `@${username} uso: !juega pao | manu | ambos.`); return; }
  persistBotState();
  client.say(channel, `🎮 Ahora ${verb()} ${label()}. ¡FUA!`);
}

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
  persistCooldown(key, now + 60000);
  client.say(channel, truncate(template('lurk', { username })));
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
  if (!g?.game) { client.say(channel, '🎮 Sin información del juego actual.'); return; }
  try {
    const line = formatJuegoLine(g.game, g.title, await getGameInfo(g.game));
    if (line) { client.say(channel, truncate(line)); return; }
  } catch {}
  client.say(channel, `🎮 ${g.game}${g.title ? ` — "${g.title}"` : ''}`);
}

async function handleEstadisticas(client, channel) {
  try {
    const [gameInfo, followers] = await Promise.all([
      getCurrentGame(),
      getFollowerCount(channelConfig.broadcaster_id)
    ]);
    const live = isLiveViaEventSub();
    const uptime = getStreamUptime();
    let viewers = null;
    if (live) viewers = await getViewersWithAppToken(channelConfig.broadcaster_id).catch(() => null);

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

const bossPlural = n => `${n} ${n === 1 ? 'jefe' : 'jefes'}`;

async function handleBoss(client, channel, args = [], isMod = false, username = '') {
  const cmd = parseBossArgs(args);
  if (['add', 'sub', 'reset'].includes(cmd.type) && !isMod) {
    client.say(channel, truncate(bossMsgs.mods_only.replace('{username}', username)));
    return;
  }
  const current = getBossCount();
  if (cmd.type === 'bad_format') { client.say(channel, truncate(bossMsgs.bad_format.replace('{max}', MAX_DEATHS_ADD))); return; }
  if (cmd.type === 'show') { client.say(channel, truncate(bossMsgs.show.replace('{total}', bossPlural(current)))); return; }
  if (cmd.type === 'game') {
    const rows = await getSessionsBossesByGame();
    const sid = getCurrentSessionId();
    const res = sumGameDeaths(cmd.game, rows, sid != null ? { id: sid, deaths: current } : null, 'boss_count');
    const reply = gameTotalReply(res);
    const game = reply.kind === 'total' ? sanitizeForAI(reply.game) : null;
    client.say(channel, truncate(game
      ? bossMsgs.total.replace('{game}', game).replace('{total}', bossPlural(res.total)).replace('{streams}', res.streams)
      : bossMsgs.bad_format.replace('{max}', MAX_DEATHS_ADD)));
    return;
  }
  if (cmd.type === 'reset') {
    resetBossCount(); saveSessionBosses(0); persistBotState();
    if (current > 0) incrementChannelStat('total_wins', -current).catch(() => {});
    client.say(channel, bossMsgs.reset);
    return;
  }
  const { wins, removed } = applyBossDelta(current, cmd);
  if (cmd.type === 'sub') {
    if (removed === 0) { client.say(channel, bossMsgs.none_to_remove); return; }
    setBossCount(wins); saveSessionBosses(wins); persistBotState();
    incrementChannelStat('total_wins', -removed).catch(() => {});
    client.say(channel, truncate(bossMsgs.corrected.replace('{total}', bossPlural(wins))));
    return;
  }
  setBossCount(wins); saveSessionBosses(wins); persistBotState();
  incrementChannelStat('total_wins', cmd.n).catch(() => {});
  addNarrativeEvent('boss', cmd.n === 1 ? `Jefe derrotado (#${wins} de este stream)` : `${cmd.n} jefes más derrotados (${wins} en este stream)`, cmd.n);
  client.say(channel, cmd.n === 1 ? `¡Boss eliminado! 💀 ${bossPlural(wins)} este stream` : truncate(bossMsgs.added.replace('{n}', cmd.n).replace('{total}', bossPlural(wins))));
}

async function handleScore(client, channel) {
  const stats = await getChannelStats().catch(() => null);
  const session = `💀 Bosses: ${getBossCount()} | Muertes: ${getDeathCount()}`;
  if (stats) {
    client.say(channel, `${session} | All-time: ${stats.total_wins} bosses`);
  } else {
    client.say(channel, session);
  }
}

async function handleMuertes(client, channel, args, isMod, username) {
  const cmd = parseMuertesArgs(args);
  if (cmd.type === 'add' || cmd.type === 'reset') {
    if (!isMod) { client.say(channel, truncate(muertesMsgs.mods_only.replace('{username}', username))); return; }
  }
  if (cmd.type === 'add') {
    let total = getDeathCount();
    for (let i = 0; i < cmd.n; i++) total = incrementDeathCount();
    saveSessionDeaths(total); persistBotState();
    addNarrativeEvent('death', cmd.n === 1 ? `Muerte #${total} del streamer en este stream` : `${cmd.n} muertes más del streamer (${total} en este stream)`, cmd.n);
    client.say(channel, cmd.n === 1 ? `💀 Muerte #${total} en este stream 😅` : truncate(muertesMsgs.added.replace('{n}', cmd.n).replace('{total}', total)));
  } else if (cmd.type === 'reset') {
    resetDeathCount(); saveSessionDeaths(0); persistBotState(); client.say(channel, `💀 Contador reseteado.`);
  } else if (cmd.type === 'bad_format') {
    client.say(channel, truncate(muertesMsgs.bad_format.replace('{max}', MAX_DEATHS_ADD)));
  } else if (cmd.type === 'game') {
    const rows = await getSessionsDeathsByGame();
    const sid = getCurrentSessionId();
    const res = sumGameDeaths(cmd.game, rows, sid != null ? { id: sid, deaths: getDeathCount() } : null);
    const reply = gameTotalReply(res);
    const game = reply.kind === 'total' ? sanitizeForAI(reply.game) : null;
    client.say(channel, truncate(game
      ? muertesMsgs.total.replace('{game}', game).replace('{total}', res.total).replace('{streams}', res.streams)
      : muertesMsgs.bad_format.replace('{max}', MAX_DEATHS_ADD)));
  } else {
    client.say(channel, `💀 Muertes hoy: ${getDeathCount()}`);
  }
}

async function handleTiempo(client, channel, username, userId, targetArg) {
  const key = `tiempo-${userId}`;
  const now = Date.now();
  if (cooldowns.has(key) && now < cooldowns.get(key)) return;
  cooldowns.set(key, now + 15 * 1000);

  const target = String(targetArg || '').replace(/^@/, '').trim() || username;
  if (!/^\w{1,25}$/.test(target)) return;
  const isSelf = target.toLowerCase() === username.toLowerCase();
  let user;
  try {
    user = findUserByName(await loadUsers(), target);
  } catch (err) {
    logger.warn(`!tiempo: ${err.message}`);
    client.say(channel, truncate(tiempoMsgs.unavailable));
    return;
  }
  const first = user?.firstSeen ? new Date(user.firstSeen).getTime() : NaN;
  if (!Number.isFinite(first)) {
    client.say(channel, truncate(tiempoMsgs.unknown.replace('{target}', target)));
    return;
  }
  const tpl = isSelf ? tiempoMsgs.self : tiempoMsgs.other;
  client.say(channel, truncate(tpl.replace('{username}', username).replace('{target}', user.username || target).replace('{since}', formatSince(first, now))));
}

function handleBrb(client, channel, username) {
  if (isBrb()) {
    const mins = getBrbDuration();
    setBrbMode(false, null, null);
    persistBotState();
    client.say(channel, `🔙 ¡@${username} ha vuelto después de ${mins} min! 🎉`);
  } else {
    setBrbMode(true, client, `#${process.env.CHANNEL}`);
    persistBotState();
    client.say(channel, `🚪 El streamer ha salido un momento. ¡Ahora vuelve! 👀`);
  }
}

function handleSilencio(client, channel, username) {
  const newState = !isSilenced();
  setSilenceMode(newState);
  persistBotState();
  client.say(channel, newState ? `🔇 Modo silencio activado por @${username}.` : `🔊 ¡De vuelta! ¡FUA! 💪`);
}

// !fua_callate <minutos>: silencio temporal que se levanta solo; 0 lo cancela
function handleCallate(client, channel, username, args) {
  const msgs = allMsgs.control;
  const minutes = parseMinutes(args[1]);
  if (minutes === null) { client.say(channel, truncate(msgs.callate_usage.replace('{username}', username).replace('{max}', MAX_MUTE_MIN))); return; }
  if (minutes === 0) {
    setMuteUntil(0);
    persistBotState();
    client.say(channel, truncate(msgs.callate_off));
    return;
  }
  const until = Date.now() + minutes * 60 * 1000;
  // El aviso sale antes de callar (origen 'comando': el silencio lo deja pasar)
  client.say(channel, truncate(msgs.callate_on.replace('{minutes}', minutes).replace('{username}', username).replace('{time}', clockMadrid(until))));
  setMuteUntil(until);
  persistBotState();
}

// !fua_modo reactivo|normal: en reactivo solo responde a menciones y comandos
function handleModo(client, channel, username, args) {
  const msgs = allMsgs.control;
  const mode = parseMode(args[1]);
  if (!mode) { client.say(channel, truncate(msgs.modo_usage.replace('{username}', username).replace('{current}', getBotMode()))); return; }
  setBotMode(mode);
  persistBotState();
  client.say(channel, truncate((mode === 'reactivo' ? msgs.modo_reactivo : msgs.modo_normal).replace('{username}', username)));
}

async function handleClip(client, channel) {
  if (!isLiveViaEventSub()) { client.say(channel, `❌ El canal no está en directo.`); return; }
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
  if (!isLiveViaEventSub()) { client.say(channel, '❌ El canal no está en directo.'); return; }
  const desc = args.slice(1).join(' ') || 'Momento marcado manualmente';
  try {
    const marker = await createStreamMarker(desc.slice(0, 140));
    if (marker) client.say(channel, '🏁 Marker creado ¡FUA!'); // sin repetir el texto del mod
    else client.say(channel, '❌ No se pudo crear el marker. Revisa scope user:edit:broadcast.');
  } catch (err) {
    logger.error(`!marker: ${err.message}`);
    client.say(channel, '❌ Error al crear el marker.');
  }
}

async function handleResumen(client, channel) {
  try {
    const s = getSummary();
    const uptime = getStreamUptime() || s.uptime;
    const gameInfo = await getCurrentGame().catch(() => null);
    const game = gameInfo?.game ? `🎮 ${gameInfo.game}` : '';
    const parts = [`📊 ${uptime}`, `💬 ${s.messagesLastHour} msg/h`, game].filter(Boolean);
    client.say(channel, parts.join(' | '));
  } catch (err) {
    logger.error(`!resumen: ${err.message}`);
    client.say(channel, 'No pude generar el resumen.');
  }
}

async function handleLore(client, channel, username, args) {
  const say = text => client.say(channel, truncate(text));
  const sub = args[1]?.toLowerCase();
  try {
    if (!sub) {
      const { active, pending } = await getLoreOverview();
      if (!active.length && !pending.length) return say(loreMsgs.empty);
      const parts = [];
      if (active.length) parts.push(loreMsgs.active_prefix + active.join(' | '));
      if (pending.length) parts.push(loreMsgs.pending_prefix + pending.join(' | '));
      return say(parts.join('  '));
    }
    if (sub !== 'aprobar' && sub !== 'borrar') return say(loreMsgs.usage.replace('{username}', username));
    const id = parseInt(args[2], 10);
    if (!Number.isInteger(id) || id < 1) return say(loreMsgs.usage.replace('{username}', username));
    const row = sub === 'aprobar' ? await approveLore(id, username) : await deleteLore(id);
    if (!row) return say(loreMsgs.not_found.replace('{username}', username).replace('{id}', id));
    const tpl = sub === 'aprobar' ? loreMsgs.approved : loreMsgs.deleted;
    return say(tpl.replace('{id}', id).replace('{term}', sanitizeForAI(row.term) || '?'));
  } catch (err) {
    logger.error(`!lore: ${err.message}`);
    return say(loreMsgs.error.replace('{username}', username));
  }
}

function handleComandos(client, channel, username, userId, isMod) {
  const key = `comandos-${userId}`;
  const now = Date.now();
  if (cooldowns.has(key) && now < cooldowns.get(key)) {
    client.say(channel, `@${username} espera ${Math.ceil((cooldowns.get(key) - now) / 1000)}s.`);
    return;
  }
  cooldowns.set(key, now + 10 * 1000);
  client.say(channel, truncate(buildCommandList(isMod)));
}

function handleAyuda(client, channel, args, isMod) {
  const sub = args[1]?.toLowerCase();
  const text = getHelpText(sub, isMod);
  if (text) client.say(channel, truncate(`❓ !${sub}: ${text}`));
  else client.say(channel, truncate(`❓ ${buildCommandList(isMod).replace('📋 ', '')} | !ayuda [cmd] para más info`));
}

function restoreCooldowns(data) {
  const now = Date.now();
  for (const [key, expiresAt] of Object.entries(data)) {
    if (expiresAt > now && key.startsWith('lurk-')) cooldowns.set(key, expiresAt);
  }
}

module.exports = { handle, handleJuega, resetSessionCounters, restoreCooldowns };
