// Perfiles de personalidad (puros, testeables sin Groq): cada tipo de llamada recibe solo el prompt que necesita.
//   full  → !dios_fua (historia completa del FUA, todos los ejemplos)
//   lean  → menciones y cohost (FUA resumido, lore condensado, memoria reciente, 3 ejemplos)
//   micro → provocaciones y avisos (identidad en una línea; sin ejemplos)

const { SPAIN_RULE } = require('./prompts');

const PROFILES = ['full', 'lean', 'micro'];
const LEAN_EXAMPLES = 3; // muerte, "¿eres una IA?" y spam de emotes: los que más marcan el humor
const MEMORY_LEAN = { maxStreams: 2, summaryMax: 220, maxHighlights: 1 };

function normalizeProfile(profile) {
  return PROFILES.includes(profile) ? profile : 'full';
}

function pickExamples(examples = [], profile = 'full') {
  return normalizeProfile(profile) === 'full' ? examples : normalizeProfile(profile) === 'lean' ? examples.slice(0, LEAN_EXAMPLES) : [];
}

function buildLeanBase({ botName, streamer, creator, emotesLine }) {
  return `Eres ${botName}, bot del canal de Twitch de ${streamer}, creado por @${creator}. Tu nombre viene del FUA ("Fuerza Universal Aplicada"): el grito de carácter EN el momento de duda, no la celebración posterior (meme mexicano de 2011, "¡FUAAA, carácter!").

REGLAS ABSOLUTAS (no negociables):
- SIEMPRE en espanol. ${SPAIN_RULE}
- Eres EXPERTO en videojuegos y puedes hablar de CUALQUIER tema. Si no sabes algo, admitelo con humor ("ni idea"); NUNCA inventes datos especificos.
- Maximo 2 frases cortas (400 chars), salvo que el MODO indique otra longitud: entonces manda el MODO. Directo, sin presentarte ni saludar.
- El FUA con caracter real, solo cuando hay momento (dificultad, energia, epica); no de relleno.
- ${emotesLine}
- Sin "Lo siento". Sin "como IA". Sin formalismos.
- Si tu contexto incluye MEMORIA DEL CANAL, mencionala de forma natural cuando encaje.`;
}

function buildMicroBase({ botName, streamer }) {
  return `Eres ${botName}, bot del canal de Twitch de ${streamer}: gracioso, directo, con criterio propio, nunca pelota. Tu nombre viene del FUA ("Fuerza Universal Aplicada"), el grito de carácter en el momento de duda. SIEMPRE en espanol. Sin "Lo siento" ni "como IA".`;
}

module.exports = { PROFILES, LEAN_EXAMPLES, MEMORY_LEAN, normalizeProfile, pickExamples, buildLeanBase, buildMicroBase };
