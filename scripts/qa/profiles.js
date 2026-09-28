// Пороги гейтов. avatar — голос HeyGen/ElevenLabs и слой kit; live — живая запись с микрофона.
// Коридор avatar.voiceMusic калибруется по утверждённому эталонному preview (см. DECISIONS).
// live.voiceMusic — стартовые значения без калибровки; уточнить по утверждённому живому ролику
// (D-035).

// Гейт получает профиль по ссылке: без глубокой заморозки один гейт мог бы тихо поменять порог
// (например rhythm.stopSec) для следующего гейта той же проверки.
function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

const BASE = deepFreeze({
  rhythm: { stopSec: 2.5, warnSec: 2.2 },
  camera: { jumpScale: 0.15, shiftPx: 85, weakShiftPx: 40, punchScale: 0.1, weakScale: 0.06, sharpBlurPx: 6, eatenPunch: 1.05 },
  scale: { max: 1.25 },
  // sec/mustSec — задокументированное правило автора (docs/BATCH-REELS-WORKFLOW.md, docs/editing-rules.md):
  // «в первом кадре и первые 2–3 секунды виден спикер». mustSec — жёсткая граница (СТОП), sec —
  // весь диапазон правила (ПРЕДУПРЕЖДЕНИЕ между mustSec и sec).
  hook: { sec: 3, mustSec: 2 },
  // gapSec — стартовое значение оркестратора, калибруется позже по утверждённым роликам.
  donor: { maxSec: 3, gapSec: 0.5 },
  stock: { min: 3, minShort: 2, shortSec: 45 },
  sfx: { minGapSec: 0.3, notableGapSec: 1.0, sceneFadeSec: 0.12 },
  // windowSec 2 (не 5, Task 25 review, п.1): более крупное окно разводило короткую (2–3 с) утечку
  // голоса с фоном −90 дБФС ниже порога слышимости в среднем даже там, где сама утечка звучала в
  // полную силу — scripts/qa/audio.js windowedMax теперь гейтит по доле слышимых блоков окна, а не
  // по среднему, и более мелкое окно точнее локализует короткую утечку для отчёта.
  leak: { stop: 0.6, windowWarn: 0.8, windowSec: 2, silentDb: -60 },
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
