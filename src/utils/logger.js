const fs = require('fs');
const path = require('path');

const LOG_DIR = require('path').join(__dirname, '../../logs');
const LOG_FILE = require('path').join(LOG_DIR, 'bot.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB máximo

// Crear carpeta logs si no existe
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function formatDate() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function rotateLogs() {
  try {
    const stats = fs.statSync(LOG_FILE);
    if (stats.size > MAX_LOG_SIZE) {
      fs.renameSync(LOG_FILE, LOG_FILE.replace('.log', '.old.log'));
    }
  } catch {}
}

// Oculta cualquier cosa con forma de token (oauth:, Bearer, JWT, claves gsk_/sb_secret_, campos *_token/secret)
const REDACT_PATTERNS = [
  /oauth:[A-Za-z0-9]+/gi,
  /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  /\b(?:gsk_|sb_secret_|sk-ant-)[A-Za-z0-9_-]+/g,
  /((?:access_token|refresh_token|client_secret|api_?key|secret)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi,
];

function redact(message) {
  let out = String(message);
  for (const re of REDACT_PATTERNS) {
    out = out.replace(re, (m, prefix) => (typeof prefix === 'string' ?`${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return out;
}

function write(level, message) {
  const line = `[${formatDate()}] [${level}] ${redact(message)}\n`;
  process.stdout.write(line);
  try {
    rotateLogs();
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

module.exports = {
  info: (msg) => write('INFO', msg),
  warn: (msg) => write('WARN', msg),
  error: (msg) => write('ERROR', msg),
  debug: (msg) => {
    if (process.env.NODE_ENV !== 'production') write('DEBUG', msg);
  }
};
