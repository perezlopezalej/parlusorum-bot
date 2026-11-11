-- Fase B2 (privacidad), paso 1 de 2: ADITIVA. Ejecutar una vez en el SQL Editor de Supabase, ANTES de desplegar.
-- El código acepta el esquema con y sin estos cambios. La parte destructiva está en 011.

-- chat_log: user_id para poder borrar por usuario (retención 24 h, la aplica el bot cada hora)
alter table public.chat_log add column if not exists user_id text;
create index if not exists chat_log_user_idx on public.chat_log (user_id);

-- user_facts: clave por user_id (se rellena desde users; lo que no case queda por nick hasta 011).
-- Se suelta la clave primaria por nick y username pasa a ser opcional para que el bot ya escriba solo user_id.
alter table public.user_facts add column if not exists user_id text;
alter table public.user_facts drop constraint if exists user_facts_pkey;
alter table public.user_facts alter column username drop not null;
update public.user_facts f set user_id = u.user_id
  from public.users u where f.user_id is null and lower(u.username) = f.username;
create unique index if not exists user_facts_user_key on public.user_facts (user_id, channel, fact_type);
create index if not exists user_facts_updated_idx on public.user_facts (updated_at);
create index if not exists users_last_seen_idx on public.users (last_seen);

-- Registro de calidad (30 días): sin nicks ni user_id; user_keys = HMAC del user_id de cada participante
create table if not exists public.quality_log (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  session_id  bigint,
  stream_date date not null,
  kind        text not null check (kind in ('entry','summary')),
  payload     jsonb not null,
  user_keys   text[] not null default '{}'
);
create index if not exists quality_log_created_idx on public.quality_log (created_at);
create index if not exists quality_log_session_idx on public.quality_log (session_id);
create index if not exists quality_log_keys_idx on public.quality_log using gin (user_keys);
alter table public.quality_log enable row level security;  -- sin políticas (ver 001)

-- Lore: quién aprueba; todo lo activo vuelve a la cola de aprobación (!lore aprobar)
alter table public.channel_lore add column if not exists approved_by text;
alter table public.channel_lore add column if not exists approved_at timestamptz;
update public.channel_lore set status = 'pending', needs_approval = true where status = 'active';

-- Datos que se dejan de guardar
update public.stream_memory set active_users = '{}';
update public.stream_highlights set trigger_messages = '{}';
delete from public.user_facts where fact_type = 'recurring_joke';
delete from public.bot_self_reviews where created_at < now() - interval '30 days';
