import { ref25, secToFrame } from './time.js';

export const INSERT_KINDS = Object.freeze(['stock', 'screen', 'donor', 'scene']);
const RETURN_FRAMES = 10;

// durationInFrames необязателен: без него to не обрезается (совместимость со старыми вызовами,
// которые ещё не знают длительность композиции).
export function compileInserts(inserts = [], { fps, durationInFrames } = {}) {
  const hasDuration = Number.isFinite(durationInFrames);
  return inserts.map((insert, i) => {
    if (!INSERT_KINDS.includes(insert.kind)) {
      throw new Error(`inserts[${i}]: kind должен быть ${INSERT_KINDS.join('|')}`);
    }
    const from = secToFrame(insert.from, fps);
    if (hasDuration && from >= durationInFrames) {
      throw new Error(`inserts[${i}] (${insert.id || insert.kind}): начинается после конца ролика`);
    }
    let to = secToFrame(insert.to, fps);
    if (hasDuration) to = Math.min(to, durationInFrames);
    if (!(to > from)) throw new Error(`inserts[${i}] (${insert.id || insert.kind}): to должен быть больше from`);
    return {
      id: insert.id || `${insert.kind}-${i + 1}`,
      kind: insert.kind,
      from,
      to,
      src: insert.src ?? null,
      cover: insert.cover ?? insert.kind !== 'donor',
      kb: insert.kb || [1.03, 1.1],
      sfx: insert.sfx ?? null,
    };
  });
}

// Полноэкранная вставка закрывает спикера: он уходит на входе и возвращается к её концу.
export function awaysFromInserts(inserts, { fps = 25 } = {}) {
  const back = ref25(RETURN_FRAMES, fps);
  return inserts.filter((insert) => insert.cover)
    .map((insert) => ({ from: insert.from, to: Math.max(insert.from + 1, insert.to - back) }));
}
