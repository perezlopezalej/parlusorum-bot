const { spokenDuration } = require('../ai/quality');

// Métricas básicas de actividad del chat
const metrics = {
  messagesPerHour: [],
  commandsUsed: new Map(),
  peakViewers: 0,
  streamMessageCount: 0,
  sessionStart: Date.now(),
};

function trackMessage() {
  const now = Date.now();
  metrics.messagesPerHour.push(now);
  metrics.streamMessageCount++;
  // Mantener solo la última hora
  const oneHourAgo = now - 3600000;
  while (metrics.messagesPerHour.length > 0 && metrics.messagesPerHour[0] < oneHourAgo) {
    metrics.messagesPerHour.shift();
  }
}

function trackCommand(command) {
  const count = metrics.commandsUsed.get(command) || 0;
  metrics.commandsUsed.set(command, count + 1);
}

function updatePeakViewers(viewers) {
  if (viewers > metrics.peakViewers) {
    metrics.peakViewers = viewers;
  }
}

function getMessagesPerHour() {
  return metrics.messagesPerHour.length;
}

function getTopCommands(n = 5) {
  return [...metrics.commandsUsed.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([cmd, count]) => `!${cmd}(${count})`)
    .join(' ');
}

function resetStreamMetrics() {
  metrics.peakViewers = 0;
  metrics.streamMessageCount = 0;
  metrics.commandsUsed.clear();
}

// Se guardan en bot_state para que un reinicio a mitad de directo no los ponga a cero (bot-state.js)
const MAX_SAVED_COMMANDS = 20;
const commandKey = /^[\p{L}\p{N}_]{1,30}$/u;
function exportMetrics() {
  const top = [...metrics.commandsUsed.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SAVED_COMMANDS);
  return { peakViewers: metrics.peakViewers, messages: metrics.streamMessageCount, commands: Object.fromEntries(top) };
}
const natural = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
// El mayor valor gana (no duplica si se restaura dos veces). Devuelve cuántos contadores ha recuperado.
function mergeMetrics(saved) {
  if (!saved || typeof saved !== 'object') return 0;
  let n = 0;
  const peak = natural(saved.peakViewers);
  if (peak > metrics.peakViewers) {
    metrics.peakViewers = peak;
    n++;
  }
  const messages = natural(saved.messages);
  if (messages > metrics.streamMessageCount) {
    metrics.streamMessageCount = messages;
    n++;
  }
  const commands = saved.commands && typeof saved.commands === 'object' ? Object.entries(saved.commands) : [];
  for (const [cmd, v] of commands.slice(0, MAX_SAVED_COMMANDS)) {
    if (!commandKey.test(cmd)) continue;
    const val = natural(v);
    if (val > (metrics.commandsUsed.get(cmd) || 0)) {
      metrics.commandsUsed.set(cmd, val);
      n++;
    }
  }
  return n;
}

function getSummary() {
  const uptime = Math.floor((Date.now() - metrics.sessionStart) / 60000);
  const hours = Math.floor(uptime / 60);
  const mins = uptime % 60;
  return {
    uptime: spokenDuration(hours * 60 + mins),
    messagesLastHour: getMessagesPerHour(),
    totalMessages: metrics.streamMessageCount,
    peakViewers: metrics.peakViewers,
    topCommands: getTopCommands(),
  };
}

module.exports = {
  trackMessage,
  trackCommand,
  updatePeakViewers,
  getSummary,
  getMessagesPerHour,
  resetStreamMetrics,
  exportMetrics,
  mergeMetrics,
};
