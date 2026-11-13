# Datos de `src/ai/quality/`

## `es-frecuentes.txt`

Las palabras más frecuentes del español, de más a menos frecuente. La usa `copy.js` para distinguir una palabra corriente de una poco común: la regla `copia` (un mensaje del bot repite palabras del chat; poco común = posición 5000 o más) y la regla `inventado` (palabras que no salen de los hechos, del juego ni del canal; poco común = posición 30000 o más o ausente).

- **Origen**: las 30000 primeras líneas de `content/2018/es/es_50k.txt` del proyecto [FrequencyWords](https://github.com/hermitdave/FrequencyWords) de Hermit Dave, calculado sobre el corpus [OpenSubtitles2018](http://opus.nlpl.eu/OpenSubtitles2018.php) (subtítulos de opensubtitles.org).
- **Licencia del origen**: el README del proyecto indica «MIT License for code. CC-by-sa-4.0 for content» (consultado el 12-11-2026).
- **Cambios hechos**: se quitan las cifras de frecuencia, todo va en minúsculas y sin tildes (la ñ se conserva), y se eliminan los duplicados y lo que no son letras. Quedan 28559 palabras; el orden (la línea) es la frecuencia.
- **Licencia de este fichero**: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.es), la misma que el origen. Si se redistribuye o se modifica, hay que mantener esta atribución y la misma licencia. El resto del repositorio no cambia de licencia: el código solo lee la lista.

Para regenerarla: descargar `es_50k.txt`, quedarse con las 30000 primeras líneas y aplicar los cambios de arriba.
