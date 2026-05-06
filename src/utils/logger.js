const fs = require('fs');
const path = require('path');

const LOG_DIR = './logs';
const LOG_FILE = path.join(LOG_DIR, 'bot.log');
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

function write(level, message) {
  const line = `[${formatDate()}] [${level}] ${message}\n`;
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
