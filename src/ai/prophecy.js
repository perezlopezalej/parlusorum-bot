/**
 * prophecy.js — Cálculo y validación puros de la profecía de muertes
 */

const NEXT_STREAM_RE = /\b(pr[oó]xim[oa]s?|siguientes?|otro) (stream|directo|v[ií]deo)s?\b|\bla (pr[oó]xima|siguiente) vez\b|\bma[ñn]ana\b/i;

// Media de las sesiones con muertes apuntadas: las de 0 no cuentan (nadie llevó la cuenta).
// Prioriza el mismo juego; sin historial de ese juego, usa todas las sesiones con muertes. null si no hay ninguna.
function predictFromRows(rows, game) {
  const valid = (rows || []).filter(r => Number.isFinite(r.death_count) && r.death_count > 0);
  if (valid.length === 0) return null;
  const sameGame = game ? valid.filter(r => r.game === game) : [];
  const pool = sameGame.length > 0 ? sameGame : valid;
  const avg = pool.reduce((s, r) => s + r.death_count, 0) / pool.length;
  return {
    deaths: Math.max(1, Math.round(avg)),
    basis: sameGame.length > 0 ? `${sameGame.length} streams anteriores de ${game}` : `${pool.length} streams anteriores (de otros juegos)`,
    history: pool.map(r => r.death_count),
  };
}

// La profecía es para HOY: rechaza "el próximo stream" y similares
function refersToNextStream(text) { return NEXT_STREAM_RE.test(text); }

// "superando", "récord", "más que nunca"... solo valen si la cifra supera de verdad todas las anteriores
const SURPASS_RE = /\bsuper\w*|\br[eé]cord\b|\bbat(?:ir|e|iendo|ido)\b|m[aá]s que (?:nunca|antes|en)|nuevo m[aá]ximo|mejora\w* (?:su|tu)s? (?:marca|cifra)|\bpor encima\b/i;
function falseSurpass(text, deaths, history = []) {
  if (!history.length || deaths > Math.max(...history)) return false;
  return SURPASS_RE.test(text);
}

module.exports = { predictFromRows, refersToNextStream, falseSurpass };
