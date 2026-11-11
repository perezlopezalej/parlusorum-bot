# Presupuesto de tokens de Groq

Referencia movida de PROGRESS.md (11-11). Reparto de tipos por modelo y consumo estimado de un directo de 6 h; los límites son por modelo (8.000 tokens/min, 200.000/día, 1.000 peticiones/día).

- **Caché de Groq (documentación, consultada 11-11)**: solo `openai/gpt-oss-20b`/`120b`/`safeguard-20b` (qwen no); prefijo mínimo de 128 a 1.024 tokens según el modelo; 50 % de descuento en los tokens cacheados; caducan a las 2 h sin uso; «los tokens cacheados no cuentan para los límites de uso» (TPM), pero **la página no dice nada del límite diario (TPD)**. Prueba real con un prefijo idéntico de 3.400 tokens: la respuesta no trae `cached_tokens`, así que no se pudo confirmar ningún acierto. Por eso el presupuesto de abajo **no cuenta con la caché** (lo que llegue es margen). Los prefijos fijos de los prompts (identidad + forma) son de ~150 tokens: probablemente por debajo del mínimo.
- **Presupuesto de tokens, directo de 6 h (límites por modelo: 8.000/min, 200.000/día, 1.000 peticiones/día)**. Tokens por llamada medidos (`logs/comparativa-modelos.md` y los evals): cohost ~620 (generación), selector ~750, mención ~1.260, `!dios_fua` con ficha ~1.200, factcheck ~300-500, alerta/hook/timer ~700-800, trivia/comando ~500-600. Ritmo por hora de un directo normal: cohost 8 comentarios (×1,3 llamadas), `!dios_fua` 6, menciones/provocaciones 10, reacciones 3, `!quemeperdi` 2, trivia 3, comandos 3, alertas 6, hooks 4, timer 2, fin de stream 1 (~6k).

| Modelo | Tipos | Tokens/hora | 6 h | % de 200k |
|---|---|---|---|---|
| gpt-oss-120b | cohost 6,4k · `!dios_fua` 7,2k · reacciones 1,5k · `!quemeperdi` 1,8k | ~17k | ~101k | 51 % |
| gpt-oss-20b | menciones 12,6k · revisiones (cohost, juego, mención) ~6,9k · selector del timer 1,5k | ~21k | ~126k | 63 % |
| qwen3.8-27b | selector del cohost 7,8k · alertas 4,2k · hooks 2,8k · timer 1,6k · trivia 1,8k · comandos 1,5k (+ fin de stream 6k una vez) | ~20k | ~124k | 62 % |

Directo muy movido (×1,7 en todo): 120b ~172k (86 %), 20b ~214k y qwen ~211k (algo por encima: las cadenas se reparten lo que sobre entre los otros dos, que tendrían ~30k libres cada uno; el 120b y el resto de modelos cubren ese margen sin que haga falta llegar al final del día). Antes de este reparto el 120b llevaba todo (~60k/h → ~360k en 6 h, el doble de su cupo). Por minuto: el pico de la estimación anterior (~12k pedidos al 120b) ahora se reparte en tres modelos con 8.000/min cada uno.
