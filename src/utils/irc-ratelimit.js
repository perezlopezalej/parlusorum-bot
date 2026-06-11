const logger = require('./logger');

// Límites oficiales Twitch IRC:
// - Cuenta normal: 20 msgs / 30 s → usamos 18 como margen
// - Límite secundario: 1 mensaje / segundo → usamos 1100 ms
// - Moderador: 100 msgs / 30 s (no aplicable aquí — el bot no es mod)
const WINDOW_MS   = 30_000;
const MAX_IN_WIN  = 18;
const MIN_GAP_MS  = 1_100;
const MAX_QUEUE   = 50;

const _window = [];   // timestamps de mensajes enviados (sliding window)
const _queue  = [];   // { sayFn, channel, msg } pendientes
let   _timer  = null; // handle del próximo drain programado

function _scheduleDrain(delayMs) {
  if (_timer !== null) return; // ya hay un drain programado
  _timer = setTimeout(_drain, delayMs);
}

async function _drain() {
  _timer = null;
  if (_queue.length === 0) return;

  const now = Date.now();

  // Limpiar timestamps fuera de la ventana de 30 s
  while (_window.length && _window[0] < now - WINDOW_MS) _window.shift();

  // ¿Ventana llena? Esperar hasta que expire el timestamp más antiguo
  if (_window.length >= MAX_IN_WIN) {
    _scheduleDrain(WINDOW_MS - (now - _window[0]) + 10);
    return;
  }

  // ¿Muy poco tiempo desde el último mensaje? Esperar el gap mínimo
  const last = _window.at(-1) ?? 0;
  const gap  = now - last;
  if (gap < MIN_GAP_MS) {
    _scheduleDrain(MIN_GAP_MS - gap + 10);
    return;
  }

  // Enviar siguiente mensaje de la cola
  const { sayFn, channel, msg, client } = _queue.shift();
  if (client && client.readyState() !== 'OPEN') {
    logger.warn('IRC: mensaje descartado — cliente no conectado');
    if (_queue.length > 0) _scheduleDrain(MIN_GAP_MS);
    return;
  }
  _window.push(Date.now());
  try {
    await sayFn(channel, msg);
  } catch (e) {
    logger.warn(`IRC say error: ${e.message}`);
  }

  if (_queue.length > 0) _scheduleDrain(MIN_GAP_MS);
}

/**
 * Reemplaza client.say() por una versión throttled.
 * Debe llamarse una sola vez, justo después de crear el cliente tmi.js,
 * antes de connect(). Todos los módulos que ya usan client.say() quedan
 * cubiertos automáticamente sin cambios.
 */
function wrapClientSay(client) {
  const _say = client.say.bind(client);
  client.say = (channel, msg) => {
    if (_queue.length >= MAX_QUEUE) {
      logger.warn(`IRC queue llena (${MAX_QUEUE}), mensaje descartado: "${String(msg).slice(0, 60)}"`);
      return;
    }
    _queue.push({ sayFn: _say, channel, msg, client });
    _scheduleDrain(0);
  };
}

function _logQueueOnExit(signal) {
  if (_queue.length > 0) {
    const items = _queue
      .map(({ channel, msg }) => `${channel}: "${String(msg).slice(0, 60)}"`)
      .join(' | ');
    logger.warn(`IRC: ${signal} — ${_queue.length} msg(s) en cola descartados: ${items}`);
  }
  process.exit(0);
}

process.on('SIGTERM', () => _logQueueOnExit('SIGTERM'));
process.on('SIGINT',  () => _logQueueOnExit('SIGINT'));

module.exports = { wrapClientSay };
