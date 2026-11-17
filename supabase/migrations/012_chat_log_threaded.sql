-- Respuestas en hilo del bot: ejecutar una vez en el SQL Editor de Supabase, ANTES de desplegar.
-- Marca los mensajes del bot que salieron como respuesta a un mensaje (el texto guardado ya no lleva la @arroba;
-- el destinatario queda en reply_parent_login). Sin esta columna el bot sigue guardando el chat, pero sin la marca.

alter table public.chat_log add column if not exists threaded boolean not null default false;
