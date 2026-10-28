/**
 * supabase.js — Cliente y operaciones de base de datos
 * Reemplaza npoint.io para usuarios y añade memoria de streams
 */

const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CHANNEL_NAME = process.env.CHANNEL || 'parlusorum';

if (SUPABASE_URL) logger.info('💾 Supabase configurado');

let supabase = null;

function getClient() {
  if (!supabase) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      logger.warn('⚠️ SUPABASE_URL o SUPABASE_KEY no configurados.');
      return null;
    }
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      db: { schema: 'public' }
    });
  }
  return supabase;
}

// ─── USUARIOS ────────────────────────────────────────────────────────────────

// Cache local para no hacer queries en cada mensaje
let usersCache = null;
let cacheLastLoaded = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

async function loadUsers() {
  // Cache vigente
  if (usersCache && Date.now() - cacheLastLoaded < CACHE_TTL) return usersCache;

  const db = getClient();
  if (!db) { usersCache = usersCache || {}; return usersCache; }

  try {
    // Supabase corta en 1000 filas por petición: paginar con range()
    const PAGE = 1000;
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db.from('users').select('*').order('user_id').range(from, from + PAGE - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }

    // Convertir array a objeto keyed por user_id (compatible con el código existente)
    usersCache = {};
    for (const row of rows) {
      usersCache[row.user_id] = {
        username: row.username,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        messageCount: row.message_count,
        achievements: row.achievements || []
      };
    }
    cacheLastLoaded = Date.now();
    logger.info(`✅ Usuarios cargados desde Supabase (${Object.keys(usersCache).length})`);
    return usersCache;
  } catch (e) {
    logger.error(`Error cargando usuarios desde Supabase: ${e.message}`);
    return usersCache || {};
  }
}

// Debounce para no saturar Supabase con cada mensaje
const pendingSaves = new Map();

async function saveUser(userId, userData) {
  // Actualizar cache inmediatamente
  if (usersCache) usersCache[userId] = userData;

  // Debounce por usuario — 3 segundos
  if (pendingSaves.has(userId)) clearTimeout(pendingSaves.get(userId));
  pendingSaves.set(userId, setTimeout(async () => {
    pendingSaves.delete(userId);
    const db = getClient();
    if (!db) return;

    try {
      const { error } = await db.from('users').upsert({
        user_id: userId,
        username: userData.username,
        first_seen: userData.firstSeen,
        last_seen: userData.lastSeen,
        message_count: userData.messageCount || 0,
        achievements: userData.achievements || []
      }, { onConflict: 'user_id' });

      if (error) throw error;
    } catch (e) {
      logger.error(`Error guardando usuario ${userId}: ${e.message}`);
    }
  }, 3000));
}

// Compatibilidad con el sistema antiguo — saveUsers recibe el objeto completo
async function saveUsers(data) {
  usersCache = data;
  // Guardar todos los usuarios modificados
  for (const [userId, userData] of Object.entries(data)) {
    await saveUser(userId, userData);
  }
}

// ─── SESIONES DE STREAM ───────────────────────────────────────────────────────

let currentSessionId = null;

async function startStreamSession(game) {
  const db = getClient();
  if (!db) return null;

  try {
    const { data, error } = await db.from('stream_sessions').insert({
      started_at: new Date().toISOString(),
      game: game || null
    }).select().single();

    if (error) throw error;
    currentSessionId = data.id;
    logger.info(`📺 Sesión de stream iniciada: ID ${currentSessionId}`);
    return currentSessionId;
  } catch (e) {
    logger.error(`Error iniciando sesión: ${e.message}`);
    return null;
  }
}

