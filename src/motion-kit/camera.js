import { Easing, interpolate, spring } from 'remotion';
import { secToFrame, ref25 } from './time.js';

export const DEFAULT_PRESETS = Object.freeze({
  W: { s: 1.0 },
  M: { s: 1.18 },
  L: { s: 1.12, dx: -170, fill: true },
  R: { s: 1.12, dx: 170, fill: true },
  top: { s: 1.0, dy: 380, fill: true },
});

export const CAMERA_DEFAULTS = Object.freeze({
  maxScale: 1.25,
  drift: { amp: 0.05, maxFrames: 150 },
  sway: [{ px: 22, period: 38 }, { px: 14, period: 97 }],
  punch: { damping: 14, stiffness: 180, mass: 0.6, releaseFrames: 10, k: 1.15 },
  blur: { px: 20, inFrames: 6, outFrames: 10, dimAt: 24, dim: 0.28 },
  away: { enterFrames: 8, exitFrames: 10, blurPx: 26 },
});

const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };
const DRIFT = Easing.bezier(0.45, 0, 0.55, 1);
const ramp = (frame, from, len) => (len <= 0 ? (frame >= from ? 1 : 0) : interpolate(frame, [from, from + len], [0, 1], CLAMP));

export function compileCamera(spec, { fps, width, height, durationInFrames }) {
  if (!spec?.face || !Number.isFinite(spec.face.x) || !Number.isFinite(spec.face.y)) {
    throw new Error('camera.face {x, y} обязателен: точка лица в кадре исходника, px');
  }
  // Пресеты и покачивание заданы для кадра шириной 1080 (короткая сторона) – масштабируем под исходник.
  const k = Math.min(width, height) / 1080;
  const presets = Object.fromEntries(Object.entries({ ...DEFAULT_PRESETS, ...(spec.presets || {}) })
    .map(([name, p]) => [name, { ...p, ...(p.dx !== undefined ? { dx: p.dx * k } : {}), ...(p.dy !== undefined ? { dy: p.dy * k } : {}) }]));
  const f = (sec) => secToFrame(sec, fps);
  // Исходный индекс в spec.shots запоминаем ДО сортировки по at – иначе ошибка «camera.shots[N]»
  // называет позицию после сортировки, а не тот план, который написал человек в plan.js.
  const shots = (spec.shots || [])
    .map((shot, originalIndex) => ({ shot, originalIndex }))
    .sort((a, b) => a.shot.at - b.shot.at)
    .map(({ shot, originalIndex }, index) => {
      if (!presets[shot.preset]) throw new Error(`camera.shots[${originalIndex}]: неизвестный пресет «${shot.preset}»`);
      // shot.dx/dy – ручной сдвиг в пикселях кадра исходника (уже в реальном масштабе, k не
      // применяется); dx/dy пресета заданы для кадра шириной 1080 и масштабированы выше через k.
      return { index, from: f(shot.at), preset: shot.preset, drift: shot.drift || 'in', dx: shot.dx, dy: shot.dy };
    });
  if (!shots.length || shots[0].from !== 0) throw new Error('camera.shots: первый план должен начинаться с 0 с');
  shots.forEach((shot, i) => { shot.to = i + 1 < shots.length ? shots[i + 1].from : durationInFrames; });
  return {
    fps, width, height, durationInFrames, k,
    face: { ...spec.face },
    maxScale: spec.maxScale ?? CAMERA_DEFAULTS.maxScale,
    presets,
    shots,
    punches: (spec.punches || []).map((p) => ({ from: f(p.at), until: f(p.until ?? p.at + 1), k: p.k ?? CAMERA_DEFAULTS.punch.k })),
    blurs: (spec.blurs || []).map((b) => ({ from: f(b.from), to: f(b.to), px: b.px ?? CAMERA_DEFAULTS.blur.px })),
    aways: (spec.aways || []).map((a) => ({ from: f(a.from), to: f(a.to) })),
  };
}

// Уходы в кадрах (например, из полноэкранных вставок) добавляются к уже скомпилированной камере.
export function withAways(track, aways) {
  return { ...track, aways: [...track.aways, ...aways] };
}

