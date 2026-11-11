/**
 * privacy/forget.js — Derecho de supresión: borra TODO lo guardado de un usuario.
 *
 *   forgetUser({ userId, login })  →  { ok, counts, errors, ids }
 *
 * Lo llaman !fua_olvidame, !fua_olvidar @usuario (mods) y `npm run forget -- <login>`.
 * Borra por user_id y, donde solo hay nick (filas antiguas), por nick exacto sin distinguir mayúsculas
 * (con los comodines de LIKE escapados: «ana_pro» no borra a «anaxpro»).
 *
 * Cada tabla va en su propio paso: si una falla, las demás se borran igualmente y el resultado es
 * `ok: false`. Es idempotente: se puede repetir. Con `dryRun` solo cuenta lo que borraría.
 * Sin user_id ni nick no hace nada (nunca un delete sin filtro).
 */
const supabase = require('../utils/supabase');
const { scrubNicks } = require('./names');
const { userKeysFor } = require('./quality-log');

const likeEscape = (s) => String(s).replace(/[\\%_]/g, '\\$&');
const norm = (t) =>
  String(t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const MIN_TERM_NICK = 3;

// Tabla o columna que no existe (migración sin aplicar o ya retirada): no es un error
const isMissing = (e) =>
  /does not exist|schema cache|relation .* not|Could not find/i.test(String(e?.message || e || ''));

// Limpieza de RAM: cachés, buffers, guardados diferidos, conversaciones y cola del registro de chat
function defaultMemory() {
  return {
    clear({ ids, login }) {
      let n = 0;
      supabase.forgetUserInCache(ids);
      const state = require('../utils/state');
      for (const id of ids.length ? ids : [null]) {
        n += state.removeChatLogByUser(id, login) + state.removeLoreSampleByUser(id, login);
        if (id) state.markForgotten(id);
      }
      try {
        const ai = require('../ai/handler'); // lazy: arrastra mucho código
        for (const id of ids.length ? ids : [null]) n += ai.forgetUserInMemory({ userId: id, login });
      } catch {
        /* sin handler de IA (script suelto): nada en RAM que limpiar */
      }
      return n;
    },
  };
}

async function forgetUser({
  userId = null,
  login = null,
  db = supabase,
  memory = defaultMemory(),
  dryRun = false,
  secret,
} = {}) {
  const nick =
    String(login || '')
      .replace(/^@/, '')
      .trim()
      .toLowerCase() || null;
  const knownId = userId ? String(userId) : null;
  if (!knownId && !nick) return { ok: false, counts: {}, errors: ['sin user_id ni nick'], ids: [] };

  const client = db.getClient();
  if (!client) return { ok: false, counts: {}, errors: ['Supabase no configurado'], ids: [] };

  const counts = {};
  const errors = [];
  const step = async (name, fn) => {
    try {
      counts[name] = await fn();
    } catch (e) {
      if (isMissing(e)) {
        counts[name] = 0;
        return;
      }
      counts[name] = 0;
      errors.push(`${name}: ${e.message || e}`);
    }
  };

  // user_id: el recibido más los de cualquier fila de users con ese nick
  const ids = new Set(knownId ? [knownId] : []);
  if (nick) {
    try {
      const { data, error } = await client
        .from('users')
        .select('user_id, username')
        .ilike('username', likeEscape(nick));
      if (error) throw error;
      for (const r of data || []) ids.add(String(r.user_id));
    } catch (e) {
      errors.push(`resolver usuario: ${e.message || e}`);
    }
  }
  const idList = [...ids];

  // RAM primero: así un guardado diferido no reescribe la fila después de borrarla
  if (!dryRun) {
    try {
      counts.memoria = memory.clear({ ids: idList, login: nick });
    } catch (e) {
      errors.push(`memoria: ${e.message || e}`);
    }
  }

  const remove = async (table, apply) => {
    if (dryRun) {
      const { data, error } = await apply(client.from(table).select('*'));
      if (error) throw error;
      return (data || []).length;
    }
    const { error, count } = await apply(client.from(table).delete({ count: 'exact' }));
    if (error) throw error;
    return count || 0;
  };

  // 1) Chat completo (24 h): por id y por nick
  if (idList.length) await step('chat_log (id)', () => remove('chat_log', (q) => q.in('user_id', idList)));
  if (nick) await step('chat_log (nick)', () => remove('chat_log', (q) => q.ilike('username', likeEscape(nick))));
  // Los mensajes de otros que le respondían guardan su login: se anula
  if (nick) {
    await step('chat_log (respuestas)', async () => {
      if (dryRun) {
        const { data, error } = await client.from('chat_log').select('*').eq('reply_parent_login', nick);
        if (error) throw error;
        return (data || []).length;
      }
      const { data, error } = await client
        .from('chat_log')
        .update({ reply_parent_login: null })
        .eq('reply_parent_login', nick)
        .select();
      if (error) throw error;
      return (data || []).length;
    });
  }

  // 2) Registro de calidad (30 días): entradas completas donde participó
  await step('quality_log', async () => {
    let n = 0;
    for (const key of userKeysFor({ userId: knownId, login: nick }, secret))
      n += await remove('quality_log', (q) => q.contains('user_keys', [key]));
    for (const id of idList) {
      if (id === knownId) continue;
      for (const key of userKeysFor({ userId: id }, secret))
        n += await remove('quality_log', (q) => q.contains('user_keys', [key]));
    }
    return n;
  });

  // 3) Hechos, contadores y ficha de usuario
  if (idList.length) await step('user_facts', () => remove('user_facts', (q) => q.in('user_id', idList)));
  if (nick) await step('user_facts (nick antiguo)', () => remove('user_facts', (q) => q.eq('username', nick)));
  if (idList.length) await step('users', () => remove('users', (q) => q.in('user_id', idList)));

  // 4) Memoria entre streams: su nick en los textos y en active_users
  const scrub = (t) => scrubNicks(t, [nick], { exclude: new Set() });
  const scrubTable = async (table, columns, listColumns = []) => {
    const { data, error } = await client.from(table).select('*');
    if (error) throw error;
    let changed = 0;
    for (const row of data || []) {
      const patch = {};
      for (const c of columns) if (typeof row[c] === 'string' && scrub(row[c]) !== row[c]) patch[c] = scrub(row[c]);
      for (const c of listColumns) {
        if (!Array.isArray(row[c])) continue;
        const next = row[c].filter((x) => String(x).toLowerCase() !== nick).map((x) => scrub(String(x)));
        if (JSON.stringify(next) !== JSON.stringify(row[c])) patch[c] = next;
      }
      if (!Object.keys(patch).length) continue;
      changed++;
      if (!dryRun) {
        const { error: upErr } = await client.from(table).update(patch).eq('id', row.id);
        if (upErr) throw upErr;
      }
    }
    return changed;
  };
  if (nick) {
    await step('stream_memory', () =>
      scrubTable('stream_memory', ['summary'], ['highlights', 'recurring_phrases', 'active_users']),
    );
    await step('bot_self_reviews', () => scrubTable('bot_self_reviews', ['report']));
  }

  // 5) Lore aprendido: se le quita de users y se borra el lore que lo menciona
  await step('channel_lore', async () => {
    const { data, error } = await client.from('channel_lore').select('*');
    if (error) throw error;
    const nickNorm = nick ? norm(nick) : '';
    let touched = 0;
    for (const row of data || []) {
      const mentions =
        nickNorm.length >= MIN_TERM_NICK &&
        (` ${norm(row.term_key)} `.includes(` ${nickNorm} `) || ` ${norm(row.term)} `.includes(` ${nickNorm} `));
      if (mentions) {
        touched++;
        if (!dryRun) {
          const { error: delErr } = await client.from('channel_lore').delete().eq('id', row.id);
          if (delErr) throw delErr;
        }
        continue;
      }
      const users = Array.isArray(row.users) ? row.users : [];
      const kept = users.filter((u) => !ids.has(String(u)) && String(u).toLowerCase() !== nick);
      if (kept.length === users.length) continue;
      touched++;
      if (!dryRun) {
        const { error: upErr } = await client
          .from('channel_lore')
          .update({ users: kept, users_count: kept.length })
          .eq('id', row.id);
        if (upErr) throw upErr;
      }
    }
    return touched;
  });

  // 6) Cooldowns con su id o su nick en la clave
  await step('cooldowns', async () => {
    let n = 0;
    for (const who of [...idList, nick].filter(Boolean))
      n += await remove('cooldowns', (q) => q.ilike('key', `%-${likeEscape(who)}`));
    return n;
  });

  return { ok: errors.length === 0, counts, errors, ids: idList };
}

module.exports = { forgetUser, likeEscape, norm };
