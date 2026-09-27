import { safeRect } from './safe.js';

const END = /[.!?…]$/u;
const COMMA = /[,;:]$/u;

// 1–4 слова, до 20 знаков, разрыв на паузе, конце фразы и запятой (если в куске уже 2+ слова);
// кусок короче minDur приклеивается к следующему. show — до какого момента кусок на экране.
export function buildChunks(words, { maxWords = 4, maxChars = 20, hardGap = 0.3, minDur = 0.45, hold = 0.4 } = {}) {
  const chunks = [];
  let current = null;
  for (const word of words) {
    const text = word.t ?? word.w;
    if (current) {
      const prev = current.units[current.units.length - 1];
      const chars = current.units.reduce((n, u) => n + u.t.length + 1, 0) + text.length;
      if (current.units.length >= maxWords || chars > maxChars || word.s - prev.e > hardGap
        || END.test(prev.t) || (COMMA.test(prev.t) && current.units.length >= 2)) {
        chunks.push(current);
        current = null;
      }
    }
    if (!current) current = { units: [], s: word.s, e: word.e };
    current.units.push({ t: text, s: word.s, e: word.e });
    current.e = word.e;
  }
  if (current) chunks.push(current);
  for (let i = 0; i < chunks.length - 1; i += 1) {
    if (chunks[i].e - chunks[i].s < minDur && chunks[i + 1].s - chunks[i].e <= hardGap) {
      chunks[i + 1] = { units: [...chunks[i].units, ...chunks[i + 1].units], s: chunks[i].s, e: chunks[i + 1].e };
      chunks.splice(i, 1);
      i -= 1;
    }
  }
  return chunks.map((chunk, i) => ({
    ...chunk,
    text: chunk.units.map((u) => u.t).join(' '),
    show: Number(Math.min(chunks[i + 1]?.s ?? Infinity, chunk.e + hold).toFixed(3)),
  }));
}

export function captionLane(width, height) {
  const safe = safeRect(width, height);
  const k = width / (height > width ? 1080 : 1920);
  return { x: safe.left, y: safe.bottom - 102 * k, w: safe.right - safe.left, h: 84 * k };
}