async function endStreamSession(stats) {
  const db = getClient();
  if (!db || !currentSessionId) return;

  try {
    const { error } = await db.from('stream_sessions').update({
      ended_at: new Date().toISOString(),
      duration_minutes: stats.durationMinutes || 0,
      game: stats.game || null,
      peak_viewers: stats.peakViewers || 0,
      total_messages: stats.totalMessages || 0,
      death_count: stats.deathCount || 0,
      top_commands: stats.topCommands || {}
    }).eq('id', currentSessionId);

    if (error) throw error;
    logger.info(`📺 Sesión de stream cerrada: ID ${currentSessionId}`);
  } catch (e) {
    logger.error(`Error cerrando sesión: ${e.message}`);
  }
}

function getCurrentSessionId() { return currentSessionId; }

// ─── MUERTES DE LA SESIÓN ─────────────────────────────────────────────────────
// Usa stream_sessions.death_count (ya existe): se escribe con retardo y se lee al arrancar.

const DEATHS_SAVE_DELAY_MS = 3000;
const SESSION_MATCH_TOLERANCE_MS = 10 * 60 * 1000;
let _deathsTimer = null;

function saveSessionDeaths(count) {
  clearTimeout(_deathsTimer);
  _deathsTimer = setTimeout(async () => {
    const db = getClient();
    if (!db || !currentSessionId) return;
    try {
      const { error } = await db.from('stream_sessions').update({ death_count: count }).eq('id', currentSessionId);
      if (error) throw error;
    } catch (e) {
      logger.warn(`Muertes no persistidas: ${e.message}`);
    }
  }, DEATHS_SAVE_DELAY_MS);
  _deathsTimer.unref?.();
}

// Sesión abierta (sin ended_at) más reciente que empezó con el stream en curso
function pickOpenSession(rows, streamStartedAtMs) {
  if (!Number.isFinite(streamStartedAtMs)) return null;
  return (rows || [])
    .filter(r => !r.ended_at && new Date(r.started_at).getTime() >= streamStartedAtMs - SESSION_MATCH_TOLERANCE_MS)
    .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))[0] || null;
}

// Al arrancar con el stream en directo: recupera la sesión abierta y devuelve sus muertes (o null)
async function restoreOpenSession(streamStartedAtMs) {
  const db = getClient();
  if (!db) return null;
  try {
    const { data, error } = await db.from('stream_sessions')
      .select('id, started_at, ended_at, death_count')
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(5);
    if (error) throw error;
    const row = pickOpenSession(data, streamStartedAtMs);
    if (!row) return null;
    currentSessionId = row.id;
    logger.info(`📺 Sesión de stream recuperada: ID ${row.id} (${row.death_count || 0} muertes)`);
    return row.death_count || 0;
  } catch (e) {
    logger.warn(`Sesión abierta no recuperada: ${e.message}`);
    return null;
  }
}

// ─── NARRATIVA DE LA SESIÓN ───────────────────────────────────────────────────
// Columna stream_sessions.narrative (jsonb). Misma escritura diferida que las muertes.

const NARRATIVE_SAVE_DELAY_MS = 3000;
let _narrativeTimer = null;
let _narrativeWarned = false;

function saveSessionNarrative(events) {
  clearTimeout(_narrativeTimer);
  _narrativeTimer = setTimeout(async () => {
    const db = getClient();
    if (!db || !currentSessionId) return;
    try {
      const { error } = await db.from('stream_sessions').update({ narrative: events }).eq('id', currentSessionId);
      if (error) throw error;
    } catch (e) {
      if (!_narrativeWarned) { _narrativeWarned = true; logger.warn(`Narrativa no persistida (¿falta la columna narrative?): ${e.message}`); }
    }
  }, NARRATIVE_SAVE_DELAY_MS);
  _narrativeTimer.unref?.();
}

// Tras restoreOpenSession(): lee la narrativa de la sesión recuperada ([] si no hay)
async function restoreSessionNarrative() {
  const db = getClient();
  if (!db || !currentSessionId) return [];
  try {
    const { data, error } = await db.from('stream_sessions').select('narrative').eq('id', currentSessionId).single();
    if (error) throw error;
    return Array.isArray(data?.narrative) ? data.narrative : [];
  } catch (e) {
    logger.warn(`Narrativa no recuperada: ${e.message}`);
    return [];
  }
}

