-- Registro del chat (usuarios y bot). Retención: 60 días (borrado diario desde el bot).
create table if not exists public.chat_log (
  id                bigint generated always as identity primary key,
  created_at        timestamptz not null default now(),
  session_id        bigint,
  username          text not null,
  message           text not null,
  is_bot            boolean not null default false,
  origin            text,
  model             text,
  used_buscar_juego boolean not null default false,
  latency_ms        integer
);

create index if not exists chat_log_created_at_idx on public.chat_log (created_at);
create index if not exists chat_log_session_idx    on public.chat_log (session_id, created_at);

-- RLS activado sin políticas: solo accede la clave secreta (service role)
alter table public.chat_log enable row level security;
