import { Easing, interpolate, spring } from 'remotion';
import { secToFrame } from './time.js';

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
  // Пресеты и покачивание заданы для кадра шириной 1080 (короткая сторона) — масштабируем под исходник.
  const k = Math.min(width, height) / 1080;
  const presets = Object.fromEntries(Object.entries({ ...DEFAULT_PRESETS, ...(spec.presets || {}) })
    .map(([name, p]) => [name, { ...p, ...(p.dx !== undefined ? { dx: p.dx * k } : {}), ...(p.dy !== undefined ? { dy: p.dy * k } : {}) }]));
  const f = (sec) => secToFrame(sec, fps);
  const shots = [...(spec.shots || [])].sort((a, b) => a.at - b.at).map((shot, index) => {
    if (!presets[shot.preset]) throw new Error(`camera.shots[${index}]: неизвестный пресет «${shot.preset}»`);
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
  const shot = track.shots.reduce((current, s) => (s.from <= frame ? s : current), track.shots[0]);
  const preset = track.presets[shot.preset];
  const span = Math.max(1, Math.min(shot.to - shot.from, cfg.drift.maxFrames));
  const p = DRIFT(Math.min(1, Math.max(0, (frame - shot.from) / span)));
  const grow = shot.drift === 'in' ? p : shot.drift === 'out' ? 1 - p : 0;
  let s = preset.s * (1 + cfg.drift.amp * grow);

  for (const punch of track.punches) {
    if (frame < punch.from) continue;
    const on = spring({
      frame: frame - punch.from, fps: track.fps,
      config: { damping: cfg.punch.damping, stiffness: cfg.punch.stiffness, mass: cfg.punch.mass },
    });
    const off = ramp(frame, punch.until, cfg.punch.releaseFrames);
    s *= 1 + (punch.k - 1) * on * (1 - off);
  }

  let blur = 0;
  for (const b of track.blurs) {
    if (frame < b.from) continue;
    const inV = b.from === 0 ? 1 : ramp(frame, b.from, cfg.blur.inFrames);
    const outV = 1 - ramp(frame, b.to, cfg.blur.outFrames);
    blur = Math.max(blur, b.px * Math.min(inV, outV));
  }

  let gone = 0;
  for (const a of track.aways) {
    gone = Math.max(gone, ramp(frame, a.from, cfg.away.enterFrames) * (1 - ramp(frame, a.to, cfg.away.exitFrames)));
  }
  blur = Math.max(blur, cfg.away.blurPx * gone);

  const requested = s;
  s = Math.min(s, track.maxScale);
  const sway = cfg.sway.reduce((sum, w) => sum + w.px * track.k * Math.sin(frame / w.period), 0);
  let dx = (shot.dx ?? preset.dx ?? 0) + sway;
  let dy = shot.dy ?? preset.dy ?? 0;
  if (!preset.fill) {
    dx = Math.min((s - 1) * track.face.x, Math.max(-(s - 1) * (track.width - track.face.x), dx));
    dy = Math.min((s - 1) * track.face.y, Math.max(-(s - 1) * (track.height - track.face.y), dy));
  }
  const dim = 1 - (cfg.blur.dim * Math.min(blur, cfg.blur.dimAt)) / cfg.blur.dimAt;
  const opacity = 1 - gone;
  return { s, requested, dx, dy, blur, dim, opacity, visible: opacity > 0.01, shot: shot.index, fill: Boolean(preset.fill) };
}

const PUNCT = /[.,!?…:;]$/u;

// Раскадровка по словам: план не длиннее maxSec, режем по концу слова, по возможности на знаке препинания.
export function autoShots(words, { endSec, maxSec = 2.2, minSec = 1.2, cycle = ['W', 'M', 'W', 'L', 'W', 'R'] } = {}) {
  const drift = (preset) => (preset === 'W' ? 'in' : 'out');
  const shots = [{ at: 0, preset: cycle[0], drift: drift(cycle[0]) }];
  let last = 0;
  let k = 1;
  const end = Number.isFinite(endSec) ? endSec : (words.at(-1)?.e ?? 0);
  for (let i = 0; i < words.length; i += 1) {
    const cut = words[i].e;
    const next = i + 1 < words.length ? words[i + 1].e : end;
    const since = cut - last;
    if (since >= minSec && (PUNCT.test(words[i].t ?? words[i].w) || next - last > maxSec)) {
      const preset = cycle[k % cycle.length];
      shots.push({ at: Number(cut.toFixed(3)), preset, drift: drift(preset) });
      last = cut;
      k += 1;
    }
  }
  return shots;
}
