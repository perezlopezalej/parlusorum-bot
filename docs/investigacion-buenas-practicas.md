# Dios Fua, cohost con IA para Twitch: qué dicen la documentación oficial, la investigación y la práctica, y qué conviene cambiar

El diseño de Dios Fua va bien encaminado en calidad: prompts en positivo, ejemplos rotativos, prohibiciones en código, varios candidatos con selector y eval sobre chatlogs reales coinciden con lo que recomiendan Anthropic, Google, OpenAI y la investigación reciente. El riesgo más urgente no es la calidad, sino el cumplimiento: los términos de Gemini (en vigor desde el 23 de marzo de 2026) dicen que solo se pueden usar servicios de pago para ofrecer clientes de la API a usuarios del Espacio Económico Europeo, y el bot atiende a un público español. A eso se suman las cláusulas de almacenamiento de datos de Twitch y el RGPD, que afectan a la memoria entre streams.

## TL;DR

- **Primero el cumplimiento, luego la calidad.** El nivel gratuito de Gemini no está permitido para servir a usuarios del EEE. Además, guardar chat más de 24 horas y enviarlo a terceros choca con la redacción del Developer Agreement de Twitch, y el RGPD exige minimizar, limitar la retención y atender las solicitudes de supresión. Hay que pasar Gemini a pago o sacarlo del router, publicar un aviso de privacidad, recortar la retención y seudonimizar la memoria.
- **La arquitectura de calidad es la correcta y hay que profundizar en ella.** Funciona mantener las reglas en código y no en el prompt, sacar varios candidatos, inyectar aleatoriedad desde el código y evaluar con casos reales. Falta: contexto corto y priorizado (las instrucciones clave al final), datos de juego verificados como única fuente de hechos, salida estructurada (JSON) con un campo "no tengo dato" o "callar", y un selector comparativo que corrija los sesgos del juez.
- **Saber callar es la decisión de diseño más importante para un cohost.** La investigación sobre agentes proactivos en chats de grupo muestra que intervenir demasiado resulta disruptivo. Lo recomendable es una arquitectura de dos pasos: primero un modelo pequeño o reglas en código deciden si se habla, y solo entonces se genera el mensaje. Debe haber presupuestos de mensajes por ventana, prioridad a los eventos sobre los temporizadores y una regla dura de no responder a conversaciones entre usuarios salvo mención.

## Cómo leer este informe

Cada sección separa tres tipos de fuente:

- **[Oficial]:** documentación de Anthropic, OpenAI, Google, Twitch, OWASP, EDPB o texto legal.
- **[Investigación]:** artículos revisados por pares o preprints.
- **[Comunidad]:** foros, blogs, productos y prácticas no oficiales.

Las recomendaciones propias van marcadas como tales. Algunos datos (límites de Groq, condiciones exactas del Developer Agreement de Twitch) proceden de fuentes secundarias o de extractos, y se indica cuando es así.

---

## 1. Cómo funcionan los LLM en la práctica y qué implica para los prompts

**Hallazgos clave**

- **[Oficial] Anthropic** describe el contexto como un "presupuesto de atención" finito. Su guía de *context engineering* (septiembre de 2025) adopta el término *context rot*: a medida que crece el número de tokens en la ventana de contexto, disminuye la capacidad del modelo para recordar con precisión esa información. Explica que la arquitectura transformer crea relaciones por pares entre todos los tokens, de modo que la atención "se estira". Su principio rector es buscar el conjunto más pequeño posible de tokens de alta señal que maximice la probabilidad del resultado deseado.
- **[Investigación] "Lost in the Middle"** (Liu et al., TACL 2024) muestra que el rendimiento cae de forma significativa al cambiar la posición de la información relevante. Suele ser peor cuando esa información está en mitad de un contexto largo. Por tanto, lo que va al principio y al final del prompt pesa más.
- **[Investigación] Instrucciones negativas y efecto "elefante rosa":**
  - Jang et al. (2023) evaluaron 9 tareas con prompts negados y vieron que los modelos más grandes rendían peor con ellos.
  - El trabajo "Suppressing Pink Elephants with Direct Principle Feedback" (2024) documenta que mencionar un tema en el prompt hace más probable que el modelo lo mencione, incluso cuando se le ordena no hacerlo.
  - Un preprint de 2025 ("Don't Think of the White Bear") observa un "rebote irónico" tras instrucciones del tipo "no menciones X": X aparece más, y la causa son cabezas de atención intermedias que amplifican el token prohibido bajo carga cognitiva.
  - Matiz: hay trabajos de 2026 según los cuales los modelos actuales manejan bien la negación en contexto en casos simples. El riesgo crece con prompts largos y cargados.
