/**
 * Preguntas de trivia sobre la historia del propio canal, generadas por plantilla (sin IA).
 * Función pura: recibe los datos ya leídos. Solo usa cifras, títulos y lore neutro
 * (meme/frase/chiste), nunca trama de los juegos.
 */

const MIN_SESSIONS = 3;
const LORE_KINDS = new Set(['meme', 'frase', 'chiste']);
const q = (question, answer, extra = {}) => ({ question, answer: String(answer).toLowerCase(), curiosidad: '', ...extra });

// data: { sessions: [{game, death_count}], champion: {username, count}|null, lore: [{term, kind}] }
function channelQuestionCandidates({ sessions = [], champion = null, lore = [] } = {}) {
  const out = [];
  const withDeaths = sessions.filter(s => Number.isFinite(s.death_count) && s.death_count >= 0);

  if (withDeaths.length >= MIN_SESSIONS) {
    const max = Math.max(...withDeaths.map(s => s.death_count));
    const top = withDeaths.filter(s => s.death_count === max);
    if (max >= 1) {
      out.push(q('¿Cuál es el récord de muertes en un solo stream del canal?', max, { curiosidad: `Récord: ${max} muertes.` }));
      const game = top.length === 1 ? String(top[0].game || '').trim() : '';
      if (game) {
        const short = game.split(':')[0].trim();
        out.push(q('¿En qué juego fue el récord de muertes en un solo stream?', game, {
          aliases: short && short.toLowerCase() !== game.toLowerCase() ? [short] : [],
          curiosidad: `${max} muertes en ${game}.`
        }));
      }
    }
    const distinct = new Set(withDeaths.map(s => String(s.game || '').trim()).filter(Boolean)).size;
    if (distinct >= MIN_SESSIONS) {
      out.push(q('¿A cuántos juegos distintos han jugado en los últimos streams registrados?', distinct));
    }
  }

  if (champion && champion.count >= 2 && champion.username) {
    out.push(q('¿Quién lidera el ranking de trivia del chat?', champion.username, { curiosidad: `${champion.count} victorias.` }));
  }

  for (const row of lore) {
    if (!LORE_KINDS.has(row.kind)) continue;
    const words = String(row.term || '').trim().split(/\s+/).filter(Boolean);
    const last = words[words.length - 1] || '';
    if (words.length < 3 || last.replace(/[^\p{L}\p{N}]/gu, '').length < 3) continue;
    out.push(q(`Completa el lema del canal: "${words.slice(0, -1).join(' ')} ..."`, last, { curiosidad: `Lema: "${row.term}".` }));
  }

  return out;
}

// Elige una candidata que no se haya hecho ya; null si no hay datos suficientes
function buildChannelQuestion(data, { isRecent = () => false, rng = Math.random } = {}) {
  const fresh = channelQuestionCandidates(data).filter(c => !isRecent(c.question));
  if (!fresh.length) return null;
  return fresh[Math.min(fresh.length - 1, Math.floor(rng() * fresh.length))];
}

module.exports = { buildChannelQuestion, channelQuestionCandidates };