// ─── PROFECÍA DE LA SESIÓN ────────────────────────────────────────────────────
// Columna stream_sessions.prophecy (jsonb): sobrevive a reinicios para compararla al acabar el stream.

let _prophecyWarned = false;

async function saveSessionProphecy(prophecy) {
  const db = getClient();
  if (!db || !currentSessionId) return false;
  try {
    const { error } = await db.from('stream_sessions').update({ prophecy }).eq('id', currentSessionId);
    if (error) throw error;
    return true;
  } catch (e) {
    if (!_prophecyWarned) { _prophecyWarned = true; logger.warn(`Profecía no persistida (¿falta la columna prophecy?): ${e.message}`); }
    return false;
  }
}

// Tras restoreOpenSession(): profecía de la sesión recuperada (o null)
async function restoreSessionProphecy() {
  const db = getClient();
  if (!db || !currentSessionId) return null;
  try {
    const { data, error } = await db.from('stream_sessions').select('prophecy').eq('id', currentSessionId).single();
    if (error) throw error;
    const p = data?.prophecy;
    return p && Number.isFinite(p.deaths) ? p : null;
  } catch (e) {
    logger.warn(`Profecía no recuperada: ${e.message}`);
    return null;
  }
}

// Juego y muertes de todas las sesiones con muertes anotadas (base de !muertes <juego>)
async function getSessionsDeathsByGame() {
  const db = getClient();
  if (!db) return [];
  try {
    const { data, error } = await db.from('stream_sessions')
      .select('id, game, death_count')
      .not('game', 'is', null)
      .gt('death_count', 0)
      .limit(1000);
    if (error) throw error;
    return data || [];
  } catch (e) {
    logger.error(`Error obteniendo muertes por juego: ${e.message}`);
    return [];
  }
}

