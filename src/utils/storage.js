/**
 * storage.js — Capa de almacenamiento
 * Usa Supabase si está configurado, npoint.io como fallback.
 */

const logger = require('./logger');

const USE_SUPABASE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
let supabaseStorage = null;
function getSupabase() {
  if (!supabaseStorage) supabaseStorage = require('./supabase');
  return supabaseStorage;
}

// ─── NPOINT FALLBACK ──────────────────────────────────────────────────────────
const NPOINT_ID = process.env.NPOINT_BIN_ID;
const BASE_URL = `https://api.npoint.io/${NPOINT_ID}`;
let nCache = null;
let nDirty = false;
let nSaveTimer = null;
let nLoading = false;
let nLoadPromise = null;

async function nLoadUsers() {
  if (nCache !== null) return nCache;
  if (nLoading) return nLoadPromise;
  if (!NPOINT_ID) { nCache = {}; return nCache; }
  nLoading = true;
  nLoadPromise = (async () => {
    try {
      const res = await fetch(BASE_URL);
      const data = await res.json();
      nCache = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
      logger.info(`✅ Usuarios cargados desde npoint (${Object.keys(nCache).length})`);
    } catch (e) {
      logger.error(`Error npoint load: ${e.message}`);
      nCache = {};
    }
    nLoading = false;
    return nCache;
  })();
  return nLoadPromise;
}

function nSaveUsers(data) {
  nCache = data;
  nDirty = true;
  if (nSaveTimer) return;
  nSaveTimer = setTimeout(async () => {
    if (!nDirty || !NPOINT_ID) { nSaveTimer = null; return; }
    try {
      await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nCache)
      });
      nDirty = false;
    } catch (e) {
      logger.error(`Error npoint save: ${e.message}`);
    }
    nSaveTimer = null;
  }, 5000);
}

// ─── API PÚBLICA ──────────────────────────────────────────────────────────────
async function loadUsers() {
  if (USE_SUPABASE) return getSupabase().loadUsers();
  return nLoadUsers();
}

async function saveUsers(data) {
  if (USE_SUPABASE) return getSupabase().saveUsers(data);
  return nSaveUsers(data);
}

async function saveUser(userId, userData) {
  if (USE_SUPABASE) return getSupabase().saveUser(userId, userData);
  const users = await nLoadUsers();
  users[userId] = userData;
  return nSaveUsers(users);
}

if (USE_SUPABASE) {
  logger.info('💾 Storage: Supabase');
} else {
  logger.info('💾 Storage: npoint.io (fallback)');
}

async function saveHighlight(triggerMessages, markerId, description) {
  if (USE_SUPABASE) {
    const result = await getSupabase().saveHighlight(triggerMessages, markerId, description);
    if (result?.error) {
      logger.warn(`saveHighlight error: ${result.error.message}`);
    }
    return result;
  }
}

module.exports = { loadUsers, saveUsers, saveUser, saveHighlight };