- **[Oficial] Temperatura en Gemini 3:** la guía para desarrolladores de Gemini 3 dice: "para todos los modelos Gemini 3, recomendamos encarecidamente mantener el parámetro de temperatura en su valor por defecto de 1.0"; bajarla "puede provocar un comportamiento inesperado, como bucles o rendimiento degradado". Es justo lo contrario de la costumbre de 2023 de bajar la temperatura para "controlar" al modelo.
- **[Investigación] Por qué repiten:**
  - El paper de *Verbalized Sampling* (Zhang et al., 2025, con Manning entre los autores) atribuye el *mode collapse* de los modelos alineados a un "sesgo de tipicidad" en los datos de preferencias: los anotadores prefieren el texto familiar, y eso empuja al modelo hacia la respuesta más típica.
  - Hay un caso extremo en humor: en 2023, Jentzsch y Kersting (WASSA 2023) vieron que 909 de 1.008 chistes generados por ChatGPT eran idénticos a uno de los 25 más frecuentes, y solo los cuatro primeros sumaban más de la mitad.

**Qué significa para el bot Dios Fua**

- Las "frases grandilocuentes" y las "fórmulas repetidas" no son un fallo de tu prompt. Es el modo por defecto de un modelo alineado. Se combaten desde fuera del modelo, con aleatoriedad inyectada, candidatos y filtros, como ya haces.
- Mantén el prompt de cada llamada corto. Pon la identidad y el estilo al principio, y la tarea concreta junto con el evento actual al final. El historial de chat y el lore van en medio y recortados. Nunca metas todo el lore: recupera solo lo relevante para ese evento.
- Elimina del prompt cualquier mención literal de lo que no quieres, como "no digas 'épico'" o "no uses 'pana'". Esas listas ya viven en el código como filtro posterior, que es su sitio correcto.
- Para Gemini 3.x Flash Lite, deja la temperatura en 1.0 y busca la variedad con la composición del prompt, no subiendo la temperatura. Que esta recomendación de la familia Gemini 3 se aplique tal cual a la versión 3.5 es una inferencia. Para gpt-oss y Qwen en Groq, comprueba en la documentación de Groq qué parámetros de muestreo admite. Groq publica una lista de parámetros de OpenAI no soportados, así que no des por hecho que `frequency_penalty` o `presence_penalty` funcionan.

## 2. Prompt engineering y context engineering según la documentación oficial

**Hallazgos clave**

- **[Oficial] Anthropic (guía de buenas prácticas, 2026):**
  - "Di al modelo qué hacer en lugar de qué no hacer".
  - Explica *por qué* existe cada regla.
  - Usa de 3 a 5 ejemplos variados y realistas dentro de etiquetas `<example>`, para que el modelo no los confunda con instrucciones.
  - Las etiquetas XML ayudan a separar instrucciones, contexto, ejemplos y entradas variables. La propia Anthropic matiza que los modelos modernos las necesitan menos y que no son una barrera de seguridad.
  - Haz que el estilo del prompt se parezca a la salida deseada: menos markdown en el prompt produce menos markdown en la respuesta.
- **[Oficial] Google (Gemini 3):** pide instrucciones directas y claras. Con datos largos, coloca la pregunta al final, después del contexto. Si un prompt sigue ignorando un requisito, divídelo en pasos encadenados.
- **[Oficial] OWASP (LLM01:2025):** recomienda "definir y validar formatos de salida esperados" con código determinista.

**Qué significa para el bot Dios Fua**

