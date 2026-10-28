-- Solo documentación del esquema: ejecutar una vez en el SQL Editor de Supabase.
ALTER TABLE stream_sessions ADD COLUMN IF NOT EXISTS prophecy jsonb;
