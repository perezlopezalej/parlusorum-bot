// Almacenamiento persistente via npoint.io
const logger = require('./logger');

const NPOINT_ID = process.env.NPOINT_BIN_ID;
const BASE_URL = `https://api.npoint.io/${NPOINT_ID}`;

// Cache agresiva — solo carga una vez, guarda con debounce
let cache = null;
let dirty = false;
let saveTimer = null;
let loading = false;
let loadPromise = null;

async function loadUsers() {
  // Si ya tenemos cache, devolverla (evita requests innecesarios a npoint)
  if (cache !== null) return cache;

  // Evitar cargas simultáneas (race condition fix)
  if (loading) return loadPromise;

  if (!NPOINT_ID) {
    logger.warn('⚠️ NPOINT_BIN_ID no configurado, usando memoria local.');
    cache = {};
    return cache;
  }

  loading = true;
  loadPromise = (async () => {
    try {
      const res = await fetch(BASE_URL);
      const data = await res.json();
      // Validar que sea un objeto (no array ni null)
      cache = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
      logger.info(`✅ Usuarios cargados desde npoint (${Object.keys(cache).length} usuarios)`);
    } catch (e) {
      logger.error(`Error cargando usuarios desde npoint: ${e.message}`);
      cache = {};
    }
    loading = false;
    return cache;
  })();

  return loadPromise;
}

// Guardar con debounce de 5 segundos — evita saturar npoint
function saveUsers(data) {
  cache = data;
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    if (!dirty || !NPOINT_ID) { saveTimer = null; return; }
    try {
      await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cache)
      });
      dirty = false;
      logger.debug('💾 Usuarios guardados en npoint');
    } catch (e) {
      logger.error(`Error guardando usuarios en npoint: ${e.message}`);
    }
    saveTimer = null;
  }, 5000);
}

module.exports = { loadUsers, saveUsers };