- Estructura cada prompt con bloques etiquetados y con el contenido no fiable claramente delimitado: `<personaje>`, `<estilo>`, `<ejemplos>`, `<datos_juego>`, `<evento>`, `<chat_reciente>`.
- Convierte cada regla negativa que quede en el prompt en una instrucción positiva con su porqué. Por ejemplo, en lugar de "no uses metáforas raras", escribe: "Habla como un colega de Madrid comentando la partida en el sofá: frases cortas y referencias concretas a lo que acaba de pasar, porque el chat lee rápido".
- Para el español de España, la palanca más fuerte son los ejemplos. Usa ejemplos reales de Manu, Pao y el chat, con vosotros, "tío", "en plan", "flipar" y "mola", y un filtro en código que detecte marcadores latinoamericanos ("ustedes" con valor de vosotros, "chévere", "platicar", "carro", "computadora", "ahorita") y descarte el candidato o lo reescriba.
- Pide la salida en JSON con un esquema fijo, por ejemplo `{"hablar": bool, "mensaje": string, "usa_dato_juego": bool, "dato_id": string|null}`, y valídala en código. Así el modelo tiene una forma legítima de decir "mejor callo" o "no tengo dato".

## 3. Personalidad estable, humor y variedad

**Hallazgos clave**

- **[Investigación]** *Verbalized Sampling* propone pedir al modelo varias respuestas, cada una con su probabilidad estimada, y muestrear de esa distribución. En escritura creativa (poemas, relatos, chistes) aumenta la diversidad entre 1,6 y 2,1 veces frente al prompt directo y mejora un 25,7 % las valoraciones humanas, sin perder precisión ni seguridad. Además, los modelos más capaces se benefician más.
- **[Investigación]** La generación de humor sigue siendo difícil. Pedir "algo gracioso" sin restricciones tiende a producir plantillas memorizadas (Jentzsch y Kersting, 2023). Trabajos de 2025 y 2026 (HumorPlanSearch, SemEval-2026) apuestan por planificar estrategias de humor diversas, generar un conjunto amplio de candidatos e invertir el esfuerzo en *seleccionar* bien.
- **[Investigación] LLM como juez:** está sesgado. Prefiere la posición (el primer o el último candidato), la longitud (respuestas más largas) y sus propias salidas o las de su misma familia de modelos (Zheng et al., 2023, y varias encuestas de 2024 a 2026). El sesgo de posición se mitiga intercambiando el orden y promediando.
- **[Investigación]** El estudio "My Favorite Streamer is an LLM" (2025), una encuesta a 334 fans de Neuro-sama, encontró que el 83 % percibe una personalidad coherente y distintiva. La investigación de Jessa Lingel y Wanyan Wu (Annenberg, UPenn; New Media & Society, 2025), basada en 15 meses de observación, atribuye esa autenticidad en parte a que la comunidad co-construye al personaje ("las audiencias han co-creado su autenticidad") y a la transparencia de su desarrollador.

**Qué significa para el bot Dios Fua**

- Tu sistema de 3 candidatos más selector es esencialmente *best-of-n* con reranking, y está bien encaminado. Para que funcione mejor:
  - Que los 3 candidatos nazcan de "formas" distintas: pregunta retórica, pique amistoso a Manu o Pao, dato del juego, callback a un chiste interno. No basta con el mismo prompt tres veces.
  - Que el selector compare por pares con orden aleatorio y criterios explícitos y breves: concreto sobre lo que ha pasado, español de España, menos de 25 palabras, gracioso para esta comunidad.
  - Que el selector sea de otra familia que el generador. Si genera gpt-oss, juzga Gemini o Qwen. Esto reduce la autopreferencia.
  - Que pueda elegir "ninguno" y el bot se calle.
- Castiga la longitud en código, no en el juez. Penaliza o descarta los candidatos largos antes de juzgar, porque el juez tiende a premiar lo largo.
- La personalidad estable sale de una "biblia" corta del personaje (5-8 rasgos en positivo, muletillas propias, de qué se ríe y de qué no) y de un banco de ejemplos reales seleccionados por ti. No sale de reglas largas.
- Añade un registro de "fórmulas recientes" en código: los n-gramas de los últimos 50 mensajes del bot. Rechaza los candidatos que repitan estructura o arranque. Es la defensa más barata contra el *mode collapse*.

## 4. Cohost en directo: cuándo hablar y cuándo callar

**Hallazgos clave**