// Muertes y juego de las últimas sesiones cerradas (base de la profecía)
async function getRecentSessionDeaths(limit = 10) {
  const db = getClient();
  if (!db) return [];

  try {
    const { data, error } = await db
      .from('stream_sessions')
      .select('game, death_count')
      .not('ended_at', 'is', null)
      .order('started_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  } catch (e) {
    logger.error(`Error obteniendo muertes previas: ${e.message}`);
    return [];
  }
}

// ─── MEMORIA DEL CANAL ────────────────────────────────────────────────────────

async function saveStreamMemory(memoryData) {
  const db = getClient();
  if (!db) return;

  try {
    const { error } = await db.from('stream_memory').insert({
      session_id: currentSessionId,
      stream_date: new Date().toISOString().split('T')[0],
      game: memoryData.game || null,
      summary: memoryData.summary || null,
      highlights: memoryData.highlights || [],
      recurring_phrases: memoryData.recurringPhrases || [],
      active_users: memoryData.activeUsers || []
    });

    if (error) throw error;
    logger.info(`🧠 Memoria del stream guardada`);
  } catch (e) {
    logger.error(`Error guardando memoria: ${e.message}`);
  }
}

// Obtener los últimos N streams para inyectar en el prompt de la IA
async function getRecentStreamMemory(limit = 5) {
  const db = getClient();
  if (!db) return [];

  try {
    const { data, error } = await db
      .from('stream_memory')
      .select('*')
      .order('stream_date', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  } catch (e) {
    logger.error(`Error obteniendo memoria: ${e.message}`);
    return [];
  }
}

// ─── HIGHLIGHTS ───────────────────────────────────────────────────────────────

async function saveHighlight(triggerMessages, markerId, description) {
  const db = getClient();
  if (!db) return null;

  try {
    const { error } = await db.from('stream_highlights').insert({
      session_id: currentSessionId,
      trigger_messages: triggerMessages || [],
      marker_id: markerId || null,
      description: description || null
    });
    return { error: error || null };
  } catch (e) {
    return { error: e };
  }
}

// ─── ESTADÍSTICAS DEL CANAL ──────────────────────────────────────────────────

let channelStatsCache = null;

async function getChannelStats() {
  const db = getClient();
  if (!db) return null;
  try {
    const { data, error } = await db.from('channel_stats').select('*').eq('id', 1).single();
    if (error) throw error;
    channelStatsCache = data;
    return data;
  } catch (e) {
    logger.error(`Error obteniendo channel_stats: ${e.message}`);
    return channelStatsCache;
  }
}

async function incrementChannelStat(field) {
  const db = getClient();
  if (!db) return;
  try {
    const current = channelStatsCache || await getChannelStats() || { total_wins: 0, total_losses: 0 };
    const updated = {
      id: 1,
      total_wins: current.total_wins || 0,
      total_losses: current.total_losses || 0,
      updated_at: new Date().toISOString()
    };
    updated[field] = (updated[field] || 0) + 1;
    channelStatsCache = { ...updated };
    const { error } = await db.from('channel_stats').upsert(updated, { onConflict: 'id' });
    if (error) throw error;
  } catch (e) {
    logger.error(`Error incrementando ${field}: ${e.message}`);
  }
}

// ─── TOKENS ──────────────────────────────────────────────────────────────────

// Los campos undefined no se serializan, así que el upsert solo toca las columnas recibidas.
async function saveTokens({ broadcaster_token, broadcaster_refresh_token, bot_token, bot_refresh_token }) {
  const db = getClient();
  if (!db) return;
  try {
    const { error } = await db.from('channel_config').upsert({
      id: 'broadcaster',
      broadcaster_token,
      broadcaster_refresh_token,
      bot_token,
      bot_refresh_token,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });
    if (error) throw error;
    logger.info('💾 Tokens persistidos en Supabase');
  } catch (e) {
    logger.error(`Error guardando tokens: ${e.message}`);
  }
}

async function loadTokens() {
  const db = getClient();
  if (!db) return null;
  try {
    const { data, error } = await db
      .from('channel_config')
      .select('broadcaster_token, broadcaster_refresh_token, bot_token, bot_refresh_token')
      .eq('id', 'broadcaster')
      .single();
    if (error) return null;
    return data;
  } catch (e) {
    logger.error(`Error cargando tokens: ${e.message}`);
    return null;
  }
}

// ─── MIGRACIÓN DESDE NPOINT ───────────────────────────────────────────────────

/**
 * Si hay datos en npoint.io y Supabase está vacío, migra automáticamente.
 * Se ejecuta una sola vez al arrancar.
 */
async function migrateFromNpoint() {
  const NPOINT_ID = process.env.NPOINT_BIN_ID;
  if (!NPOINT_ID) return;

  const db = getClient();
  if (!db) return;

  try {
    // Comprobar si ya hay usuarios en Supabase
    const { count, error: countError } = await db
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (countError) throw countError;
    if (count > 0) {
      logger.info(`💾 Supabase ya tiene ${count} usuarios. Migracion no necesaria.`);
      return;
    }

    // Cargar desde npoint
    logger.info('🔄 Migrando usuarios desde npoint.io a Supabase...');
    const res = await fetch(`https://api.npoint.io/${NPOINT_ID}`);
    const data = await res.json();

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      logger.warn('npoint vacio o formato invalido, nada que migrar.');
      return;
    }

    const rows = Object.entries(data).map(([userId, userData]) => ({
      user_id: userId,
      username: userData.username || 'unknown',
      first_seen: userData.firstSeen || new Date().toISOString(),
      last_seen: userData.lastSeen || new Date().toISOString(),
      message_count: userData.messageCount || 0,
      achievements: userData.achievements || []
    }));

    if (rows.length === 0) return;

    const { error } = await db.from('users').insert(rows);
    if (error) throw error;

    logger.info(`✅ Migracion completada: ${rows.length} usuarios movidos a Supabase`);
    // Invalidar cache para que se carguen desde Supabase
    usersCache = null;
    cacheLastLoaded = 0;
  } catch (e) {
    logger.error(`Error en migracion npoint→Supabase: ${e.message}`);
  }
}

// ─── COOLDOWNS PERSISTENTES ───────────────────────────────────────────────────

async function loadActiveCooldowns() {
  const db = getClient();
  if (!db) return {};
  try {
    const { data, error } = await db
      .from('cooldowns')
      .select('key, expires_at')
      .gt('expires_at', new Date().toISOString());
    if (error) throw error;
    const result = {};
    for (const row of data || []) {
      result[row.key] = new Date(row.expires_at).getTime();
    }
    return result;
  } catch (e) {
    logger.error(`loadActiveCooldowns: ${e.message}`);
    return {};
  }
}

function persistCooldown(key, expiresAt) {
  const db = getClient();
  if (!db) return;
  db.from('cooldowns')
    .upsert({ key, expires_at: new Date(expiresAt).toISOString() }, { onConflict: 'key' })
    .then(({ error }) => { if (error) logger.warn(`persistCooldown ${key}: ${error.message}`); })
    .catch(() => {});
}

function deleteCooldown(key) {
  const db = getClient();
  if (!db) return;
  db.from('cooldowns')
    .delete()
    .eq('key', key)
    .then(({ error }) => { if (error) logger.warn(`deleteCooldown ${key}: ${error.message}`); })
    .catch(() => {});
}

// ─── MEMORIA FACTUAL DE USUARIOS ─────────────────────────────────────────────

function saveUserFact(username, factType, value) {
  const db = getClient();
  if (!db) return;
  db.from('user_facts').upsert({
    username: username.toLowerCase(),
    channel: CHANNEL_NAME,
    fact_type: factType,
    value: String(value),
    updated_at: new Date().toISOString()
  }, { onConflict: 'username,channel,fact_type' })
    .then(({ error }) => { if (error) logger.warn(`saveUserFact ${username}/${factType}: ${error.message}`); })
    .catch(() => {});
}

async function getUserFacts(username) {
  const db = getClient();
  if (!db) return [];
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from('user_facts')
      .select('fact_type, value')
      .eq('username', username.toLowerCase())
      .eq('channel', CHANNEL_NAME)
      .gte('updated_at', cutoff);
    if (error) throw error;
    return data || [];
  } catch (e) {
    logger.error(`getUserFacts ${username}: ${e.message}`);
    return [];
  }
}

