// Línea de !juego: juego, año, géneros en español y desarrolladora; atribución cuando los datos vienen de IGDB.
const { translateGenres } = require('../utils/genres');
const { ATTRIBUTION } = require('../twitch/igdb');

// null si no hay nada que añadir al nombre del juego (el llamador usa entonces la línea simple)
function formatJuegoLine(game, title, info) {
  if (!info) return null;
  const year = info.released ? String(info.released).slice(0, 4) : '';
  const genres = translateGenres(info.genres);
  const dev = info.developers ? `Desarrolladora: ${info.developers}` : '';
  const facts = [genres, dev].filter(Boolean);
  if (!year && !facts.length) return null;
  const extra = title ? `. Título del directo: ${title}` : '';
  const credit = info.source === 'igdb' ? `. ${ATTRIBUTION}` : '';
  return `🎮 ${game}${year ? ` (${year})` : ''}${facts.length ? `: ${facts.join(', ')}` : ''}${extra}${credit}`;
}

module.exports = { formatJuegoLine };
