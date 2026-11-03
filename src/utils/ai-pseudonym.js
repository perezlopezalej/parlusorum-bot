// Seudonimización de nicks hacia proveedores que pueden usar los datos (Gemini gratuito):
// los nicks del chat se cambian por user1, user2… en el prompt y se restauran en la respuesta.
const channelConfig = require('../../config/channel.json');

const ALIAS_RE = /(?<![\p{L}\p{N}_])user(\d+)(?![\p{L}\p{N}_])/giu;
const MIN_NAME_LEN = 3;

// Nombres públicos que forman parte del prompt (streamers, creador/mods, el bot y el canal): no se tocan
function excludedNames() {
  const list = [...(channelConfig.streamers || []), ...(channelConfig.moderators || []), process.env.BOT_USERNAME, process.env.CHANNEL,
    ...String(process.env.AI_PSEUDONYM_EXCLUDE || '').split(',')];
  return new Set(list.map(n => String(n || '').trim().toLowerCase()).filter(Boolean));
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// → { fromAlias: Map(alias → nick original), messages } ; map null si ningún nick aparece
function pseudonymize(messages, names, { exclude = excludedNames() } = {}) {
  const candidates = [...new Set((names || []).map(n => String(n || '').replace(/^@/, '').trim()))]
    .filter(n => n.length >= MIN_NAME_LEN && !/\s/.test(n) && !/^user\d+$/i.test(n) && !exclude.has(n.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  if (!candidates.length) return { messages, map: null };
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${candidates.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  const toAlias = new Map();
  const fromAlias = new Map();
  const swap = text => text.replace(re, found => {
    const lower = found.toLowerCase();
    if (!toAlias.has(lower)) {
      const alias = `user${toAlias.size + 1}`;
      toAlias.set(lower, alias);
      fromAlias.set(alias, candidates.find(c => c.toLowerCase() === lower) || found);
    }
    return toAlias.get(lower);
  });
  const out = (messages || []).map(m => typeof m.content === 'string' ? { ...m, content: swap(m.content) } : m);
  return { messages: out, map: fromAlias.size ? fromAlias : null };
}

function restoreText(text, map) {
  if (!map || typeof text !== 'string') return text;
  return text.replace(ALIAS_RE, (found, n) => map.get(`user${n}`) ?? found);
}

function restoreResult(result, map) {
  if (!map) return result;
  for (const c of result?.choices || []) if (typeof c?.message?.content === 'string') c.message.content = restoreText(c.message.content, map);
  return result;
}

module.exports = { pseudonymize, restoreText, restoreResult, excludedNames };
