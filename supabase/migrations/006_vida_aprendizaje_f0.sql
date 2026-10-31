-- Fase F0 (medir y autorrevisión): ejecutar una vez en el SQL Editor de Supabase, ANTES de desplegar.

-- A quién responde cada mensaje del chat (tag reply-parent-user-login de Twitch)
alter table public.chat_log add column if not exists reply_parent_login text;

-- Informe de autorrevisión de fin de stream (solo para revisión humana)
create table if not exists public.bot_self_reviews (
  id          bigint generated always as identity primary key,
  channel     text not null default 'parlusorum',
  created_at  timestamptz not null default now(),
  session_id  bigint,
  stats       jsonb not null default '{}'::jsonb,
  report      text not null
);
create index if not exists bot_self_reviews_session_idx on public.bot_self_reviews (session_id);

-- RLS activado sin políticas: solo accede la clave secreta (service role)
alter table public.bot_self_reviews enable row level security;