// Contador acumulado (sin caducidad) en user_facts. Devuelve el nuevo total o null sin Supabase/error.
// Lectura+escritura sin atomicidad: seguro porque solo hay una trivia activa a la vez.
async function incrementUserCounter(username, factType) {
  const db = getClient();
  if (!db) return null;
  try {
    const user = username.toLowerCase();
    const { data, error } = await db.from('user_facts').select('value')
      .eq('username', user).eq('channel', CHANNEL_NAME).eq('fact_type', factType).maybeSingle();
    if (error) throw error;
    const next = (parseInt(data?.value, 10) || 0) + 1;
    const { error: upErr } = await db.from('user_facts').upsert({
      username: user,
      channel: CHANNEL_NAME,
      fact_type: factType,
      value: String(next),
      updated_at: new Date().toISOString()
    }, { onConflict: 'username,channel,fact_type' });
    if (upErr) throw upErr;
    return next;
  } catch (e) {
    logger.warn(`incrementUserCounter ${username}/${factType}: ${e.message}`);
    return null;
  }
}

// Lee un contador acumulado sin la caducidad de 30 días de getUserFacts. 0 sin Supabase/error.
async function getUserCounter(username, factType) {
  const db = getClient();
  if (!db) return 0;
  try {
    const { data, error } = await db.from('user_facts').select('value')
      .eq('username', username.toLowerCase()).eq('channel', CHANNEL_NAME).eq('fact_type', factType).maybeSingle();
    if (error) throw error;
    return parseInt(data?.value, 10) || 0;
  } catch (e) {
    logger.warn(`getUserCounter ${username}/${factType}: ${e.message}`);
    return 0;
  }
}

