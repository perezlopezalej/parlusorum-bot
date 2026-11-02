// Ortografía de los textos fijos que salen al chat: tildes y signos de apertura (config/ y literales de src/)
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// Formas sin tilde que en estos textos siempre la llevan
const NO_ACCENT_RE = /\b(despues|aqui|ahi|tambien|increible|informacion|proxima|ultimo|ultima|dificil|facil|cancion|numero|cortesia|alegria|habra|creeis|conocia|sabiamos|acompanar\w*|espanol|muchisimas)\b/i;

function stringsOf(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => stringsOf(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => stringsOf(v, out));
  return out;
}

// Quita comandos (!trivia), placeholders ({user}) y emotes (parlus1X) para contar solo signos de frase
const clean = s => s.replace(/![a-z_]+/gi, '').replace(/\{[^}]+\}/g, '').replace(/\bparlus1\w+/gi, '');

function problems(text) {
  const found = [];
  const m = NO_ACCENT_RE.exec(text);
  if (m) found.push(`sin tilde: "${m[0]}"`);
  const c = clean(text);
  if ((c.match(/\?/g) || []).length > (c.match(/¿/g) || []).length) found.push('falta ¿');
  if ((c.match(/!/g) || []).length > (c.match(/¡/g) || []).length) found.push('falta ¡');
  return found;
}

const LITERAL_RE = /(['"`])((?:\\.|(?!\1).)*)\1/g;

describe('ortografía de textos fijos', () => {
  test('problems() detecta los fallos de los directos reales', () => {
    for (const t of ['Cual es vuestro juego favorito de todos los tiempos?', 'Cuantas muertes creeis que habra hoy?', 'Que os parece este juego?', 'Sabiamos que estabas ahi', 'Chat! Alguien se anima', 'LIVE! Bienvenidos todos!', 'Alguien lo conocia ya?']) {
      assert.ok(problems(t).length > 0, t);
    }
    assert.deepEqual(problems('¿Cuántas muertes creéis que habrá hoy? 💀'), []);
    assert.deepEqual(problems('¡Usad !chiste para que cuente un chiste! 😂'), []);
  });

  test('config/messages.json y config/help.json', () => {
    const bad = [];
    for (const file of ['messages.json', 'help.json']) {
      const data = JSON.parse(fs.readFileSync(path.join(root, 'config', file), 'utf8'));
      for (const t of stringsOf(data)) {
        const p = problems(t);
        if (p.length) bad.push(`${file}: ${t} → ${p.join(', ')}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  test('literales de chat en src/ (say, throttleSay, listas de mensajes)', () => {
    const bad = [];
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
    for (const file of walk(path.join(root, 'src')).filter(f => f.endsWith('.js'))) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const l = line.trim();
        if (l.startsWith('//') || l.startsWith('*') || /logger\.|console\./.test(l)) return;
        const isChatLine = /\b(say|throttleSay)\(/.test(l) || /\{username\}/.test(l) || /message: '/.test(l) || /^['"`].*(🎮|💬|🧠|💀|😂|🔥|🥳)/.test(l);
        if (!isChatLine) return;
        // Cada literal con espacios por separado y sin código de ${...}: los ? y ! de operadores quedan fuera
        for (const lit of l.matchAll(LITERAL_RE)) {
          const text = lit[2].replace(/!\$\{[^}]*\}/g, '').replace(/\$\{[^}]*\}/g, '');
          if (!/\S\s+\S/.test(text.trim()) || text.includes('${')) continue; // sin texto o con plantillas anidadas
          const p = problems(text);
          if (p.length) bad.push(`${path.relative(root, file)}:${i + 1}: ${text.slice(0, 110)} → ${p.join(', ')}`);
        }
      });
    }
    assert.deepEqual(bad, []);
  });
});
