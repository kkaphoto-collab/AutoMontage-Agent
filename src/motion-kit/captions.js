import { safeRect } from './safe.js';
import { secToFrame } from './time.js';

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
  // Слов может собраться сколько угодно (пауза короче hardGap не рвёт цепочку короче minDur),
  // а полоса субтитров — одна строка с overflow hidden: без потолка текст молча обрежется, и
  // гейт G5 не увидит переполнение. Поэтому слияние отменяется, если результат вышел бы за
  // maxWords+1 слов или maxChars+8 знаков — короткий кусок в этом случае остаётся отдельным.
  const charsOf = (units) => units.reduce((n, u) => n + u.t.length, 0) + units.length - 1;
  for (let i = 0; i < chunks.length - 1; i += 1) {
    const merged = [...chunks[i].units, ...chunks[i + 1].units];
    if (chunks[i].e - chunks[i].s < minDur && chunks[i + 1].s - chunks[i].e <= hardGap
      && merged.length <= maxWords + 1 && charsOf(merged) <= maxChars + 8) {
      chunks[i + 1] = { units: merged, s: chunks[i].s, e: chunks[i + 1].e };
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

// Кадры видимости субтитра в композиции — общее правило и для рендера (Subtitles), и для
// манифеста (buildManifest): гейт обязан видеть ровно то, что нарисовано. secToFrame — тот же
// перевод секунд в кадры, что compileItems/compileInserts используют для всех остальных границ
// плана, поэтому окно hide, заданное теми же секундами, что и вставка (insert.from/to), вырезает
// ровно её кадры (проверено тестом рядом с compileInserts). until клэмпится под durationInFrames.
export function captionSpans(chunks, { hide = [], fps, durationInFrames } = {}) {
  const hideFrames = hide
    .map((h) => [secToFrame(h.from, fps), secToFrame(h.to, fps)])
    .filter(([from, to]) => to > from);
  // Сырые [from, until) каждого chunk, ещё без вырезания hide. buildChunks независимо округляет
  // e+hold через toFixed(3), а s следующего chunk — нет: на некоторых fps и долях секунды это может
  // дать until чуть больше следующего from (например: chunk0.e=0.4506, chunk1.s=0.4596 при
  // fps=25 — show после toFixed(3) становится 0.46, secToFrame(0.46,25)=12, а secToFrame(0.4596,25)
  // всё ещё 11 — 1 кадр перекрытия). Обрезаем текущий until следующим from, чтобы два chunk никогда
  // не претендовали на один и тот же кадр — иначе Subtitles.find() и манифест могли бы разойтись
  // в том, какой из двух текстов «на самом деле» показан на этом кадре.
  const raw = chunks.map((chunk) => ({
    from: secToFrame(chunk.s, fps),
    until: Math.min(durationInFrames, secToFrame(chunk.show, fps)),
  }));
  for (let i = 0; i < raw.length - 1; i += 1) {
    if (raw[i].until > raw[i + 1].from) raw[i].until = raw[i + 1].from;
  }
  const spans = [];
  raw.forEach(({ from, until }, index) => {
    if (!(until > from)) return;
    let pieces = [[from, until]];
    for (const [hFrom, hTo] of hideFrames) {
      const next = [];
      for (const [s, e] of pieces) {
        if (hTo <= s || hFrom >= e) { next.push([s, e]); continue; }
        if (hFrom > s) next.push([s, hFrom]);
        if (hTo < e) next.push([hTo, e]);
      }
      pieces = next;
    }
    for (const [s, e] of pieces) if (e > s) spans.push({ index, from: s, until: e });
  });
  return spans;
}

// Секундная развёртка для plan.js и внешних вызовов (миллиметраж режиссуры) — тот же кадр, что
// видит captionSpans, только на входе секунды. durationInFrames вызывающему не важен: activeChunk
// смотрит только на границы самих chunks/hide, а не на длину ролика, поэтому клэмп отключён
// (Infinity).
export function activeChunk(chunks, sec, hide = [], fps = 25) {
  const frame = secToFrame(sec, fps);
  const span = captionSpans(chunks, { hide, fps, durationInFrames: Infinity }).find((s) => frame >= s.from && frame < s.until);
  return span ? chunks[span.index] : null;
}

const LINE_HEIGHT = 1.1;
// Доля кегля, которую тень добавляет под строкой (см. shadowBlur = size*12/44 в Subtitles.jsx) —
// запас, чтобы overflow:hidden узкой полосы не обрезал нижний край тени.
const SHADOW_RATIO = 12 / 44;

// Клэмп кегля под высоту полосы: строка (lineHeight×size) плюс запас под тень не должны вылезать
// за lane.h. Только сокращает — высокая кастомная полоса не должна раздувать субтитры сверх base
// (кегль от разрешения композиции, см. Subtitles.jsx), только тесная полоса обязана его сжать.
export function captionFontSize({ base, laneH }) {
  const maxByHeight = laneH / (LINE_HEIGHT + SHADOW_RATIO);
  return Math.min(base, maxByHeight);
}

// Один шаг бинарного поиска ширины — та же схема, что инлайн использует TextBox из
// src/motion/parts.jsx (if (fits) low = mid; else high = mid;), вынесенная в чистую функцию: сам
// поиск измеряет DOM (scrollWidth), а сужение границ — нет, поэтому тестируется без браузера.
export function narrowFitBounds({ low, high, fits }) {
  const mid = (low + high) / 2;
  return fits ? { low: mid, high } : { low, high: mid };
}

export function captionLane(width, height) {
  const safe = safeRect(width, height);
  const k = width / (height > width ? 1080 : 1920);
  return { x: safe.left, y: safe.bottom - 102 * k, w: safe.right - safe.left, h: 84 * k };
}
