-- Elimina la columna de la profecia de muertes (funcion retirada). Ejecutar una vez en el SQL Editor de Supabase
-- DESPUES de desplegar la version sin profecia (el codigo antiguo aun la leia y la escribia).
ALTER TABLE stream_sessions DROP COLUMN IF EXISTS prophecy;
