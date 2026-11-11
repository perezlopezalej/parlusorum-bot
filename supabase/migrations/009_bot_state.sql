-- Estado del bot que debe sobrevivir a un reinicio de Render en mitad de un directo:
-- silencio, BRB, quién juega y contadores. Una sola fila (key = 'main'); el bot solo la usa
-- si pertenece al directo en curso (compara started_at) y la vacía al terminar el stream.
-- RLS activado y SIN políticas (el bot usa la clave secreta; ver 001).

create table if not exists public.bot_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.bot_state enable row level security;
