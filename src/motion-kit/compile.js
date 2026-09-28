import { compileCamera, withAways } from './camera.js';
import { buildChunks, captionLane } from './captions.js';
import { awaysFromInserts, compileInserts } from './inserts.js';
import { sfxFromItems, thinCues } from './sfx.js';
import { secToFrame } from './time.js';

export const KIT_VERSION = 1;
const ITEM_KINDS = ['text', 'card', 'media'];

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
    return {
      id: item.id, kind: item.kind, from, until, box: { ...b }, rot: item.rot || 0,
      enter: item.enter || { kind: 'fly' }, exit: item.exit || { frames: 5, dir: 'down' }, life: item.life || {},
      bleed: Boolean(item.bleed), sfx: item.sfx ?? null,
      typeFrom: item.type ? secToFrame(item.type.from, fps) : undefined,
      typeTo: item.type ? secToFrame(item.type.to, fps) : undefined,
      typeSfx: item.type ? item.type.sfx : undefined,
      props: item.props || {},
    };
  });
}

// Один вход для рендера (Root.jsx) и для гейтов (buildManifest): камера, items и inserts — в
// кадрах композиции; субтитры (captions.chunks) остаются в секундах, как их отдал buildChunks —
// в кадры их переводит buildManifest.
export function compileLayer(plan, { fps, width, height, durationInFrames, words = [], sfxLibrary = { sounds: {} } }) {
  const inserts = compileInserts(plan.inserts, { fps, durationInFrames });
  const camera = withAways(compileCamera(plan.camera, { fps, width, height, durationInFrames }), awaysFromInserts(inserts, { fps }));
  const items = compileItems(plan.items, { fps, durationInFrames });
  const cues = thinCues(sfxFromItems([...items, ...inserts], plan.sfx, { fps, library: sfxLibrary, durationInFrames }), { fps });
  const captions = plan.captions === false ? null : {
    chunks: buildChunks(words, plan.captions?.chunk),
    lane: plan.captions?.lane || captionLane(width, height),
    // from/to обязаны быть конечными секундами с from < to — иначе captionSpans молча получил бы
    // NaN или окно задом наперёд (опечатка «until» вместо «to» в plan.js) и либо не вырезал бы
    // ничего, либо вырезал бы не то место, без единой ошибки на этапе layer check.
    hide: (plan.captions?.hide || []).map((h, i) => {
      if (!(Number.isFinite(h.from) && Number.isFinite(h.to) && h.from < h.to)) {
        throw new Error(`captions.hide[${i}]: нужны конечные from < to в секундах — получено from=${h.from}, to=${h.to}`);
      }
      return { from: h.from, to: h.to };
    }),
  };
  return {
    kitVersion: KIT_VERSION, fps, width, height, durationInFrames,
    camera, items, inserts, cues, captions,
    hook: plan.hook || 'speaker',
    waivers: plan.waivers || [],
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
    throw new Error(`src/plan.js упал при построении плана — ${error.message}`);
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('buildPlan в src/plan.js должен вернуть объект плана');
  }
  return compileLayer(plan, ctx);
}
