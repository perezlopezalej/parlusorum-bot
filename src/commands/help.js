const helpConfig = require('../../config/help.json');

// Única fuente de verdad de !comandos y !ayuda: config/help.json.
// Las entradas con modOnlyVisible (ej. !lore) no existen para quien no es mod.
function visibleEntries(isMod, entries = helpConfig.commands) {
  return entries.filter(e => isMod || !e.modOnlyVisible);
}

function buildCommandList(isMod, entries = helpConfig.commands) {
  const visible = visibleEntries(isMod, entries);
  const fmt = list => list.map(e => `!${e.name}`).join(' ');
  const users = visible.filter(e => !e.mod);
  const mods = visible.filter(e => e.mod);
  return `📋 Comandos: ${fmt(users)}${mods.length ? ` | Mods: ${fmt(mods)}` : ''}`;
}

function getHelpText(name, isMod, entries = helpConfig.commands) {
  if (!name) return null;
  const entry = visibleEntries(isMod, entries).find(e => e.name === name.toLowerCase());
  return entry ? entry.help : null;
}

module.exports = { buildCommandList, getHelpText };
