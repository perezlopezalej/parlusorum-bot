// Rate limiter global para llamadas a la IA
// Evita abuso coordinado y protege el límite de Groq

const MAX_REQUESTS_PER_MINUTE = parseInt(process.env.AI_MAX_RPM || '20', 10);
const requestTimestamps = [];

function canMakeRequest() {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;

  // Limpiar timestamps antiguos
  while (requestTimestamps.length > 0 && requestTimestamps[0] < oneMinuteAgo) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
    return false;
  }

  requestTimestamps.push(now);
  return true;
}

function getRequestsRemaining() {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  const recent = requestTimestamps.filter(ts => ts > oneMinuteAgo);
  return Math.max(0, MAX_REQUESTS_PER_MINUTE - recent.length);
}

module.exports = { canMakeRequest, getRequestsRemaining };
