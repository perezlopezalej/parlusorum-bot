// Respuesta de reserva de !dios_fua cuando RAWG tiene datos del juego pero la IA no logra ceñirse a ellos:
// solo nombre, género, estudio y año de RAWG, más una frase de personalidad fija.

const { translateGenres } = require('../utils/genres');

// info: { name, genres, developers, released } de getGameInfo; quips: frases de config/messages.json (dios_fua_rawg_quips)
function buildRawgTemplate(info, quips = [], pick = arr => arr[Math.floor(Math.random() * arr.length)]) {
  if (!info?.name) return '';
  const genres = translateGenres(info.genres);
  const year = info.released ? String(info.released).slice(0, 4) : '';
  const studio = info.developers ? String(info.developers).split(',')[0].trim() : '';
  let facts = info.name;
  if (genres) facts += `: ${genres.toLowerCase()}`;
  if (studio) facts += `${genres ? ',' : ':'} de ${studio}`;
  if (year) facts += ` (${year})`;
  const quip = quips.length ? pick(quips) : '';
  return `${facts}. ${quip}`.trim();
}

module.exports = { buildRawgTemplate };
