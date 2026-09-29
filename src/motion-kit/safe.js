import { SAFE_16x9, SAFE_9x16 } from '../scenes/safezone.js';

// Прямоугольник, внутри которого должен оставаться текст на КАЖДОМ кадре.
export function safeRect(width, height) {
  const portrait = height > width;
  const base = portrait ? SAFE_9x16 : SAFE_16x9;
  const k = width / (portrait ? 1080 : 1920);
  return { left: base.left * k, top: base.top * k, right: width - base.right * k, bottom: height - base.bottom * k };
}

export function overflow(rect, safe, epsilon = 0.5) {
  const sides = {
    left: safe.left - rect.left, top: safe.top - rect.top,
    right: rect.right - safe.right, bottom: rect.bottom - safe.bottom,
  };
  const out = Object.entries(sides).filter(([, value]) => value > epsilon);
  return out.length ? Object.fromEntries(out.map(([side, value]) => [side, Math.round(value)])) : null;
}
