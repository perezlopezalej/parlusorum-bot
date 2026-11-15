// Respuesta de reserva de !dios_fua cuando IGDB tiene datos del juego pero la IA no logra ceñirse a ellos:
// solo nombre, género, estudio y año de IGDB, más una frase de personalidad fija.

const { translateGenres } = require('../utils/genres');

// info: { name, genres, developers, released } de getGameInfo; quips: frases de config/messages.json (dios_fua_game_quips)
function buildGameTemplate(info, quips = [], pick = (arr) => arr[Math.floor(Math.random() * arr.length)]) {
  if (!info?.name) return '';
  const genres = translateGenres(info.genres);
  const year = info.released ? String(info.released).slice(0, 4) : '';
  const studio = info.developers ? String(info.developers).split(',')[0].trim() : '';
  let facts = info.name;
  if (genres) facts += `: ${genres.toLowerCase()}`;
  if (studio) facts += `${genres ? ',' : ':'} de ${studio}${info.country ? `, estudio de ${info.country}` : ''}`;
  if (year) facts += ` (${year})`;
  const quip = quips.length ? pick(quips) : '';
  return `${facts}. ${quip}`.trim();
}

// «¿De qué va?» / «¿cuál es el lore?»: el título y el resumen en español de la caché (game-sheet), sin los datos de la ficha.
// → '' si no hay resumen (entonces vale la plantilla de datos).
function buildPremiseReply(info, summary) {
  const text = String(summary || '').trim();
  if (!info?.name || !text) return '';
  const body = text.replace(/\s+/g, ' ');
  // si el resumen ya empieza por el título («Silent Hill f es un survival…»), no se repite delante
  const plain = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return plain(body).startsWith(plain(info.name)) ? body : `${info.name}: ${body}`;
}

module.exports = { buildGameTemplate, buildPremiseReply };
