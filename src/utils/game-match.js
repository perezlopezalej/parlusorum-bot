// Compara el nombre buscado con el que devuelve RAWG (que siempre da el "más parecido").
// Devuelve 'match' | 'maybe' | 'none'.

const STOPWORDS = new Set(['the', 'of', 'a', 'an', 'and', 'in', 'to', 'de', 'la', 'el', 'los', 'las', 'y']);
const ROMAN = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };

function tokenize(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(t => ROMAN[t] || t);
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
  // Un número que no coincide (Dark Souls 3 vs Dark Souls) baja un nivel
  if (level === 'match' && qNums.some(n => !rNums.includes(n))) level = 'maybe';
  return level;
}

module.exports = { classifyGameMatch, tokenize };
