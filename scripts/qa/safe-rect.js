// Те же числа для CommonJS-гейтов, что и src/motion-kit/safe.js; равенство закреплено тестом
// tests/motion-kit-safe.test.js.
const SAFE_9x16 = { top: 250, bottom: 420, left: 70, right: 130 };
const SAFE_16x9 = { top: 60, bottom: 60, left: 80, right: 80 };

function safeRect(width, height) {
  const portrait = height > width;
  const base = portrait ? SAFE_9x16 : SAFE_16x9;
  const k = width / (portrait ? 1080 : 1920);
  return { left: base.left * k, top: base.top * k, right: width - base.right * k, bottom: height - base.bottom * k };
}

function overflow(rect, safe, epsilon = 0.5) {
  const sides = {
    left: safe.left - rect.left, top: safe.top - rect.top,
    right: rect.right - safe.right, bottom: rect.bottom - safe.bottom,
  };
  const out = Object.entries(sides).filter(([, value]) => value > epsilon);
  return out.length ? Object.fromEntries(out.map(([side, value]) => [side, Math.round(value)])) : null;
}

module.exports = { overflow, safeRect };