- **[Investigación]** "Proactive Conversational Agents with Inner Thoughts" (CHI 2025) propone que el agente genere "pensamientos" en paralelo y solo hable cuando su motivación intrínseca supera un umbral, en lugar de limitarse a predecir turnos.
- **[Investigación]** En el estudio Koala (IUI 2025), al menos la mitad de los participantes dijo que la variante proactiva se entrometía demasiado; uno la describió como "demasiado habladora, tanto en longitud de mensaje como en frecuencia". Los participantes querían poder alternar entre el modo proactivo y el reactivo. Conclusión del estudio: no hay un punto óptimo único, así que hacen falta controles ajustables.
- **[Investigación]** LlamaPIE (ACL Findings 2025) usa una arquitectura de dos modelos: uno pequeño decide *cuándo* responder y uno grande genera *qué* decir. "Time to Talk" (EMNLP Findings 2025) usa un "prompt planificador" que se ajusta si el agente habla más o menos que los demás participantes.
- **[Investigación]** "Read the Room" (CHI 2026) estudia cuándo es apropiado que un agente intervenga en chats de grupo que mezclan charla casual y tareas.
- **[Oficial] Twitch:**
  - Límites de mensajes: 20 mensajes cada 30 segundos para cuentas normales y 100 si la cuenta es broadcaster, moderador o VIP.
  - Si se excede el límite, Twitch ignora los mensajes del bot durante 1 hora.
  - Los bots que usan la API *Send Chat Message* con un token de aplicación y el permiso `channel:bot` (o con estatus de moderador) muestran la insignia oficial de "Chat Bot".
- **[Comunidad]** Neuro-sama, el caso más exitoso, funciona con un equipo humano que monitoriza y modera, y con un filtro de salida. Según Kotaku (enero de 2023), el canal fue baneado dos semanas por "conducta de odio" después de que Neuro-sama dijera sobre el Holocausto "I'm not sure if I believe it" (28 de diciembre de 2022, según Anime News Network).

**Qué significa para el bot Dios Fua**

- Implementa una decisión de "hablar o callar" separada de la generación, con reglas en código y, si hace falta, el modelo pequeño (gpt-oss-20b). Entradas sugeridas:
  - Tipo de evento: muerte, jefe, sub, raid o mención.
  - Tiempo desde el último mensaje del bot.
  - Velocidad del chat.
  - Si los streamers están hablando de algo serio.
  - Un presupuesto por ventana. Recomendación propia de partida: 1 intervención espontánea cada 3-5 minutos como máximo, y ninguna si el chat va muy rápido.
- Da prioridad a los eventos sobre los temporizadores. El resumen de cada media hora y las preguntas al chat deberían cancelarse si ha habido mucha actividad reciente del bot o si el momento no encaja.
- Regla dura en código: no responder a mensajes dirigidos a otro usuario (que empiecen por @otro o formen parte de un intercambio entre dos personas en los últimos N mensajes) salvo que mencionen al bot. Esto resuelve lo de "meterse en conversaciones privadas" mejor que cualquier instrucción en el prompt.
- Da a Manu y Pao un control en vivo con comandos de moderador: `!fua_callate 10m`, `!fua_modo reactivo` y `!fua_modo normal`. Es la lección directa de Koala.
- Migra el envío a la API *Send Chat Message* con token de aplicación y `channel:bot` para obtener la insignia oficial de Chat Bot. Así el bot queda identificado sin ambigüedad. tmi.js por IRC no la obtiene.

## 5. Reducir alucinaciones

**Hallazgos clave**

- **[Oficial] Anthropic** recomienda permitir explícitamente que el modelo diga "no lo sé" y anclar las respuestas en documentos proporcionados. **Google** recomienda anclar el razonamiento a los datos proporcionados ("Basándote en la información anterior...").
- **[Oficial] OWASP** advierte de que ni el RAG ni el ajuste fino eliminan del todo los problemas de inyección, y recomienda validar la salida con código determinista.
- **[Investigación]** El LLM-juez tiene sesgos (ver el tema 3) y puede pasar por alto errores factuales. No sirve como única verificación de hechos.

**Qué significa para el bot Dios Fua**

- Los datos de IGDB deben ser la *única* fuente de hechos sobre juegos. Pásalos como una ficha breve con IDs (`<datos_juego>`) y exige en el JSON que el mensaje declare qué dato usa (`dato_id`).
- Verificación en código: si el mensaje contiene nombres propios, cifras o fechas que no aparecen en la ficha ni en el chat reciente, descártalo o reescríbelo sin el dato.
- Cuando no haya ficha (juego indie raro o fallo de IGDB), cambia la "forma" del mensaje a una que no necesite hechos: reacción, pique o pregunta al chat. Es mejor eso que confiar en que el modelo se contenga.
- Para !dios_fua, si la pregunta es factual y no hay dato, la respuesta correcta es una salida con gracia del tipo "ni idea, pregúntale al chat". Inclúyela entre los ejemplos.

