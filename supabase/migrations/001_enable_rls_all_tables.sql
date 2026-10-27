-- Solo documentación del esquema: ya aplicado en Supabase.
-- RLS activado en todas las tablas y SIN políticas: el bot usa la clave secreta
-- (service role), que se salta RLS; anon/authenticated no pueden leer ni escribir.
-- No añadir políticas permisivas ni volver a la clave anon.

alter table public.users              enable row level security;
alter table public.stream_sessions    enable row level security;
alter table public.stream_memory      enable row level security;
alter table public.stream_highlights  enable row level security;
alter table public.channel_stats      enable row level security;
alter table public.channel_config     enable row level security;
alter table public.cooldowns          enable row level security;
alter table public.user_facts         enable row level security;
alter table public.channel_lore       enable row level security;
