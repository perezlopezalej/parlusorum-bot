-- Solo documentación del esquema: SQL original ya ejecutado en Supabase.
ALTER TABLE stream_sessions ADD COLUMN IF NOT EXISTS narrative jsonb;
