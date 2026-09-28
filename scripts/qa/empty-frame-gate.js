// G12 «Пустые кадры» — чистое решение по уже посчитанной доле краевых пикселей одного семпла.
// Сам декод и подсчёт (scale до EDGE_WIDTH px, серый, доля пикселей с перепадом ярче EDGE_THRESHOLD)
// делает ffmpeg в scripts/layer/sheet.js; сюда попадают только числа — этот модуль не запускает
// процессы и проверяется без ffmpeg. Среднее/разброс яркости сюда не входят: ровный тёмный фон или
// плавная виньетка дают маленький разброс, но так же мало «краёв», как настоящая пустота — и то,
// и другое ловит доля краёв, а не яркость.
'use strict';
const { gate } = require('./report');

const EDGE_WIDTH = 135;
const EDGE_THRESHOLD = 24;
const SHARE_THRESHOLD = 0.001;

// sample — {timeSec, edgeShare} для прочитанного кадра или null, если ffmpeg не смог его декодировать
// (тоже подозрительно — не гейта дело чинить битый кадр, но и не пропускать его как «всё в порядке»).
function isEmptySample(sample) {
  return !sample || !Number.isFinite(sample.edgeShare) || sample.edgeShare < SHARE_THRESHOLD;
}

function emptyFrameGate(samples) {
  const list = Array.isArray(samples) ? samples : [];
  const empty = list.filter((sample) => isEmptySample(sample));
  return gate('G12', 'Пустые кадры', {
    status: empty.length ? 'warn' : 'pass',
    value: empty.length,
    unit: `из ${list.length}`,
    threshold: `доля пикселей с перепадом яркости > ${EDGE_THRESHOLD} не меньше ${(SHARE_THRESHOLD * 100).toFixed(1)}%`,
    spans: empty
      .filter((sample) => sample && Number.isFinite(sample.timeSec))
      .slice(0, 5)
      .map((sample) => ({ fromSec: sample.timeSec, toSec: sample.timeSec, note: 'пустой или однотонный кадр' })),
    hint: 'проверьте, не выпала ли графика или видео слоя',
  });
}

module.exports = { EDGE_THRESHOLD, EDGE_WIDTH, SHARE_THRESHOLD, emptyFrameGate, isEmptySample };
