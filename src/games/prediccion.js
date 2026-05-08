// Sistema de predicciones
let activePrediction = null;
let predictionTimeout = null;
let lastPredictionEnd = 0;
const PREDICTION_COOLDOWN = 30000; // 30s entre predicciones

const votes = { si: new Map(), no: new Map() }; // userId -> username

function startPrediction(client, channel, question, durationSeconds = 60) {
  if (activePrediction) {
    client.say(channel, '❌ Ya hay una predicción activa. Usa !resolver para cerrarla.');
    return false;
  }
  if (Date.now() - lastPredictionEnd < PREDICTION_COOLDOWN) {
    client.say(channel, '⏳ Espera un poco antes de lanzar otra predicción.');
    return false;
  }

  votes.si.clear();
  votes.no.clear();
  activePrediction = { question, startedAt: Date.now(), duration: durationSeconds };

  client.say(channel, `🔮 PREDICCIÓN: "${question}" | Vota !votar si o !votar no en ${durationSeconds}s!`);

  predictionTimeout = setTimeout(() => {
    if (activePrediction) resolvePrediction(client, channel, null);
  }, durationSeconds * 1000);

  return true;
}

function votePrediction(client, channel, tags, vote) {
  if (!activePrediction) return;
  const userId = tags['user-id'];
  const username = tags['display-name'];

  const hadVoted = votes.si.has(userId) || votes.no.has(userId);
  votes.si.delete(userId);
  votes.no.delete(userId);

  if (vote === 'si') {
    votes.si.set(userId, username);
    client.say(channel, `✅ @${username} vota SÍ (${votes.si.size} vs ${votes.no.size})`);
  } else {
    votes.no.set(userId, username);
    client.say(channel, `❌ @${username} vota NO (${votes.si.size} vs ${votes.no.size})`);
  }
}

function showPredictionStatus(client, channel) {
  if (!activePrediction) {
    client.say(channel, '🔮 No hay ninguna predicción activa. Los mods pueden usar !prediccion [pregunta]');
    return;
  }
  const elapsed = Math.floor((Date.now() - activePrediction.startedAt) / 1000);
  const remaining = Math.max(0, activePrediction.duration - elapsed);
  client.say(channel,
    `🔮 "${activePrediction.question}" | ✅ SÍ: ${votes.si.size} | ❌ NO: ${votes.no.size} | ⏱️ ${remaining}s restantes`
  );
}

function resolvePrediction(client, channel, result) {
  if (!activePrediction) {
    client.say(channel, '❌ No hay ninguna predicción activa.');
    return;
  }

  clearTimeout(predictionTimeout);
  lastPredictionEnd = Date.now();

  const totalSi = votes.si.size;
  const totalNo = votes.no.size;
  const total = totalSi + totalNo;

  if (total === 0) {
    client.say(channel, `🔮 Predicción cerrada sin votos: "${activePrediction.question}" 😅`);
  } else if (result === null) {
    client.say(channel, `⏰ Tiempo! "${activePrediction.question}" | ✅ SÍ: ${totalSi} | ❌ NO: ${totalNo}`);
  } else {
    const winner = result === 'si' ? 'SÍ ✅' : 'NO ❌';
    const winnerCount = result === 'si' ? totalSi : totalNo;
    const loserCount = result === 'si' ? totalNo : totalSi;
    client.say(channel,
      `🎉 Ganó ${winner}! "${activePrediction.question}" | Acertaron ${winnerCount} | Fallaron ${loserCount} 🔮`
    );
  }

  activePrediction = null;
  votes.si.clear();
  votes.no.clear();
}

function isPredictionActive() { return activePrediction !== null; }

module.exports = { startPrediction, votePrediction, showPredictionStatus, resolvePrediction, isPredictionActive };