## 6. Evaluación de calidad

**Hallazgos clave**

- **[Oficial] OpenAI** recomienda:
  - Desarrollo guiado por evals: evaluar pronto y a menudo.
  - Evaluación continua en cada cambio, vigilando el no determinismo.
  - Hacer crecer el conjunto de evaluación con casos reales.
  - Evitar el "diseño sesgado", es decir, conjuntos que no reproducen el tráfico real.
  - Con jueces LLM: rúbricas claras y razonamiento antes de la nota.
  - Vigilar el *grader hacking*, contrastando a los jueces de modelo con evaluaciones humanas.
- **[Comunidad]** Guías de práctica recomiendan separar el conjunto de desarrollo del de validación para detectar sobreajuste.

**Qué significa para el bot Dios Fua**

- Tu eval con IA real sobre chatlogs es la práctica correcta. Mejoras concretas:
  - Divide los casos en "dev" (los que miras al ajustar prompts) y "holdout" (los que solo ejecutas antes de desplegar).
  - Ejecuta cada caso 3-5 veces y mide tasas, por ejemplo "el 80 % de las ejecuciones pasa el filtro de español de España". Un único aprobado o suspenso no vale con modelos no deterministas.
  - Mezcla métricas deterministas (longitud, marcadores latinoamericanos, n-gramas repetidos, datos inventados frente a la ficha IGDB, tasa de silencio) con una rúbrica de juez comparativo.
  - Calibra el juez con 30-50 pares que tú hayas puntuado a mano.
- Mide reacciones reales en el chat:
  - Respuestas o menciones al bot en los 60 segundos siguientes.
  - Emotes de risa (KEKW, LUL, "jajaja") tras un mensaje del bot.
  - Comandos `!fua_callate` usados por los streamers, como señal negativa fuerte.
  - Guarda estas métricas agregadas, no los mensajes.

## 7. Seguridad: inyección de prompts, moderación e identidad

**Hallazgos clave**

- **[Oficial] OWASP LLM01:2025:** la inyección de prompts sigue siendo el riesgo número 1. Medidas recomendadas:
  - Restringir el comportamiento del modelo.
  - Validar los formatos de salida con código.
  - Filtrar la entrada y la salida.
  - Aplicar mínimo privilegio.
  - Segregar y etiquetar el contenido externo.
  - Hacer pruebas adversarias.
  - "Implementar guardarraíles fuera del propio LLM".
  - OWASP reconoce que ninguna medida la evita del todo.
- **[Oficial] Twitch Developer Agreement:** prohíbe diseñar bots que incurran en prácticas ofensivas o engañosas, como discurso de odio o spam.
- **[Oficial] Google:** los términos de Gemini prohíben intentar eludir sus filtros de seguridad y hacen al desarrollador responsable de configurarlos.

**Qué significa para el bot Dios Fua**

- Trata todo mensaje del chat como dato, nunca como instrucción. Mételo en `<chat_reciente>` con el nombre de usuario seudonimizado y elimina antes los caracteres invisibles, las URLs y los fragmentos tipo "ignora las instrucciones". Las etiquetas ayudan, pero no son una frontera de seguridad.
- El bot no tiene herramientas peligrosas (no banea ni ejecuta nada), y esa es su mejor defensa. Mantenlo así: ninguna acción de moderación debe decidirla un LLM.
- Filtro de salida en código antes de enviar:
  - Lista de términos ofensivos.
  - Ausencia de URLs.
  - Ausencia de nombres de usuarios que no estén en el chat.
  - Longitud máxima.
  - El mensaje no repite literalmente el texto de un usuario (los ataques suelen buscar que el bot "diga" algo).
  - Opcionalmente, el endpoint de moderación de algún proveedor.
- Defensa de identidad: el personaje vive en el prompt de sistema y en los ejemplos. Además, si un candidato habla de "mis instrucciones", "soy un modelo de lenguaje" o cambia de idioma o nombre, el filtro lo descarta.
- Haz pruebas adversarias periódicas en el eval con mensajes reales de inyección.

## 8. Privacidad y normativa

**Hallazgos clave**

