// Plantillas fijas del chat (config/plantillas.json): varias variantes por clave que rotan sin repetir la anterior.
// Sustituyen a la IA en lurk, reacciones del chat, encuestas y predicciones.
const state = require('./state');
const data = require('../../config/plantillas.json');

// Elige una variante distinta de la última usada (rng inyectable para tests)
function pickIndex(length, last, rng = Math.random) {
  if (length <= 1) return 0;
  let i = Math.floor(rng() * (length - 1));
  if (last !== undefined && last !== null && i >= last) i++; // salta la anterior
  return i;
}

function fill(text, vars = {}) {
  return String(text)
    .replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''))
    .replace(/ {2,}/g, ' ')
    .replace(/ +([.,!?])/g, '$1')
    .trim();
}

// template('lurk', { username }) → texto listo para truncate() y client.say()
function template(key, vars = {}, { rng = Math.random, source = data } = {}) {
  const list = source[key];
  if (!Array.isArray(list) || !list.length) throw new Error(`Plantilla desconocida: ${key}`);
  const i = pickIndex(list.length, state.getTemplateLast(key), rng);
  state.setTemplateLast(key, i);
  return fill(list[i], vars);
}

module.exports = { template, pickIndex, fill, TEMPLATES: data };
