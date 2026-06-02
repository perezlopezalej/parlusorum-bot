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
    const { data, error } = await db.from('users').select('*');
    if (error) throw error;

    // Convertir array a objeto keyed por user_id (compatible con el código existente)
    usersCache = {};
    for (const row of data || []) {
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

async function saveTokens({ broadcaster_token, broadcaster_refresh_token }) {
  const db = getClient();
  if (!db) return;
  try {
    const { error } = await db.from('channel_config').upsert({
      id: 'broadcaster',
      broadcaster_token,
      broadcaster_refresh_token,
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
      .select('broadcaster_token, broadcaster_refresh_token')
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

module.exports = {
  getClient,
  loadUsers,
  saveUsers,
  saveUser,
  startStreamSession,
  endStreamSession,
  getCurrentSessionId,
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
};
