const logger = require('./logger');
const chatlog = require('./chatlog');

const BOT_NAME = process.env.BOT_USERNAME || 'bot';

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
let   _closing = false; // apagado en curso: no se programan más drains

function _scheduleDrain(delayMs) {
  if (_timer !== null || _closing) return; // ya hay un drain programado, o apagando
  _timer = setTimeout(_drain, delayMs);
}

// ms que hay que esperar antes de poder enviar el siguiente mensaje (0 = ya se puede)
function _waitMs(now) {
  // Limpiar timestamps fuera de la ventana de 30 s
  while (_window.length && _window[0] < now - WINDOW_MS) _window.shift();

  // ¿Ventana llena? Esperar hasta que expire el timestamp más antiguo
  if (_window.length >= MAX_IN_WIN) return WINDOW_MS - (now - _window[0]) + 10;

  // ¿Muy poco tiempo desde el último mensaje? Esperar el gap mínimo
  const gap = now - (_window.at(-1) ?? 0);
  return gap < MIN_GAP_MS ? MIN_GAP_MS - gap + 10 : 0;
}

// Envía el primer mensaje de la cola (asume que _waitMs() ya dio 0)
async function _sendNext() {
  const { sayFn, channel, msg, client, meta, expiresAt } = _queue.shift();
  if (expiresAt && Date.now() > expiresAt) {
    logger.info(`IRC: mensaje caducado en cola, descartado: "${String(msg).slice(0, 60)}"`);
    return;
  }
  if (client && client.readyState() !== 'OPEN') {
    logger.warn('IRC: mensaje descartado — cliente no conectado');
    return;
  }
  _window.push(Date.now());
  try {
    await sayFn(channel, msg);
    chatlog.logBotMessage(BOT_NAME, msg, meta);
  } catch (e) {
    logger.warn(`IRC say error: ${e.message}`);
  }
}

async function _drain() {
  _timer = null;
  if (_queue.length === 0) return;

  const wait = _waitMs(Date.now());
  if (wait > 0) { _scheduleDrain(wait); return; }

  await _sendNext();
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
  // meta opcional (3er arg): { origin, model, usedTool, latencyMs }; pisa lo heredado del contexto
  // opts opcional (4º arg): { expiresAt } — si al llegar su turno ya pasó, el mensaje se descarta
  client.say = (channel, msg, explicitMeta, opts) => {
    if (_queue.length >= MAX_QUEUE) {
      logger.warn(`IRC queue llena (${MAX_QUEUE}), mensaje descartado: "${String(msg).slice(0, 60)}"`);
      return;
    }
    // El contexto (origen, modelo, latencia) se captura al encolar: al enviar ya no existe
    _queue.push({ sayFn: _say, channel, msg, client, meta: chatlog.currentMeta(explicitMeta), expiresAt: opts?.expiresAt });
    _scheduleDrain(0);
  };
}

// Al apagar (Render manda SIGTERM) envía lo pendiente respetando el rate limit,
// hasta SHUTDOWN_FLUSH_MS; lo que no quepa se descarta y se registra.
const SHUTDOWN_FLUSH_MS = 5_000;

async function _flushOnExit(signal) {
  if (_closing) return;
  _closing = true;
  clearTimeout(_timer);
  _timer = null;

  const deadline = Date.now() + SHUTDOWN_FLUSH_MS;
  let sent = 0;
  while (_queue.length > 0) {
    const wait = _waitMs(Date.now());
    if (Date.now() + wait > deadline) break;
    if (wait > 0) { await new Promise(r => setTimeout(r, wait)); continue; }
    await _sendNext();
    sent++;
  }

  if (sent > 0) logger.info(`IRC: ${signal} — ${sent} msg(s) de la cola enviados antes de cerrar`);
  if (_queue.length > 0) {
    const items = _queue
      .map(({ channel, msg }) => `${channel}: "${String(msg).slice(0, 60)}"`)
      .join(' | ');
    logger.warn(`IRC: ${signal} — ${_queue.length} msg(s) en cola descartados: ${items}`);
  }
  // Después del chat, guarda el log pendiente en lo que quede del margen (flush nunca lanza)
  const left = deadline - Date.now();
  if (left > 0) {
    await Promise.race([chatlog.flush().catch(() => {}), new Promise(r => setTimeout(r, left))]);
  }
  process.exit(0);
}

process.on('SIGTERM', () => _flushOnExit('SIGTERM'));
process.on('SIGINT',  () => _flushOnExit('SIGINT'));

module.exports = { wrapClientSay };
