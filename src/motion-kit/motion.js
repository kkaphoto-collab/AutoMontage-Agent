import { Easing, interpolate, measureSpring, spring } from 'remotion';
import { ref25 } from './time.js';

export const EASE = Object.freeze({ out: Easing.bezier(0.16, 1, 0.3, 1), inOut: Easing.bezier(0.65, 0, 0.35, 1) });
const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' };
export const prog = (frame, at, len, easing = EASE.out) => (
  len <= 0 ? (frame >= at ? 1 : 0) : interpolate(frame, [at, at + len], [0, 1], { ...CLAMP, easing })
);
export const SPRINGS = Object.freeze({
  pop: { damping: 12, stiffness: 200, mass: 0.7 },
  fly: { damping: 16, stiffness: 160, mass: 0.8 },
});

// spring() Remotion пересчитывает физику от кадра 0 на каждый вызов (внутренний цикл O(кадр)) –
// без клэмпа кадр растёт вместе с самим элементом (плашка может жить десятки секунд), и построение
// манифеста из многих долгоживущих items становится квадратичным по длине (ревью задачи 23: 40 text
// по 60 с при 60 fps – 4,3 с только на manifest). measureSpring() кеширует результат по (fps,
// config, threshold), поэтому здесь он практически бесплатен после первого вызова. Порог 1e-9 (не
// дефолтный 0,005 Remotion) – разница между клэмпнутым и настоящим кадром на этом пороге порядка
// 1e-9 по sp, то есть в тысячи раз меньше любого практического px: клэмп кадра даёт визуально тот
// же результат (разница ≤ 1e-6 px), а не грубое приближение (Step 0 задачи 24).
const SPRING_SETTLE_THRESHOLD = 1e-9;
const settledFrame = (frame, fps, config) => Math.min(frame, measureSpring({ fps, config, threshold: SPRING_SETTLE_THRESHOLD }));

// Состояние элемента в кадре: прозрачность, масштаб, сдвиг, поворот, размытие, маска.
export function animOf(item, frame, fps) {
  const out = { o: 1, s: 1, dx: 0, dy: 0, rot: item.rot || 0, blur: 0, clip: null, reveal: 1 };
  const enter = item.enter || { kind: 'fly' };
  if (!['pop', 'fly', 'mask', 'cut'].includes(enter.kind)) {
    throw new Error(`item ${item.id}: неизвестный вход «${enter.kind}»`);
  }
  if (frame < item.from || frame >= item.until) return { ...out, o: 0 };
  const f = frame - item.from;
  const len = item.until - item.from;
  // Длительности заданы в кадрах эталонных 25 fps и пересчитываются под fps композиции.
  const r = (frames) => ref25(frames, fps);
  if (enter.kind === 'pop') {
    const sp = spring({ frame: settledFrame(f, fps, SPRINGS.pop), fps, config: SPRINGS.pop });
    out.s = 0.5 + 0.5 * sp;
    out.rot += -10 * (1 - sp);
    out.blur = interpolate(f, [0, r(5)], [8, 0], CLAMP);
    out.o = interpolate(f, [0, r(3)], [0, 1], CLAMP);
  } else if (enter.kind === 'fly') {
    const sp = spring({ frame: settledFrame(f, fps, SPRINGS.fly), fps, config: SPRINGS.fly });
    const [fx, fy] = enter.from || [0, 60];
    out.s = 0.92 + 0.08 * sp;
    out.dx = fx * (1 - sp);
    out.dy = fy * (1 - sp);
    out.o = interpolate(f, [0, r(4)], [0, 1], CLAMP);
    out.blur = interpolate(f, [0, r(6)], [14, 0], CLAMP);
  } else if (enter.kind === 'mask') {
    const p = prog(f, 0, r(8));
    out.clip = `inset(0 ${((1 - p) * 100).toFixed(2)}% 0 0 round 24px)`;
    out.dy = 24 * (1 - p);
    out.blur = interpolate(f, [0, r(6)], [6, 0], CLAMP);
    // На самом первом кадре маски (p=0) clip закрывает 100% ширины – реально ничего не нарисовано,
    // хотя o остаётся полным. reveal – доля раскрытия; isShown() ниже требует его тоже, иначе
    // manifest/G5 «видит» габарит кадра, который зритель не видит вовсе (ревью задачи 23).
    out.reveal = p;
  }
  if (enter.kind !== 'cut' && item.life?.parallax !== 0) {
    out.dy += (item.life?.parallax ?? 8) * interpolate(f, [0, len], [0, 1], CLAMP);
  }
  const exit = item.exit || { frames: 5, dir: 'down' };
  if (exit.frames > 0) {
    const exitFrames = r(exit.frames);
    // Последний реально отрисованный кадр – until-1 (until сам не рендерится, animOf для него
    // уже вернул o:0 выше по early-return). Интервал должен заканчиваться там же, иначе на
    // until-1 прозрачность ещё не доходит до 0, и элемент выключается рывком кадром позже.
    // exitEnd-1 гарантирует непустой (строго возрастающий) диапазон для interpolate() даже
    // при exitFrames:1, где start и until-1 совпали бы.
    const exitEnd = item.until - 1;
    const exitStart = Math.min(item.until - exitFrames, exitEnd - 1);
    const q = interpolate(frame, [exitStart, exitEnd], [0, 1], { ...CLAMP, easing: Easing.in(Easing.quad) });
    if (q > 0) {
      out.o *= 1 - q;
      out.s *= 1 - 0.06 * q;
      out.dy += (exit.dir === 'up' ? -12 : 12) * q;
      out.blur += 8 * q;
    }
  }
  return out;
}

