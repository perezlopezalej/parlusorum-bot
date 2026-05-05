// Estado compartido entre módulos (evita dependencias circulares)
let doublePointsActive = false;
let doublePointsTimer = null;

function isDoublePoints() {
  return doublePointsActive;
}

function setDoublePoints(value) {
  doublePointsActive = value;
}

function setDoublePointsTimer(timer) {
  if (doublePointsTimer) clearTimeout(doublePointsTimer);
  doublePointsTimer = timer;
}

module.exports = { isDoublePoints, setDoublePoints, setDoublePointsTimer };
