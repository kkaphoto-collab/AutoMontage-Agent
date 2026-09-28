import { cameraAt } from './camera.js';
import { captionSpans } from './captions.js';
import { itemExtentAt } from './motion.js';

const r3 = (value) => Math.round(value * 1000) / 1000;

// Сериализуемый снимок слоя: камера и габариты текста по кадрам, вставки, звуки, хук, исключения.
export function buildManifest(compiled) {
  const { fps, width, height, durationInFrames } = compiled;
  // base — с ревью пакета 2 задачи 22: масштаб пресета с дрейфом ДО панчей и ДО клэмпа maxScale,
  // читает G3 (scripts/qa/timeline-gates.js), чтобы отличить пресет крупнее предела от панча,
  // упёршегося в потолок.
  const camera = { s: [], requested: [], base: [], dx: [], dy: [], blur: [], opacity: [] };
  for (let frame = 0; frame < durationInFrames; frame += 1) {
    const c = cameraAt(compiled.camera, frame);
    camera.s.push(r3(c.s));
    camera.requested.push(r3(c.requested));
    camera.base.push(r3(c.base));
    camera.dx.push(r3(c.dx));
    camera.dy.push(r3(c.dy));
    camera.blur.push(r3(c.blur));
    camera.opacity.push(r3(c.opacity));
  }
  const texts = compiled.items.filter((item) => item.kind !== 'media' && !item.bleed).map((item) => {
    const frames = [];
    for (let frame = item.from; frame < item.until; frame += 1) {
      const r = itemExtentAt(item, frame, fps);
      frames.push(r ? [r3(r.left), r3(r.top), r3(r.right), r3(r.bottom)] : null);
    }
    return { id: item.id, from: item.from, frames };
  });
  if (compiled.captions) {
    const { lane, chunks, hide } = compiled.captions;
    // Один источник видимости с Subtitles (captionSpans) — гейт видит ровно те кадры, где рендер
    // рисует текст. Окно hide может разрезать chunk на несколько span: первому достаётся
    // caption-<n>, следующим — caption-<n>b, caption-<n>c… (детерминированная схема, id остаются
    // уникальными и стабильными между запусками).
    const staticBox = [r3(lane.x), r3(lane.y), r3(lane.x + lane.w), r3(lane.y + lane.h)];
    let lastIndex = null;
    let piece = 0;
    for (const span of captionSpans(chunks, { hide, fps, durationInFrames })) {
      piece = span.index === lastIndex ? piece + 1 : 0;
      lastIndex = span.index;
      const id = piece === 0 ? `caption-${span.index + 1}` : `caption-${span.index + 1}${String.fromCharCode(97 + piece)}`;
      texts.push({ id, from: span.from, until: span.until, static: staticBox });
    }
  }
  return {
    version: 1, kitVersion: compiled.kitVersion, fps, width, height, durationInFrames,
    maxScale: compiled.camera.maxScale,
    camera,
    texts,
    // cover и src — с Task 22: G4 читает cover (закрыта ли вставкой сцена под ней), Task 38 читает
    // src в предупреждении о коротком стоковом файле.
    inserts: compiled.inserts.map((insert) => ({ id: insert.id, kind: insert.kind, from: insert.from, to: insert.to, cover: insert.cover, src: insert.src })),
    cues: {
      kept: compiled.cues.kept.map((cue) => ({ id: cue.id, name: cue.name, startFrame: cue.startFrame, hitFrame: cue.hitFrame, notable: cue.notable, bed: cue.bed })),
      dropped: compiled.cues.dropped.map((entry) => ({ id: entry.cue.id, conflictWith: entry.conflictWith, reason: entry.reason })),
    },
    hook: compiled.hook,
    waivers: compiled.waivers,
  };
}
