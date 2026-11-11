-- Fase B2 (privacidad), paso 2 de 2: DESTRUCTIVA. Ejecutar solo tras desplegar el código nuevo
-- y comprobar en directo que funciona con 010 (olvido, !top, registro de calidad).

delete from public.user_facts where user_id is null;           -- no casó con ningún usuario
alter table public.user_facts add primary key (user_id, channel, fact_type);
drop index if exists public.user_facts_user_key;
alter table public.user_facts drop column username;

-- channel_lore.users pasa a guardar user_id: se vacían los nicks antiguos (se recalculan en los siguientes streams)
update public.channel_lore set users = '{}', users_count = 0;

drop table if exists public.bot_self_reviews;                   -- sustituida por quality_log
