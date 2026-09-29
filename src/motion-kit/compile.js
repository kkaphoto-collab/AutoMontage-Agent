import { compileCamera, withAways } from './camera.js';
import { buildChunks, captionLane } from './captions.js';
import { awaysFromInserts, compileInserts } from './inserts.js';
import { sfxFromItems, thinCues } from './sfx.js';
import { secToFrame } from './time.js';

export const KIT_VERSION = 1;
const ITEM_KINDS = ['text', 'card', 'media'];
// Тот же список, что WAIVABLE в scripts/qa/report.js/profiles.js – совпадение проверяет
// tests/motion-kit-compile.test.js. Не импортируем profiles.js напрямую: kit – ESM-слой, который
// грузят и Remotion, и Node-манифест без CLI-инструментов гейтов, а profiles.js – CommonJS-часть
// именно гейтовой обвязки, заводить между ними прямую зависимость незачем.
export const WAIVABLE_GATES = Object.freeze(['G1', 'G4', 'G11']);

// Автор плана – не гейт, а человек: битый waiver (не тот gate, пустая причина, объект вместо
// массива) должен упасть сразу на layer check понятной русской строкой, а не тихо остаться
// неприменённым или уронить applyWaivers TypeError'ом на форме входа. null принимаем как отсутствие
// поля: `waivers: null` – обычная запись «исключений нет» в сериализованном плане, не опечатка.
function compileWaivers(waivers) {
  if (waivers === undefined || waivers === null) return [];
  if (!Array.isArray(waivers)) throw new Error('waivers должен быть массивом {gate, reason}');
  return waivers.map((w, i) => {
    const okGate = WAIVABLE_GATES.includes(w?.gate);
    const okReason = typeof w?.reason === 'string' && w.reason.trim();
    if (!okGate || !okReason) {
      throw new Error(`waivers[${i}]: исключение возможно только для ${WAIVABLE_GATES.join(', ')} и только с причиной`);
    }
    return { gate: w.gate, reason: w.reason };
  });
}

export function compileItems(items = [], { fps, durationInFrames }) {
  const ids = new Set();
  return items.map((item, i) => {
    if (!item.id || ids.has(item.id)) throw new Error(`items[${i}]: нужен уникальный id`);
    ids.add(item.id);
    if (!ITEM_KINDS.includes(item.kind)) throw new Error(`items ${item.id}: kind должен быть ${ITEM_KINDS.join('|')}`);
    const b = item.box;
    if (!b || ![b.x, b.y, b.w, b.h].every(Number.isFinite)) throw new Error(`items ${item.id}: нужен box {x,y,w,h}`);
    const from = secToFrame(item.at, fps);
    if (from < 0) throw new Error(`items ${item.id}: at не может быть отрицательным`);
    if (from >= durationInFrames) throw new Error(`items ${item.id}: начинается после конца ролика`);
    const until = Math.min(durationInFrames, secToFrame(item.until, fps));
    if (!(until > from)) throw new Error(`items ${item.id}: until должен быть больше at`);
    const enter = item.enter || { kind: 'fly' };
    // Корень настоящего бага (ревью задачи 23): from: [-200] (без y) давал enter.from[1] === undefined,
    // а дальше animOf считал out.dy = undefined * (1 - sp) = NaN – манифест молча получал NaN-габарит,
    // и safe-zone (G5) сравнивал NaN с порогом (всегда false) вместо того, чтобы упасть здесь явно.
    if (enter.from !== undefined) {
      const ok = Array.isArray(enter.from) && enter.from.length === 2 && enter.from.every(Number.isFinite);
      if (!ok) throw new Error(`items ${item.id}: enter.from должен быть парой конечных чисел [dx, dy]`);
    }
    return {
      id: item.id, kind: item.kind, from, until, box: { ...b }, rot: item.rot || 0,
      enter, exit: item.exit || { frames: 5, dir: 'down' }, life: item.life || {},
      bleed: Boolean(item.bleed), sfx: item.sfx ?? null,
      typeFrom: item.type ? secToFrame(item.type.from, fps) : undefined,
      typeTo: item.type ? secToFrame(item.type.to, fps) : undefined,
      typeSfx: item.type ? item.type.sfx : undefined,
      props: item.props || {},
    };
  });
}

// Один вход для рендера (Root.jsx) и для гейтов (buildManifest): камера, items и inserts – в
// кадрах композиции; субтитры (captions.chunks) остаются в секундах, как их отдал buildChunks –
// в кадры их переводит buildManifest.
export function compileLayer(plan, { fps, width, height, durationInFrames, words = [], sfxLibrary = { sounds: {} } }) {
  const inserts = compileInserts(plan.inserts, { fps, durationInFrames });
  const camera = withAways(compileCamera(plan.camera, { fps, width, height, durationInFrames }), awaysFromInserts(inserts, { fps }));
  const items = compileItems(plan.items, { fps, durationInFrames });
  const cues = thinCues(sfxFromItems([...items, ...inserts], plan.sfx, { fps, library: sfxLibrary, durationInFrames }), { fps });
  const captions = plan.captions === false ? null : {
    chunks: buildChunks(words, plan.captions?.chunk),
    lane: plan.captions?.lane || captionLane(width, height),
    // from/to обязаны быть конечными секундами с from < to – иначе captionSpans молча получил бы
    // NaN или окно задом наперёд (опечатка «until» вместо «to» в plan.js) и либо не вырезал бы
    // ничего, либо вырезал бы не то место, без единой ошибки на этапе layer check.
    hide: (plan.captions?.hide || []).map((h, i) => {
      if (!(Number.isFinite(h.from) && Number.isFinite(h.to) && h.from < h.to)) {
        throw new Error(`captions.hide[${i}]: нужны конечные from < to в секундах – получено from=${h.from}, to=${h.to}`);
      }
      return { from: h.from, to: h.to };
    }),
  };
  return {
    kitVersion: KIT_VERSION, fps, width, height, durationInFrames,
    camera, items, inserts, cues, captions,
    hook: plan.hook || 'speaker',
    waivers: compileWaivers(plan.waivers),
  };
}

// Единая точка построения плана: Node-манифест (scripts/motion-kit-node.js) и Root.jsx слоя
// вызывают buildPlan через одну и ту же функцию, чтобы у гейта (секунды, до рендера) и у самого
// рендера были одинаковые сообщения об ошибках и один и тот же скомпилированный слой.
export function compilePlan(buildPlan, ctx) {
  if (typeof buildPlan !== 'function') {
    throw new Error('plan.js должен экспортировать default function buildPlan');
  }
  let plan;
  try {
    plan = buildPlan(ctx);
  } catch (error) {
    // cause хранит исходный стек: по нему Node-манифест называет строку в src/plan.js. План может
    // бросить и не Error (throw 'строка', throw undefined) – тогда в тексте само значение.
    throw new Error(`src/plan.js упал при построении плана – ${error?.message ?? String(error)}`, { cause: error });
  }
  if (typeof plan?.then === 'function') {
    // Отклонённый Promise без обработчика уронил бы процесс (unhandledRejection) уже после этой ошибки.
    Promise.resolve(plan).catch(() => {});
    throw new Error('buildPlan в src/plan.js должен быть синхронным: уберите async и верните объект плана, а не Promise');
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('buildPlan в src/plan.js должен вернуть объект плана');
  }
  return compileLayer(plan, ctx);
}
