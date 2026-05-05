const Groq = require('groq-sdk');

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// --- Detector de hype ---
const hypeBuffer = [];

function detectHype(client, channel, message, config) {
  const now = Date.now();
  const { hype_threshold, hype_window_seconds, hype_messages } = config.personality;

  hypeBuffer.push(now);

  const window = hype_window_seconds * 1000;
  while (hypeBuffer.length > 0 && hypeBuffer[0] < now - window) {
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
  while (recentMessages.length > 0 && recentMessages[0] < now - 60000) {
    recentMessages.shift();
  }
  return recentMessages.length;
}

function getPersonality(messageCount) {
  if (messageCount >= 20) {
    return `Eres un bot de Twitch con personalidad HYPE y enérgica.
    El chat está muy activo. Responde con energía, emojis y entusiasmo.
    Sé divertido y rápido. Máximo 2 frases. Responde siempre en español.`;
  } else if (messageCount >= 5) {
    return `Eres un bot de Twitch con personalidad amigable y cercana.
    El chat está tranquilo. Responde de forma amigable y natural.
    Sé simpático. Máximo 2 frases. Responde siempre en español.`;
  } else {
    return `Eres un bot de Twitch con personalidad tranquila y relajada.
    El chat está muy tranquilo. Responde de forma calmada y acogedora.
    Sé amable. Máximo 2 frases. Responde siempre en español.`;
  }
}

// --- Comando !pregunta ---
const questionCooldowns = new Map();

async function handleQuestion(client, channel, tags, args) {
  const username = tags['display-name'];
  const now = Date.now();

  if (questionCooldowns.has(username) && now < questionCooldowns.get(username)) {
    const remaining = Math.ceil((questionCooldowns.get(username) - now) / 1000);
    client.say(channel, `@${username} espera ${remaining}s para hacer otra pregunta.`);
    return;
  }

  const question = args.slice(1).join(' ');
  if (!question) {
    client.say(channel, `@${username} escribe algo después de !pregunta 😅`);
    return;
  }

  questionCooldowns.set(username, now + 30000);

  try {
    const messageCount = trackMessage();
    const personality = getPersonality(messageCount);

    const response = await groq.chat.completions.create({
      model: 'llama3-8b-8192',
      max_tokens: 150,
      messages: [
        { role: 'system', content: personality },
        { role: 'user', content: `${username} pregunta: ${question}` }
      ]
    });

    const answer = response.choices[0].message.content;
    client.say(channel, `@${username} ${answer}`);
  } catch (err) {
    console.error('Error en IA:', err);
    client.say(channel, `@${username} no puedo responder ahora mismo, ¡inténtalo más tarde!`);
  }
}

// --- Comandos de personalidad ---
const personalityPrompts = {
  cita: 'Dame una frase inspiradora, épica o de videojuegos. Solo la frase y el autor si lo tiene. Máximo 1 frase. En español.',
  chiste: 'Cuéntame un chiste corto y gracioso relacionado con videojuegos, internet o streaming. Máximo 2 frases. En español.',
  consejo: 'Dame un consejo random. Puede ser útil, absurdo o gracioso. Máximo 1 frase. En español.',
  meme: 'Describe un meme de internet o gaming en formato texto de forma graciosa. Máximo 2 frases. En español.'
};

const personalityCooldowns = new Map();

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
      model: 'llama3-8b-8192',
      max_tokens: 100,
      messages: [
        { role: 'system', content: personality },
        { role: 'user', content: personalityPrompts[command] }
      ]
    });

    const answer = response.choices[0].message.content;
    client.say(channel, answer);
  } catch (err) {
    console.error('Error en personalidad IA:', err);
    client.say(channel, `No puedo responder ahora mismo, ¡inténtalo más tarde!`);
  }
}

module.exports = { detectHype, handleQuestion, handlePersonality };