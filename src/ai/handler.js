const Groq = require('groq-sdk');

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// --- Límite de caracteres de Twitch ---
const TWITCH_MAX_LENGTH = 490;

function truncate(msg) {
  if (msg.length <= TWITCH_MAX_LENGTH) return msg;
  return msg.slice(0, TWITCH_MAX_LENGTH - 3) + '...';
}

// --- Sanitizar input del usuario ---
function sanitizeInput(text) {
  return text
    .slice(0, 200) // Máximo 200 chars de pregunta
    .replace(/[<>]/g, '') // Eliminar posibles inyecciones HTML
    .trim();
}

// --- Detector de hype ---
const hypeBuffer = [];

function detectHype(client, channel, message, config) {
  const now = Date.now();
  const { hype_threshold, hype_window_seconds, hype_messages } = config.personality;

  hypeBuffer.push(now);

  const windowMs = hype_window_seconds * 1000;
  while (hypeBuffer.length > 0 && hypeBuffer[0] < now - windowMs) {
    hypeBuffer.shift();
  }

  if (hypeBuffer.length >= hype_threshold) {
    hypeBuffer.length = 0;
    const msg = hype_messages[Math.floor(Math.random() * hype_messages.length)];
    client.say(channel, msg);
  }
}

// --- Personalidad dinámica ---
const recentMessages = [];

function trackMessage() {
  const now = Date.now();
  recentMessages.push(now);
  // Limpiar mensajes fuera de la ventana de 1 minuto
  while (recentMessages.length > 0 && recentMessages[0] < now - 60000) {
    recentMessages.shift();
  }
  return recentMessages.length;
}

function getPersonality(messageCount) {
  if (messageCount >= 20) {
    return `Eres un bot de Twitch con personalidad HYPE y enérgica.
    El chat está muy activo. Responde con energía, emojis y entusiasmo.
    Sé divertido y rápido. Máximo 2 frases cortas. Responde siempre en español.
    IMPORTANTE: Tu respuesta no debe superar los 400 caracteres.`;
  } else if (messageCount >= 5) {
    return `Eres un bot de Twitch con personalidad amigable y cercana.
    El chat está tranquilo. Responde de forma amigable y natural.
    Sé simpático. Máximo 2 frases cortas. Responde siempre en español.
    IMPORTANTE: Tu respuesta no debe superar los 400 caracteres.`;
  } else {
    return `Eres un bot de Twitch con personalidad tranquila y relajada.
    El chat está muy tranquilo. Responde de forma calmada y acogedora.
    Sé amable. Máximo 2 frases cortas. Responde siempre en español.
    IMPORTANTE: Tu respuesta no debe superar los 400 caracteres.`;
  }
}

// --- Comando !pregunta ---
const questionCooldowns = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of questionCooldowns) {
    if (now > expiry) questionCooldowns.delete(key);
  }
}, 30 * 60 * 1000);

async function handleQuestion(client, channel, tags, args) {
  const username = tags['display-name'];
  const now = Date.now();

  if (questionCooldowns.has(username) && now < questionCooldowns.get(username)) {
    const remaining = Math.ceil((questionCooldowns.get(username) - now) / 1000);
    client.say(channel, `@${username} espera ${remaining}s para hacer otra pregunta.`);
    return;
  }

  const rawQuestion = args.slice(1).join(' ');
  if (!rawQuestion) {
    client.say(channel, `@${username} escribe algo después de !pregunta 😅`);
    return;
  }

  const question = sanitizeInput(rawQuestion);
  questionCooldowns.set(username, now + 30000);

  try {
    const messageCount = trackMessage();
    const personality = getPersonality(messageCount);

    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 120,
      messages: [
        { role: 'system', content: personality },
        { role: 'user', content: `${username} pregunta: ${question}` }
      ]
    });

    const answer = truncate(`@${username} ${response.choices[0].message.content}`);
    client.say(channel, answer);
  } catch (err) {
    console.error('Error en IA:', err.message || err);
    client.say(channel, `@${username} no puedo responder ahora mismo, ¡inténtalo más tarde!`);
  }
}

// --- Comandos de personalidad ---
const personalityPrompts = {
  cita: 'Dame una frase inspiradora, épica o de videojuegos. Solo la frase y el autor si lo tiene. Máximo 1 frase corta. En español.',
  chiste: 'Cuéntame un chiste muy corto y gracioso relacionado con videojuegos, internet o streaming. Máximo 2 frases. En español.',
  consejo: 'Dame un consejo random. Puede ser útil, absurdo o gracioso. Solo 1 frase. En español.',
  meme: 'Describe un meme de internet o gaming en formato texto de forma graciosa. Máximo 1 frase. En español.'
};

const personalityCooldowns = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of personalityCooldowns) {
    if (now > expiry) personalityCooldowns.delete(key);
  }
}, 30 * 60 * 1000);

async function handlePersonality(client, channel, tags, command) {
  const username = tags['display-name'];
  const key = `${command}-${username}`;
  const now = Date.now();

  if (personalityCooldowns.has(key) && now < personalityCooldowns.get(key)) {
    const remaining = Math.ceil((personalityCooldowns.get(key) - now) / 1000);
    client.say(channel, `@${username} espera ${remaining}s para usar !${command} de nuevo.`);
    return;
  }

  personalityCooldowns.set(key, now + 30000);

  try {
    const messageCount = trackMessage();
    const personality = getPersonality(messageCount);

    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 100,
      messages: [
        { role: 'system', content: personality },
        { role: 'user', content: personalityPrompts[command] }
      ]
    });

    const answer = truncate(response.choices[0].message.content);
    client.say(channel, answer);
  } catch (err) {
    console.error('Error en personalidad IA:', err.message || err);
    client.say(channel, `No puedo responder ahora mismo, ¡inténtalo más tarde!`);
  }
}

module.exports = { detectHype, handleQuestion, handlePersonality };
