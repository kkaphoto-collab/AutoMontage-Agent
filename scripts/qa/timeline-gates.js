// Гейты по манифесту слоя: считаются до рендера, за доли секунды.
const { gate } = require('./report');

const r2 = (value) => Math.round(value * 100) / 100;
const fmt = (value) => String(r2(value)).replace('.', ',');
const span = (fromFrame, toFrame, fps, note) => ({ fromSec: r2(fromFrame / fps), toSec: r2(toFrame / fps), note });
const factor = (a, b) => (a > b ? a / b : b / a);

// scale — короткая сторона кадра / 1080: порог сдвига лица 85 px задан для кадра 1080×1920.
// fps — окно панч-ина 6 кадров задано для 25 fps (пружина kit живёт в секундах).
function detectCameraEvents(camera, t, scale = 1, fps = 25) {
  const n = camera.s.length;
  const shiftPx = t.shiftPx * scale;
  const punchWindow = Math.max(1, Math.round((6 * fps) / 25));
  const sharp = (f) => camera.opacity[f] >= 0.99 && camera.blur[f] < t.sharpBlurPx;
  const events = [];
  const weak = [];
  for (let f = 1; f < n; f += 1) {
    const b2 = Math.max(0, f - 2);
    const b6 = Math.max(0, f - punchWindow);
    const jump = factor(camera.s[f], camera.s[b2]);
    const shift = Math.max(Math.abs(camera.dx[f] - camera.dx[b2]), Math.abs(camera.dy[f] - camera.dy[b2]));
    if (sharp(f) !== sharp(f - 1)) events.push({ frame: f, kind: 'focus' });
    else if (jump >= 1 + t.jumpScale || shift >= shiftPx) events.push({ frame: f, kind: 'cut' });
    else if (camera.s[f] / camera.s[b6] >= 1 + t.punchScale) events.push({ frame: f, kind: 'punch' });
    else if (jump >= 1 + t.weakScale) weak.push({ frame: f, ratio: camera.s[f] / camera.s[b2] });
  }
  const collapse = (list) => list.filter((e, i) => i === 0 || e.frame - list[i - 1].frame > 2);
  const kept = collapse(events);
  const nearEvent = (w) => events.some((e) => Math.abs(e.frame - w.frame) <= punchWindow);
  return { events: kept, weak: collapse(weak.filter((w) => !nearEvent(w))), sharp };
}

function speakerPlans(camera, detected, fps) {
  const cuts = new Set(detected.events.map((e) => e.frame));
  const plans = [];
  let start = null;
  for (let f = 0; f <= camera.s.length; f += 1) {
    const isSharp = f < camera.s.length && detected.sharp(f);
    if (start !== null && (!isSharp || cuts.has(f))) {
      plans.push({ from: start, to: f, sec: (f - start) / fps });
      start = null;
    }
    if (isSharp && start === null) start = f;
  }
  return plans.sort((a, b) => b.sec - a.sec);
}

const frameScale = (manifest) => Math.min(manifest.width, manifest.height) / 1080;

function gateRhythm(manifest, profile) {
  const { fps } = manifest;
  const plans = speakerPlans(manifest.camera, detectCameraEvents(manifest.camera, profile.camera, frameScale(manifest), manifest.fps), fps);
  const longest = plans[0]?.sec ?? 0;
  const { stopSec, warnSec } = profile.rhythm;
  const status = longest > stopSec + 1e-9 ? 'fail' : longest > warnSec + 1e-9 ? 'warn' : 'pass';
  return gate('G1', 'Ритм спикера', {
    status, value: r2(longest), unit: 'с', threshold: `≤ ${fmt(stopSec)} с`,
    spans: plans.filter((p) => p.sec > warnSec + 1e-9).slice(0, 5).map((p) => span(p.from, p.to, fps, `план ${fmt(p.sec)} с без события`)),
    hint: 'разбейте план: джамп-кат (≥ 15 % масштаба или сдвиг лица ≥ 85 px), панч-ин на общем плане, размытие под графикой или уход под вставку',
  });
}

function gateWeakCuts(manifest, profile) {
  const { weak } = detectCameraEvents(manifest.camera, profile.camera, frameScale(manifest), manifest.fps);
  return gate('G2', 'Слабые джамп-каты', {
    status: weak.length ? 'warn' : 'pass', value: weak.length, unit: 'шт.', threshold: '≥ 15 % или ≥ 85 px',
    spans: weak.slice(0, 5).map((w) => span(w.frame, w.frame + 1, manifest.fps, `скачок ${Math.round((factor(w.ratio, 1) - 1) * 100)} %`)),
    hint: 'такую смену зритель не видит: увеличьте разницу крупности или сдвиньте лицо в треть кадра',
  });
}

module.exports = { detectCameraEvents, gateRhythm, gateWeakCuts, speakerPlans };
