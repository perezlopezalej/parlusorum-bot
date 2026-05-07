// Almacenamiento persistente via npoint.io
// Sustituye al sistema de archivos local que no persiste en Render

const logger = require('./logger');

const NPOINT_ID = process.env.NPOINT_BIN_ID;
const BASE_URL = `https://api.npoint.io/${NPOINT_ID}`;

let cache = null;
let dirty = false;
let saveTimer = null;

// Cargar datos desde npoint
async function loadUsers() {
  if (cache) return cache;
  if (!NPOINT_ID) {
    logger.warn('⚠️ NPOINT_BIN_ID no configurado, usando memoria local.');
    cache = {};
    return cache;
  }
  try {
    const res = await fetch(BASE_URL);
    const data = await res.json();
    cache = data || {};
    logger.info(`✅ Usuarios cargados desde npoint (${Object.keys(cache).length} usuarios)`);
    return cache;
  } catch (e) {
    logger.error(`Error cargando usuarios desde npoint: ${e.message}`);
    cache = {};
    return cache;
  }
}

// Guardar datos en npoint (con debounce de 5 segundos)
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
