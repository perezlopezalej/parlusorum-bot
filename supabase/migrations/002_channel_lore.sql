-- Solo documentación del esquema: SQL original ya ejecutado en Supabase.
create table if not exists public.channel_lore (
  id bigint generated always as identity primary key,
  channel text not null,
  term text not null,
  term_key text not null,
  kind text not null default 'meme',
  status text not null default 'pending',
  needs_approval boolean not null default false,
  streams_count int not null default 1,
  total_count int not null default 1,
  users text[] not null default '{}',
  users_count int not null default 0,
  missed_streams int not null default 0,
  last_seen timestamptz not null default now(),
  last_stream_id text,
  created_at timestamptz not null default now(),
  unique (channel, term_key)
);
alter table public.channel_lore enable row level security;