- **[Oficial] Gemini API Additional Terms** (en vigor desde el 23 de marzo de 2026):
  - "Solo puedes usar Servicios de Pago cuando pongas Clientes de API a disposición de usuarios del Espacio Económico Europeo, Suiza o el Reino Unido".
  - Para el EEE se aplican a todos los servicios, incluido el gratuito, los términos de uso de datos de pago: los prompts no se usan para mejorar productos.
  - El uso es "para fines profesionales o empresariales, no de consumo".
  - No se puede usar en servicios "dirigidos a, o con probabilidad de ser accedidos por, menores de 18 años".
  - En los servicios no pagados, piden expresamente no enviar información personal.
- **[Oficial/secundaria] Groq:**
  - Según el Groq Services Agreement (sección 4.2, citado por fuentes secundarias), Groq no puede usar entradas ni salidas para entrenar.
  - No retiene la inferencia por defecto, aunque puede registrarla hasta 30 días por fiabilidad o abuso.
  - Ofrece un interruptor de "Zero Data Retention" en Data Controls.
  - No ofrece región europea dedicada.
- **[Oficial] Twitch Developer Services Agreement** (extractos del texto oficial; la última revisión anunciada es de noviembre de 2023):
  - "No almacenes copias de Contenido de Twitch [...] salvo que [...] (c) lo guardes en caché solo durante un periodo de veinticuatro horas sin compartirlo con terceros".
  - Hay que borrar los datos de un usuario "a petición de Twitch o del usuario final".
  - Hay que respetar los controles y el consentimiento del usuario al decidir si se guardan sus datos.
  - En la versión de 2019 constaba además la obligación de tener una política de privacidad pública.
- **[Comunidad]** En septiembre de 2026, un desarrollador de un "AI companion" preguntó en el foro de desarrolladores de Twitch si podía guardar la memoria por ID de usuario más de 24 horas y enviar el chat a OpenAI. No hubo respuesta oficial de Twitch. Un moderador veterano del foro recomendó consultar a un abogado y señaló que ofrecer la supresión es necesario por el RGPD.
- **[Oficial] RGPD y EDPB:**
  - Se aplican la minimización (art. 5.1.c), la limitación del plazo de conservación (art. 5.1.e), el interés legítimo como base posible (art. 6.1.f), el derecho de supresión (art. 17) y los contratos con encargados (art. 28). La redacción literal de estos artículos debe verificarse en EUR-Lex.
  - El Dictamen 28/2024 del EDPB admite el interés legítimo para un "agente conversacional", pero solo si el tratamiento es estrictamente necesario y supera la ponderación de derechos. Entre otros factores, pesa si los usuarios esperan razonablemente ese uso.
  - Un bot en un canal público difícilmente encaja en la excepción doméstica del art. 2.2.c. Es una inferencia.
  - No he localizado guía específica de la AEPD.

**Qué significa para el bot Dios Fua**

- **Gemini gratuito:** tal como están redactados, los términos no permiten usar el nivel gratuito para un bot que sirve a espectadores en España. Hay dos opciones: activar facturación (Gemini 3.x Flash Lite cuesta muy poco con este volumen y pasa a estar cubierto por el acuerdo de tratamiento de datos de Google) o sacar Gemini del router y quedarte con Groq. La restricción de menores de 18 años es otro riesgo, porque Twitch admite usuarios desde los 13. No hay interpretación oficial para este caso. Recomendación propia: deja de enviar chat a Gemini gratuito ya.
- **Groq:** activa Zero Data Retention en la consola. Coste cero y mejora de privacidad inmediata.
- **Retención de chat:** guarda los mensajes crudos un máximo de 24 horas (encaja con la cláusula de Twitch y con la minimización). Lo que perdure entre streams deben ser resúmenes sin mensajes literales y, en lo posible, sin datos personales.
- **Memoria por usuario:** seudonimiza con un hash del user ID, no con el nombre. Guarda solo hechos útiles y no sensibles ("habitual", "chiste interno del pato"). Pon una caducidad, por ejemplo de 90 días sin actividad. Ofrece `!fua_olvidame`, que borre todo lo asociado a ese usuario. Lo ideal sería que la memoria individual fuese voluntaria (`!fua_recuerdame`).
- **Transparencia:** publica en el panel del canal un aviso breve de privacidad que explique qué se guarda, cuánto tiempo, qué proveedores lo procesan (Groq, en EE. UU.), cómo borrarlo y la base legal (interés legítimo, con ponderación documentada).
- **Envío a terceros:** la cláusula de Twitch sobre compartir datos con terceros sin permiso es ambigua respecto a usar un proveedor de LLM como encargado del tratamiento. No hay aclaración oficial pública. Minimiza lo que envías: el texto reciente necesario, sin IDs y sin nombres reales.

