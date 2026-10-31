// Géneros de RAWG (inglés) a español para los mensajes del chat

const GENRES_ES = {
  action: 'Acción',
  adventure: 'Aventura',
  rpg: 'Rol',
  'role-playing': 'Rol',
  shooter: 'Disparos',
  strategy: 'Estrategia',
  puzzle: 'Puzles',
  platformer: 'Plataformas',
  racing: 'Carreras',
  sports: 'Deportes',
  fighting: 'Lucha',
  simulation: 'Simulación',
  arcade: 'Arcade',
  indie: 'Indie',
  casual: 'Casual',
  family: 'Familiar',
  'massively multiplayer': 'Multijugador masivo',
  'board games': 'Juegos de mesa',
  educational: 'Educativo',
  card: 'Cartas',
};

// "Adventure, Action" → "Aventura, Acción". Los géneros que no están en la tabla se omiten (nunca se deja inglés)
function translateGenres(genres) {
  if (!genres) return '';
  return String(genres).split(',')
    .map(g => GENRES_ES[g.trim().toLowerCase()])
    .filter(Boolean)
    .join(', ');
}

module.exports = { GENRES_ES, translateGenres };