export function cameraAt(track, frame) {
  const cfg = CAMERA_DEFAULTS;
  const fps = track.fps;
  // Все длительности cfg заданы в кадрах эталона 25 fps – переводим в кадры композиции, чтобы
  // ритм дрейфа, панча, размытия и ухода был одинаковым в секундах на любом fps.
  const shot = track.shots.reduce((current, s) => (s.from <= frame ? s : current), track.shots[0]);
  const preset = track.presets[shot.preset];
  const span = Math.max(1, Math.min(shot.to - shot.from, ref25(cfg.drift.maxFrames, fps)));
  const p = DRIFT(Math.min(1, Math.max(0, (frame - shot.from) / span)));
  const grow = shot.drift === 'in' ? p : shot.drift === 'out' ? 1 - p : 0;
  let s = preset.s * (1 + cfg.drift.amp * grow);
  // base – масштаб пресета с дрейфом, ДО панчей и ДО ограничения maxScale: гейт G3 (scripts/qa/
  // timeline-gates.js) читает его, чтобы отличить «пресет сам крупнее предела» от «панч упёрся в
  // потолок» – причину клэмпа нельзя достоверно угадать по форме кривой (ступенька/спираль), а
  // база всегда знает, что было задумано ДО панча.
  const base = s;

  for (const punch of track.punches) {
    // После релиза (until + releaseFrames) множитель панча уже точно равен 1 – не вызываем
    // spring() дальше: Remotion заново проигрывает симуляцию от кадра 0 на каждый вызов, и цикл
    // по всем кадрам до конца ролика делает манифест квадратичным по длине (120 с × 60 fps с
    // одним панчем – секунды вместо десятков мс).
    if (frame < punch.from || frame >= punch.until + ref25(cfg.punch.releaseFrames, fps)) continue;
    // spring() сам переводит кадры в секунды через переданный fps, поэтому реальную скорость
    // подъёма панча масштабировать не нужно – только releaseFrames ниже (это ramp, не spring).
    const on = spring({
      frame: frame - punch.from, fps,
      config: { damping: cfg.punch.damping, stiffness: cfg.punch.stiffness, mass: cfg.punch.mass },
    });
    const off = ramp(frame, punch.until, ref25(cfg.punch.releaseFrames, fps));
    s *= 1 + (punch.k - 1) * on * (1 - off);
  }

  let blur = 0;
  for (const b of track.blurs) {
    if (frame < b.from) continue;
    const inV = b.from === 0 ? 1 : ramp(frame, b.from, ref25(cfg.blur.inFrames, fps));
    const outV = 1 - ramp(frame, b.to, ref25(cfg.blur.outFrames, fps));
    blur = Math.max(blur, b.px * Math.min(inV, outV));
  }

  let gone = 0;
  for (const a of track.aways) {
    gone = Math.max(gone, ramp(frame, a.from, ref25(cfg.away.enterFrames, fps)) * (1 - ramp(frame, a.to, ref25(cfg.away.exitFrames, fps))));
  }
  blur = Math.max(blur, cfg.away.blurPx * gone);

  const requested = s;
  s = Math.min(s, track.maxScale);
  // Период покачивания cfg.sway задан в секундах через кадры при 25 fps – frame * 25 / fps
  // переводит текущий кадр в «кадры на 25 fps», поэтому период колебания одинаков в секундах.
  const sway = cfg.sway.reduce((sum, w) => sum + w.px * track.k * Math.sin(((frame * 25) / fps) / w.period), 0);
  let dx = (shot.dx ?? preset.dx ?? 0) + sway;
  let dy = shot.dy ?? preset.dy ?? 0;
  if (!preset.fill) {
    dx = Math.min((s - 1) * track.face.x, Math.max(-(s - 1) * (track.width - track.face.x), dx));
    dy = Math.min((s - 1) * track.face.y, Math.max(-(s - 1) * (track.height - track.face.y), dy));
  }
  const dim = 1 - (cfg.blur.dim * Math.min(blur, cfg.blur.dimAt)) / cfg.blur.dimAt;
  const opacity = 1 - gone;
  return { s, requested, base, dx, dy, blur, dim, opacity, visible: opacity > 0.01, shot: shot.index, fill: Boolean(preset.fill) };
}

const PUNCT = /[.,!?…:;]$/u;

// Раскадровка по словам: план не длиннее maxSec, режем по концу слова (по возможности на знаке
// препинания). Молчание без подходящего слова – долгое начало до первой реплики, пауза внутри
// речи, хвост после последнего слова – режем поровну на куски ≤ maxSec, чтобы не оставить план
// длиннее лимита. Рядом с самым концом (ближе minSec к endSec) разрез не ставим, чтобы не оставить
// вспышку короче minSec в последних кадрах.
export function autoShots(words, { endSec, maxSec = 2.2, minSec = 1.2, cycle = ['W', 'M', 'W', 'L', 'W', 'R'] } = {}) {
  // Проверяем ДО цикла split(): maxSec ≤ 0 делает шаг деления на ноль и зацикливает split()
  // навсегда, а не просто выдаёт плохой результат – поэтому это исключение, а не тихий дефолт.
  if (!(maxSec > 0) || !(minSec >= 0) || minSec > maxSec || !Array.isArray(cycle) || !cycle.length) {
    throw new Error('autoShots: нужны maxSec > 0, 0 ≤ minSec ≤ maxSec и непустой cycle');
  }
  if (!Array.isArray(words)) throw new Error('autoShots: words должен быть массивом слов транскрипта');
  const drift = (preset) => (preset === 'W' ? 'in' : 'out');
  const list = words.filter((w) => Number.isFinite(w?.e));
  const end = Number.isFinite(endSec) ? endSec : (list.at(-1)?.e ?? 0);
  const shots = [{ at: 0, preset: cycle[0], drift: drift(cycle[0]) }];
  let last = 0;
  let k = 1;
  const push = (at) => {
    const preset = cycle[k % cycle.length];
    shots.push({ at: Number(at.toFixed(3)), preset, drift: drift(preset) });
    last = at;
    k += 1;
  };
  // Молчание без слова (пауза, хвост, долгое начало) делим на равные куски ≤ maxSec.
  const split = (until) => {
    while (until - last > maxSec + 1e-9) push(last + (until - last) / Math.ceil((until - last) / maxSec - 1e-9));
  };
  for (let i = 0; i < list.length; i += 1) {
    const word = list[i];
    if (Number.isFinite(word.s)) split(Math.min(word.s, end));
    const cut = word.e;
    if (end - cut < minSec) break; // не оставлять вспышку короче minSec в самом конце
    if (cut - last > maxSec) split(cut);
    const next = i + 1 < list.length ? Math.min(list[i + 1].e, end) : end;
    const since = cut - last;
    const urgent = next - last > maxSec;
    // Обычный порог minSec – на паузе или знаке препинания; если иначе план неизбежно
    // превысит maxSec к следующему слову – режем раньше, но не короче половины minSec.
    if ((since >= minSec && (PUNCT.test(word.t ?? word.w) || urgent)) || (urgent && since >= minSec / 2)) push(cut);
  }
  split(end);
  return shots;
}