## 9. Ingeniería y fiabilidad en planes gratuitos

**Hallazgos clave**

- **[Secundaria, citando la documentación de Groq]** El nivel gratuito de gpt-oss-120b, gpt-oss-20b y Qwen 3.x 27B tiene unos límites de 30 peticiones por minuto, 1.000 al día, 8.000 tokens por minuto y 200.000 al día, *por modelo y por organización*. Los tokens cacheados no cuentan para los límites. Las cabeceras `x-ratelimit-*` indican el saldo restante, y la propia Groq dice que la página de límites de cada cuenta es la autoridad.
- **[Comunidad]** Con unos 2.000 tokens por llamada, gpt-oss-120b no da para 1.000 llamadas diarias: lo que se agota primero son los tokens por minuto y por día.
- **[Oficial] Gemini** puede rebajar los límites o suspender el acceso por incumplimientos.

**Qué significa para el bot Dios Fua**

- Haz las cuentas. Si cada intervención con 3 candidatos y un selector cuesta unos 4 × 2.000 tokens, 8.000 TPM equivalen a una intervención por minuto como máximo por modelo, y 200.000 TPD a unas 25 intervenciones completas al día por modelo. La decisión de "callar" barata, con reglas antes del LLM, ahorra cupo además de mejorar la calidad.
- Para aprovechar la caché de prompts, el prefijo del prompt (personaje y estilo) debe ser idéntico entre llamadas. Pon la aleatoriedad (ejemplos rotativos y "forma") después del prefijo fijo.
- El router debe leer las cabeceras `x-ratelimit-*`, aplicar *backoff* con jitter ante los errores 429 y repartir la carga por funciones: el 20b para decidir y seleccionar, y el 120b o el Qwen para generar. Si no queda cupo, el bot calla en lugar de usar un modelo peor.
- Observabilidad mínima en Supabase:
  - Por llamada: proveedor, modelo, tokens, latencia, error, candidato elegido y motivo de descarte del filtro.
  - Un panel con la tasa de descarte por filtro, que muestra si los filtros eliminan respuestas buenas.
  - Sin guardar el texto del chat más allá de las 24 horas.
- En Render gratuito, el servicio se duerme cuando no hay tráfico y tarda en arrancar. Un bot de chat necesita estar despierto durante el directo. Programa un ping o un despertador al empezar el stream mediante EventSub `stream.online`. Esta es una práctica de la comunidad; verifica las condiciones actuales de Render.

## 10. Memoria a largo plazo

**Hallazgos clave**

- **[Oficial] Anthropic** recomienda recuperar el contexto "justo a tiempo" en lugar de cargarlo todo, y advierte de que una compactación demasiado agresiva pierde matices.
- **[Investigación]** El *context rot* y el "lost in the middle" penalizan los resúmenes largos acumulados.
- **[Comunidad]** Los proyectos de compañeros de IA para streaming combinan memoria a corto plazo con memoria a largo plazo resumida o recuperada.

**Qué significa para el bot Dios Fua**

- Separa tres memorias:
  - **Lore curado:** chistes internos y apodos aprobados por Manu, Pao o los moderadores. Es la fuente de verdad.
  - **Resumen por stream:** generado al final, revisable y corto, con hechos con fecha.
  - **Notas por usuario:** seudonimizadas y con caducidad.
- El "lore aprendido" automático no debería entrar en producción sin revisión humana, porque así se cuelan alucinaciones, datos personales y bromas que alguien no quiere. Lo recomendable es una cola de "propuestas de lore" que los moderadores aprueban con un comando.
- Para no inventar recuerdos, el resumen de fin de stream debe extraer solo lo que aparece en los eventos registrados (muertes, jefes, raids, juego), no lo que el modelo "cree" que pasó. Valídalo en código contra el registro de eventos.
- Recupera 1-3 elementos de memoria relevantes por intervención (por juego, por usuario mencionado o por palabra clave) y colócalos cerca del final del prompt.

---

