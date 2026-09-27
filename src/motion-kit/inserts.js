import { CAMERA_DEFAULTS } from './camera.js';
import { EASE, prog } from './motion.js';
import { safeRect } from './safe.js';
import { ref25, secToFrame } from './time.js';

export const INSERT_KINDS = Object.freeze(['stock', 'screen', 'donor', 'scene']);
export const REVEAL_FRAMES = 9;
export const CLOSE_FRAMES = 6;
export const KB_DEFAULT = Object.freeze([1.03, 1.1]);

function assertKb(kb, label) {
  if (!Array.isArray(kb) || kb.length !== 2 || !kb.every((v) => Number.isFinite(v) && v >= 1)) {
    throw new Error(`${label}: kb должен быть парой чисел ≥ 1, например [1.03, 1.1] — получено ${JSON.stringify(kb)}`);
  }
}

// durationInFrames необязателен: без него to не обрезается (совместимость со старыми вызовами,
// которые ещё не знают длительность композиции).
export function compileInserts(inserts = [], { fps, durationInFrames } = {}) {
  const hasDuration = Number.isFinite(durationInFrames);
  return inserts.map((insert, i) => {
    if (!INSERT_KINDS.includes(insert.kind)) {
      throw new Error(`inserts[${i}]: kind должен быть ${INSERT_KINDS.join('|')}`);
    }
    const label = insert.id || insert.kind;
    const from = secToFrame(insert.from, fps);
    if (hasDuration && from >= durationInFrames) {
      throw new Error(`inserts[${i}] (${label}): начинается после конца ролика`);
    }
    let to = secToFrame(insert.to, fps);
    if (hasDuration) to = Math.min(to, durationInFrames);
    if (!(to > from)) throw new Error(`inserts[${i}] (${label}): to должен быть больше from`);
    const cover = insert.cover ?? insert.kind !== 'donor';
    if (cover) {
      // Закрывающая (cover) вставка обязана быть достаточно длинной, чтобы спикер успел
      // вернуться в фокус ДО начала close (awaysFromInserts: away.to = to − close − exit) —
      // короче этого камера не успевает, и на стыке виден размытый/полупрозрачный спикер.
      const minFrames = ref25(CLOSE_FRAMES, fps) + ref25(CAMERA_DEFAULTS.away.exitFrames, fps);
      if (to - from < minFrames) {
        throw new Error(
          `inserts[${i}] (${label}): закрывающая вставка короче ${(minFrames / fps).toFixed(2)} с — камера не успеет вернуть спикера в фокус до начала закрытия`
        );
      }
    }
    const id = insert.id || `${insert.kind}-${i + 1}`;
    const kb = insert.kb ?? KB_DEFAULT;
    assertKb(kb, `inserts[${i}] (${id})`);
    return {
      id, kind: insert.kind, from, to,
      src: insert.src ?? null,
      cover,
      kb,
      sfx: insert.sfx ?? null,
    };
  });
}

// Полноэкранная вставка закрывает спикера на входе и обязана вернуть его ДО начала close (см.
// revealProgress) — иначе сжимающаяся обратно карточка открывает ещё размытого/полупрозрачного
// спикера, и на стыке на миг видно тёмное смазанное кольцо вместо резкого лица. Возврат длится
// ref25(exitFrames) кадров — то же значение, что cameraAt берёт из CAMERA_DEFAULTS.away.exitFrames
// для самого ramp'а (нельзя параметризовать по-другому, иначе ramp и уход разъедутся), и должен
// ЗАКОНЧИТЬСЯ ровно к началу close, поэтому старт возврата сдвинут на close и на exit
// одновременно: away.to = insert.to − close − exit. compileInserts гарантирует cover-вставкам
// длину ≥ close + exit, так что away.to ≥ away.from честно достижим без вырождения в ноль-длину;
// Math.max ниже — подстраховка для вставок, собранных в обход compileInserts.
export function awaysFromInserts(inserts, { fps = 25 } = {}) {
  const close = ref25(CLOSE_FRAMES, fps);
  const exit = ref25(CAMERA_DEFAULTS.away.exitFrames, fps);
  return inserts.filter((insert) => insert.cover)
    .map((insert) => ({ from: insert.from, to: Math.max(insert.from + 1, insert.to - close - exit) }));
}

// Инсеты карточки вставки (для CSS inset()) считаем от той же safe-зоны, что и текстовые
// элементы, а не отдельной константой под 1080x1920 — иначе на 1920x1080 карточка получает
// неправильную высоту (safe-зона 9:16 не подходит для 16:9). top/left у safeRect уже офсеты от
// края; right/bottom safeRect отдаёт абсолютными координатами — переводим их обратно в офсеты.
export function revealCard(width, height) {
  const safe = safeRect(width, height);
  return { top: safe.top, right: width - safe.right, bottom: height - safe.bottom, left: safe.left };
}

// Единое close-окно вставки: revealProgress и insertOpacity обязаны читать один и тот же
// {start, end}, иначе на fps ≠ 25 независимое округление развело бы их кривые на доли кадра, и
// закрывающаяся карточка (opacity) перестала бы совпадать с самой сворачивающейся рамкой (progress).
// Close заканчивается на последнем реально отрисованном кадре (to − 1), как выходы items в
// motion.js, а не на самом to.
export function closeWindow(insert, fps = 25) {
  const end = insert.to - 1;
  const start = Math.min(insert.to - ref25(CLOSE_FRAMES, fps), end - 1);
  return { start, end };
}

// 0 — вставка ещё карточкой внутри safe-зоны, 1 — на весь кадр; null — вставки нет. REVEAL — кадры
// эталонных 25 fps, пересчитываются под fps композиции.
export function revealProgress(frame, insert, fps = 25) {
  if (frame < insert.from || frame >= insert.to) return null;
  const reveal = ref25(REVEAL_FRAMES, fps);
  const { start, end } = closeWindow(insert, fps);
  return prog(frame, insert.from, reveal) * (1 - prog(frame, start, end - start, EASE.inOut));
}

// Угасание вставки к моменту закрытия: 1 до начала close, 0 на последнем кадре (to − 1) — то же
// close-окно, что двигает revealProgress, чтобы вставка не «зависала» видимой дольше карточки.
export function insertOpacity(frame, insert, fps = 25) {
  if (frame < insert.from || frame >= insert.to) return null;
  const { start, end } = closeWindow(insert, fps);
  return 1 - prog(frame, start, end - start, EASE.inOut);
}

// Общая проверка «скомпилированности» вставки для React-компонентов: from/to обязаны быть целыми
// кадрами (compileInserts), а не секундами из сырого plan.js — иначе ошибка расплывчатая (NaN
// где-то в разметке) вместо явного указания на пропущенный compileInserts. Используется всеми
// компонентами, которые рисуют insert после компиляции (FullscreenReveal, StockInsert и будущие
// screen/scene вставки).
export function assertCompiledInsert(insert, component) {
  if (!Number.isInteger(insert.from) || !Number.isInteger(insert.to)) {
    throw new Error(
      `${component} ждёт скомпилированную вставку с кадрами from/to (compileInserts), а получил секунды плана? (insert.id=${insert.id}, from=${insert.from}, to=${insert.to})`
    );
  }
}
