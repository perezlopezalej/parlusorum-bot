const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildCommandList, getHelpText } = require('../src/commands/help');

describe('!comandos y !ayuda', () => {
  test('la lista incluye !top y !quemeperdi para todos', () => {
    const list = buildCommandList(false);
    assert.match(list, /!top/);
    assert.match(list, /!quemeperdi/);
  });

  test('!lore solo aparece para mods, en lista y en ayuda', () => {
    assert.doesNotMatch(buildCommandList(false), /!lore/);
    assert.match(buildCommandList(true), /Mods:.*!lore/);
    assert.equal(getHelpText('lore', false), null);
    assert.match(getHelpText('lore', true), /Lore del canal/);
  });

  test('todo comando listado tiene ayuda y viceversa', () => {
    const names = buildCommandList(true).match(/![a-z_]+/g).map(s => s.slice(1));
    for (const n of names) assert.ok(getHelpText(n, true), `sin ayuda: ${n}`);
  });

  test('ayuda de comando desconocido o vacío devuelve null', () => {
    assert.equal(getHelpText('nope', true), null);
    assert.equal(getHelpText(undefined, true), null);
  });
});
