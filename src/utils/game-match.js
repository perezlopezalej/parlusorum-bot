// Compara el nombre buscado con el que devuelve RAWG (que siempre da el "más parecido").
// Devuelve 'match' | 'maybe' | 'none'.

const STOPWORDS = new Set(['the', 'of', 'a', 'an', 'and', 'in', 'to', 'de', 'la', 'el', 'los', 'las', 'y']);
const ROMAN = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };
// Números en palabras: "phantom blade zero" = "phantom blade 0", "portal two" = "portal 2"
const NUMBER_WORDS = { zero: '0', cero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };

function tokenize(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(t => ROMAN[t] || NUMBER_WORDS[t] || t);
}

function editDistanceLe1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    // letras adyacentes traspuestas ("knigth")
    for (let k = 0; k < a.length - 1; k++) {
      if (a[k] !== b[k] && a[k] === b[k + 1] && a[k + 1] === b[k] && a.slice(k + 2) === b.slice(k + 2)) return true;
    }
  }
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}

function wordMatches(q, candidates) {
  return candidates.some(r =>
    r === q ||
    (q.length >= 3 && r.length >= 3 && (r.startsWith(q) || q.startsWith(r))) ||
    (q.length >= 5 && r.length >= 5 && editDistanceLe1(q, r)));
}

function classifyGameMatch(searched, returned) {
  const qAll = tokenize(searched);
  const rAll = tokenize(returned);
  if (!qAll.length || !rAll.length) return 'none';

  const isNum = t => /^\d+$/.test(t);
  const qWords = qAll.filter(t => !isNum(t) && !STOPWORDS.has(t));
  const qNums = qAll.filter(isNum);
  const rWords = rAll.filter(t => !isNum(t) && !STOPWORDS.has(t));
  const rNums = rAll.filter(isNum);

  // Abreviaturas tipo "gta 5", "bg3", "rdr2": iniciales del nombre devuelto
  const joined = qAll.join('');
  const initials = rAll.map(t => (isNum(t) ? t : t[0])).join('');
  if (joined.length >= 3 && initials.includes(joined)) return 'match';

  let level;
  if (!qWords.length) {
    level = qNums.length && qNums.every(n => rNums.includes(n)) ? 'match' : 'none';
  } else {
    const hit = qWords.filter(w => wordMatches(w, rWords)).length;
    const cov = hit / qWords.length;
    level = cov >= 1 ? 'match' : cov > 0.5 ? 'maybe' : 'none';
  }
  // Un título de la fuente que repite la palabra buscada ("Hell" frente a "Hell-Hell") es otro juego
  if (level === 'match' && qWords.some(w => rWords.filter(r => wordMatches(w, [r])).length > qWords.filter(x => x === w).length)) level = 'maybe';
  // Un número que no coincide (Dark Souls 3 vs Dark Souls) baja un nivel
  if (level === 'match' && qNums.some(n => !rNums.includes(n))) level = 'maybe';
  return level;
}

// Algunos modelos pasan el nombre cortado ("Hell ..."). Si la pregunta contiene el principio, se recupera el nombre
// completo desde ahí hasta el final de la frase; si no, se devuelve lo que haya y truncated=true (nunca vale como "match").
function recoverTruncatedName(nombre, question = '') {
  const raw = String(nombre || '');
  if (!/\.{2,}|…/.test(raw)) return { name: raw, truncated: false };
  const prefix = raw.split(/\.{2,}|…/)[0].trim();
  const q = String(question || '');
  const at = prefix ? q.toLowerCase().indexOf(prefix.toLowerCase()) : -1;
  if (at >= 0) {
    const tail = q.slice(at).split(/[?!¿¡,.;:()]|\s+(?:y|e|o|u|pero|que|porque|con|vs)\s/i)[0].trim();
    const name = tail.split(/\s+/).slice(0, 6).join(' ');
    if (name.length > prefix.length) return { name, truncated: false, recovered: true };
  }
  return { name: prefix || raw.replace(/[.…]+/g, ' ').trim(), truncated: true };
}

// Parecido del nombre completo (0-1, coeficiente de Dice sobre palabras): para elegir entre varios resultados
function nameSimilarity(a, b) {
  const ta = tokenize(a), tb = tokenize(b);
  if (!ta.length || !tb.length) return 0;
  const pool = [...tb];
  let common = 0;
  for (const t of ta) { const i = pool.indexOf(t); if (i >= 0) { common++; pool.splice(i, 1); } }
  return 2 * common / (ta.length + tb.length);
}

module.exports = { classifyGameMatch, tokenize, nameSimilarity, recoverTruncatedName };