## Recomendaciones priorizadas

| # | Recomendación | Impacto | Esfuerzo | Estado actual |
|---|---|---|---|---|
| 1 | Dejar de usar Gemini gratuito para el chat del EEE: activar facturación o sacarlo del router | Muy alto (cumplimiento de términos) | Bajo | **Falta. Riesgo prioritario** |
| 2 | Activar Zero Data Retention en Groq | Alto (privacidad) | Muy bajo | Falta |
| 3 | Retención máxima de 24 h para los mensajes crudos; memoria seudonimizada, con caducidad y `!fua_olvidame` | Muy alto (RGPD y Twitch) | Medio | Falta |
| 4 | Aviso de privacidad público en el panel del canal | Alto | Bajo | Falta |
| 5 | Filtro de salida en código (ofensivo, URLs, eco literal, identidad) y entrada saneada y etiquetada como dato | Alto (seguridad y normas de Twitch) | Bajo-medio | Parcial (hay filtros de calidad) |
| 6 | Decisión "hablar o callar" separada, con presupuesto por ventana y regla dura anti-conversaciones privadas | Muy alto (experiencia) | Medio | Parcial |
| 7 | Comandos de control en vivo para los streamers (`!fua_callate`, modo reactivo) | Alto | Bajo | Falta |
| 8 | Salida JSON validada con `hablar` y `dato_id`; verificar en código los hechos frente a la ficha de IGDB | Alto (alucinaciones) | Medio | Parcial (hay IGDB) |
| 9 | Selector comparativo de otra familia de modelos, con orden aleatorio, penalización de longitud en código y opción "ninguno" | Medio-alto | Bajo | Bien encaminado (3 candidatos) |
| 10 | Prompt corto con prefijo fijo (caché), tarea y evento al final, lore recuperado y no completo | Medio-alto (calidad y cupo) | Bajo | Bien encaminado (prompts en positivo) |
| 11 | Registro de n-gramas recientes y "formas" distintas por candidato | Medio | Bajo | Bien encaminado (formas al azar) |
| 12 | Eval con división dev/holdout, 3-5 ejecuciones por caso, juez calibrado con notas humanas y métricas de reacción del chat | Medio-alto | Medio | Bien encaminado (eval con chatlogs) |
| 13 | Migrar el envío a la API Send Chat Message con `channel:bot` (insignia de Chat Bot) | Medio (identificación y normas) | Medio | Falta (tmi.js) |
| 14 | Router con lectura de `x-ratelimit-*`, backoff, reparto por funciones y "callar si no hay cupo"; panel de tasa de descarte | Medio | Medio | Parcial |
| 15 | Lore aprendido solo vía cola de aprobación de moderadores | Medio (calidad y privacidad) | Bajo | Falta |

**Qué está bien encaminado:** las instrucciones en positivo con ejemplos rotativos, las prohibiciones en código, los 3 candidatos con selector, la aleatoriedad elegida por el código y la eval con IA real sobre chatlogs. Todo ello coincide con la documentación oficial y con la investigación sobre *mode collapse* y sesgos de juez.

**Qué atender primero, por riesgo:** (1) Gemini gratuito con usuarios del EEE; (2) retención y memoria frente al RGPD y la cláusula de 24 h de Twitch; (3) filtro de salida y saneado de entrada, porque un mensaje ofensivo provocado por inyección es un riesgo directo para el canal según las normas de Twitch.

## Advertencias

- Los límites de Groq y algunas cláusulas del Developer Agreement de Twitch proceden de fuentes secundarias o de extractos. La redacción literal de los artículos del RGPD debe verificarse en EUR-Lex. Comprueba la página de límites de tu cuenta y el texto vigente de Twitch.
- Twitch no ha aclarado públicamente cómo se aplica su cláusula de 24 horas y de terceros a los bots con memoria y LLM externos. Las recomendaciones aquí son conservadoras, no una interpretación oficial. Este informe no es asesoramiento jurídico.
- No he encontrado guía específica de la AEPD. Las cifras de frecuencia (1 intervención cada 3-5 minutos) son un punto de partida propio, no un dato de la investigación, que precisamente concluye que el óptimo depende del grupo.
- Algunos resultados de investigación citados son preprints (Verbalized Sampling, rebote irónico) o estudios de laboratorio con contextos distintos a Twitch. Su transferencia es razonable, pero no está demostrada.