// Порог видимости – общий для рендера (KitBox) и манифеста (itemExtentAt): гейт safe-zone
// должен видеть ровно то же самое «не показано», что и настоящий кадр Remotion, иначе манифест
// пропустит габарит элемента, который на экране ещё виден полупрозрачным, или наоборот сочтёт
// видимым элемент, которого KitBox уже не рисует.
export const VISIBLE_MIN = 0.01;
export function isShown(anim) {
  // reveal отсутствует у вызовов не из animOf (Inserts.jsx передаёт {o: opacity} без reveal
  // вовсе) – undefined читаем как «нет своей маски», а не как «скрыто».
  return anim.o > VISIBLE_MIN && (anim.reveal === undefined || anim.reveal > VISIBLE_MIN);
}

// Габарит элемента в кадре с учётом масштаба, поворота и сдвига. null – элемент не виден.
export function itemExtentAt(item, frame, fps) {
  const a = animOf(item, frame, fps);
  if (!isShown(a)) return null;
  const { x, y, w, h } = item.box;
  const th = (Math.abs(a.rot) * Math.PI) / 180;
  // abs(cos)/abs(sin): без него cos(th) уходит в минус при th>90° и переворачивает габарит
  // (left>right) – гейт safe-zone (G5) тогда молча пропускает элемент, который реально вылез
  // за кадр. Формула – стандартный ограничивающий прямоугольник повёрнутого прямоугольника.
  const hw = ((w * Math.abs(Math.cos(th)) + h * Math.abs(Math.sin(th))) / 2) * a.s;
  const hh = ((w * Math.abs(Math.sin(th)) + h * Math.abs(Math.cos(th))) / 2) * a.s;
  const cx = x + w / 2 + a.dx;
  const cy = y + h / 2 + a.dy;
  return { left: cx - hw, top: cy - hh, right: cx + hw, bottom: cy + hh };
}

const rand = (seed) => {
  const v = Math.sin(seed * 12.9898) * 43758.5453;
  return v - Math.floor(v);
};

// Набор текста с живым неровным ритмом, детерминированный между кадрами.
export function typed(text, frame, fromFrame, toFrame) {
  const chars = [...text];
  if (frame < fromFrame) return '';
  if (frame >= toFrame) return text;
  const weights = chars.map((_, i) => 0.6 + 0.8 * rand(i * 3.1 + chars.length));
  const total = weights.reduce((sum, v) => sum + v, 0);
  const target = ((frame - fromFrame) / (toFrame - fromFrame)) * total;
  let acc = 0;
  let k = 0;
  while (k < chars.length && acc + weights[k] <= target) {
    acc += weights[k];
    k += 1;
  }
  return chars.slice(0, k).join('');
}
