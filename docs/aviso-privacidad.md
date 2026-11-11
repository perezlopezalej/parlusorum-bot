# Aviso de privacidad — Dios Fua (bot del canal parlusorum)

Este aviso explica qué datos guarda el bot del canal de Twitch **parlusorum**, durante cuánto tiempo, quién los procesa y cómo borrarlos. Última revisión: 11 de noviembre de 2026.

> No es asesoramiento jurídico. Los puntos marcados «a verificar» deben comprobarse contra las fuentes oficiales antes de darlos por buenos.

## Quién es el responsable

Los streamers del canal parlusorum (Manu y Pao), que son quienes deciden para qué se usa el bot. Contacto: cualquier mod del canal o un susurro a la cuenta del canal en Twitch.

## Qué se guarda y cuánto tiempo

| Dato                        | Qué contiene                                                                                                                                                                                                                               | Cuánto tiempo                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| **Chat completo**           | Tu nick, tu ID de Twitch y tus mensajes (y a quién respondes)                                                                                                                                                                              | **24 horas**, con borrado automático cada hora |
| **Registro de calidad**     | Mensajes del bot con unas líneas de contexto antes y después, **con los nombres sustituidos por `usuario1`, `usuario2`…**, y métricas del stream. No guarda tu nick ni tu ID: solo una huella irreversible para poder borrarlo si lo pides | **30 días**                                    |
| **Ficha de usuario**        | ID de Twitch, nick, primera y última vez que escribiste, nº de mensajes y logros                                                                                                                                                           | **1 año** sin actividad (contador de mensajes) |
| **Datos útiles**            | «Habitual» y último juego que viste, por ID de Twitch                                                                                                                                                                                      | **90 días** sin actualizar                     |
| **Contadores de la trivia** | Victorias, por ID de Twitch                                                                                                                                                                                                                | **1 año** sin actividad                        |
| **Memoria del canal**       | Resúmenes de cada stream, **sin nicks** (aparecen como «un espectador»)                                                                                                                                                                    | Sin límite: no contienen datos personales      |
| **Lore del canal**          | Chistes y expresiones del chat, solo con la aprobación de un mod; guarda los ID (no nicks) de quienes los usaron                                                                                                                           | Mientras un mod lo mantenga                    |
| **Registros del servidor**  | El log de Render puede contener extractos de mensajes                                                                                                                                                                                      | Según Render                                   |

Lo que **no** se guarda: frases literales tuyas en la memoria entre streams, tu correo, tu IP ni datos de pago.

## Quién procesa los datos

- **Groq (EE. UU.)**: la IA del bot. Recibe fragmentos del chat para generar respuestas, con los nicks sustituidos por `user1`, `user2`… antes de enviarlos. Tiene activado _Zero Data Retention_ (el proveedor no conserva las peticiones). Groq no ofrece región europea. _A verificar:_ los términos de Groq sobre entrenamiento y retención (los documentos oficiales se resumen en `docs/investigacion-buenas-practicas.md`, §8).
- **Supabase**: base de datos donde se guardan los datos anteriores.
- **Render**: alojamiento del bot.
- **Twitch**: de donde proceden los datos (chat, ID, eventos del canal).

## Base legal

**Interés legítimo** (art. 6.1.f del RGPD): ofrecer un bot de chat, juegos y alertas en un canal público, y mejorar su calidad. Hemos ponderado el impacto: el chat ya es público en Twitch; el chat completo solo se guarda 24 horas; lo que dura más es mínimo, va por ID, está caducado y se puede borrar cuando quieras; y puedes oponerte. _A verificar:_ la redacción literal de los artículos 5, 6, 17 y 21 del RGPD en EUR-Lex y el Dictamen 28/2024 del EDPB.

## Tus derechos y cómo borrar tus datos

- **Borra todo lo tuyo ahora mismo:** escribe `!fua_olvidame` en el chat. Se borran el chat, el registro de calidad donde participaste, tu ficha, tus datos útiles y contadores, tu nombre en las memorias y el lore que te mencione. Si sigues escribiendo, el bot empieza de cero con lo mínimo imprescindible (ficha con tu ID).
- **Que lo haga un mod por ti:** `!fua_olvidar @usuario` (solo mods).
- **Resumen en el chat:** `!privacidad`.
- Si prefieres que el bot no guarde nada de ti, escribe a un mod; la opción más simple es usar `!fua_olvidame` cuando quieras.
- Si no estás conforme, puedes reclamar ante la Agencia Española de Protección de Datos (aepd.es).

Limitaciones: el lore manual escrito a mano en el repositorio y las copias locales de los administradores (`backups/`, `logs/`) no se borran con el comando; los mods las eliminan a petición tuya. El bot no está dirigido a menores; Twitch admite usuarios desde 13 años.

---

## Texto corto para el panel del canal (≤ 300 caracteres)

```
🔒 Dios Fua (el bot) guarda el chat 24 h y un registro de calidad con nombres anónimos 30 días. Datos útiles por ID de Twitch: 90 días sin actividad (contadores, 1 año). IA: Groq (EE. UU., sin retención). Base: interés legítimo. Borra todo con !fua_olvidame · Info: !privacidad
```
