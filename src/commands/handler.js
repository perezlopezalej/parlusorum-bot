// --- Cooldowns con limpieza automática (por user-id) ---
const cooldowns = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of cooldowns) {
    if (now > expiry) cooldowns.delete(key);
  }
}, 30 * 60 * 1000);

// --- Handler principal ---
function handle(client, channel, tags, command, args, config, isMod) {
  const username = tags['display-name'];
  const userId = tags['user-id'];

  // Comandos del config JSON
  if (config.commands[command]) {
    const cmd = config.commands[command];
    const key = `${command}-${userId}`; // usar user-id como clave
    const now = Date.now();

    if (cooldowns.has(key)) {
      const expiry = cooldowns.get(key);
      if (now < expiry) {
        const remaining = Math.ceil((expiry - now) / 1000);
        client.say(channel, `@${username} espera ${remaining}s para usar !${command} de nuevo.`);
        return;
      }
    }

    cooldowns.set(key, now + cmd.cooldown * 1000);
    client.say(channel, cmd.response);
    return;
  }

  // !uptime
  if (command === 'uptime') return handleUptime(client, channel);
}

// --- Uptime ---
const botStartTime = Date.now();

function handleUptime(client, channel) {
  const elapsed = Date.now() - botStartTime;
  const hours = Math.floor(elapsed / 3600000);
  const minutes = Math.floor((elapsed % 3600000) / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);

  let uptime = '';
  if (hours > 0) uptime += `${hours}h `;
  if (minutes > 0) uptime += `${minutes}m `;
  uptime += `${seconds}s`;

  client.say(channel, `⏱️ El bot lleva activo: ${uptime}`);
}

module.exports = { handle };