// Top N por contador (value es texto: se ordena en JS). [{ username, count }]
async function getCounterLeaderboard(factType, limit) {
  const db = getClient();
  if (!db) return [];
  try {
    const { data, error } = await db.from('user_facts').select('username, value')
      .eq('channel', CHANNEL_NAME).eq('fact_type', factType);
    if (error) throw error;
    return (data || [])
      .map(r => ({ username: r.username, count: parseInt(r.value, 10) || 0 }))
      .filter(r => r.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  } catch (e) {
    logger.warn(`getCounterLeaderboard ${factType}: ${e.message}`);
    return [];
  }
}

// ─── LORE APRENDIDO ──────────────────────────────────────────────────────────

async function getLoreRows(statuses) {
  const db = getClient();
  if (!db) return [];
  try {
    let q = db.from('channel_lore').select('*').eq('channel', CHANNEL_NAME);
    if (statuses?.length) q = q.in('status', statuses);
    const { data, error } = await q.order('id', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (e) {
    logger.error(`getLoreRows: ${e.message}`);
    return [];
  }
}

// rows sin id: el conflicto (channel, term_key) decide si inserta o actualiza
async function upsertLoreRows(rows) {
  const db = getClient();
  if (!db || !rows.length) return false;
  try {
    const { error } = await db.from('channel_lore')
      .upsert(rows.map(r => ({ ...r, channel: CHANNEL_NAME })), { onConflict: 'channel,term_key' });
    if (error) throw error;
    return true;
  } catch (e) {
    logger.error(`upsertLoreRows: ${e.message}`);
    return false;
  }
}

// Devuelve la fila actualizada, null si no existe o no estaba en un estado permitido
async function updateLoreStatus(id, status, fromStatuses) {
  const db = getClient();
  if (!db) return null;
  const patch = { status };
  if (status === 'active') { patch.missed_streams = 0; patch.needs_approval = false; }
  const { data, error } = await db.from('channel_lore')
    .update(patch)
    .eq('id', id).eq('channel', CHANNEL_NAME).in('status', fromStatuses)
    .select().maybeSingle();
  if (error) throw error;
  return data;
}

// ─── REGISTRO DE CHAT ─────────────────────────────────────────────────────────
// Lanzan si falla: chatlog.js decide qué hacer (reencolar, avisar); nunca llegan al bot.

async function insertChatLog(rows) {
  const db = getClient();
  if (!db) throw new Error('Supabase no configurado');
  const { error } = await db.from('chat_log').insert(rows);
  if (error) throw error;
}

// Devuelve cuántas filas borró
async function deleteChatLogBefore(isoDate) {
  const db = getClient();
  if (!db) return 0;
  const { error, count } = await db.from('chat_log').delete({ count: 'exact' }).lt('created_at', isoDate);
  if (error) throw error;
  return count || 0;
}

module.exports = {
  insertChatLog,
  deleteChatLogBefore,
  getLoreRows,
  upsertLoreRows,
  updateLoreStatus,
  getClient,
  loadUsers,
  saveUsers,
  saveUser,
  startStreamSession,
  endStreamSession,
  getCurrentSessionId,
  saveSessionDeaths,
  restoreOpenSession,
  saveSessionNarrative,
  restoreSessionNarrative,
  saveSessionProphecy,
  restoreSessionProphecy,
  getSessionsDeathsByGame,
  pickOpenSession,
  getRecentSessionDeaths,
  saveStreamMemory,
  getRecentStreamMemory,
  saveHighlight,
  migrateFromNpoint,
  getChannelStats,
  incrementChannelStat,
  saveTokens,
  loadTokens,
  loadActiveCooldowns,
  persistCooldown,
  deleteCooldown,
  saveUserFact,
  getUserFacts,
  incrementUserCounter,
  getUserCounter,
  getCounterLeaderboard,
};
