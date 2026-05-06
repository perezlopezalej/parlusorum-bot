// Métricas básicas de actividad del chat
const metrics = {
  messagesPerHour: [],
  commandsUsed: new Map(),
  peakViewers: 0,
  sessionStart: Date.now()
};

function trackMessage() {
  const now = Date.now();
  metrics.messagesPerHour.push(now);
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

function getSummary() {
  const uptime = Math.floor((Date.now() - metrics.sessionStart) / 60000);
  const hours = Math.floor(uptime / 60);
  const mins = uptime % 60;
  return {
    uptime: hours > 0 ? `${hours}h ${mins}m` : `${mins}m`,
    messagesLastHour: getMessagesPerHour(),
    peakViewers: metrics.peakViewers,
    topCommands: getTopCommands()
  };
}

module.exports = { trackMessage, trackCommand, updatePeakViewers, getSummary, getMessagesPerHour };
