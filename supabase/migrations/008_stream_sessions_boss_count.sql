-- Jefes derrotados por stream (!boss), persistidos como las muertes. Ejecutar una vez en el SQL Editor de Supabase.
ALTER TABLE stream_sessions ADD COLUMN IF NOT EXISTS boss_count integer DEFAULT 0;
