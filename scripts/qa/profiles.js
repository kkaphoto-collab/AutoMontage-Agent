// Пороги гейтов. avatar — голос HeyGen/ElevenLabs и слой kit; live — живая запись с микрофона.
// Коридор avatar.voiceMusic калибруется по утверждённому эталонному preview (см. DECISIONS).

// Глубокая заморозка: гейт получает профиль по ссылке, и без неё один гейт мог бы поменять порог
// (например, rhythm.stopSec) для следующего гейта той же проверки — Object.freeze без deep
// замораживает только верхний уровень, вложенные объекты (rhythm, camera, voiceMusic, ...)
// остались бы изменяемыми.
function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

const BASE = deepFreeze({
  rhythm: { stopSec: 2.5, warnSec: 2.2 },
  camera: { jumpScale: 0.15, shiftPx: 85, punchScale: 0.1, weakScale: 0.06, sharpBlurPx: 6, eatenPunch: 1.05 },
  scale: { max: 1.25 },
  hook: { sec: 3 },
  donor: { maxSec: 3 },
  stock: { min: 3, minShort: 2, shortSec: 45 },
  sfx: { minGapSec: 0.3, notableGapSec: 1.0, sceneFadeSec: 0.12 },
  leak: { stop: 0.6, windowWarn: 0.8, windowSec: 5, silentDb: -60 },
  duration: { toleranceFrames: 1 },
});

// { ...BASE, voiceMusic: {...} } копирует только верхний уровень: вложенные объекты (rhythm,
// camera, ...) остаются той же замороженной ссылкой из BASE, deepFreeze их не трогает повторно.
const PROFILES = deepFreeze({
  avatar: { ...BASE, voiceMusic: { stopLow: 3, warnLow: 9, target: 12, warnHigh: 15, stopHigh: 20 } },
  live: { ...BASE, voiceMusic: { stopLow: 6, warnLow: 12, target: 15, warnHigh: 18, stopHigh: 24 } },
});

const WAIVABLE = Object.freeze(['G1', 'G4', 'G11']);

function getProfile(name = 'avatar') {
  if (!Object.hasOwn(PROFILES, name)) throw new Error(`неизвестный профиль проверок «${name}»: используй avatar или live`);
  return PROFILES[name];
}

module.exports = { PROFILES, WAIVABLE, getProfile };
