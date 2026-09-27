import { cameraAt } from './camera.js';
import { itemExtentAt } from './motion.js';

const r3 = (value) => Math.round(value * 1000) / 1000;

// Сериализуемый снимок слоя: камера и габариты текста по кадрам, вставки, звуки, хук, исключения.
export function buildManifest(compiled) {
  const { fps, width, height, durationInFrames } = compiled;
  const camera = { s: [], requested: [], dx: [], dy: [], blur: [], opacity: [] };
  for (let frame = 0; frame < durationInFrames; frame += 1) {
    const c = cameraAt(compiled.camera, frame);
    camera.s.push(r3(c.s));
    camera.requested.push(r3(c.requested));
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
    const { lane, chunks } = compiled.captions;
    chunks.forEach((chunk, i) => {
      const from = Math.round(chunk.s * fps);
      const until = Math.min(durationInFrames, Math.round(chunk.show * fps));
      if (until > from) {
        texts.push({ id: `caption-${i + 1}`, from, until, static: [r3(lane.x), r3(lane.y), r3(lane.x + lane.w), r3(lane.y + lane.h)] });
      }
    });
  }
  return {
    version: 1, kitVersion: compiled.kitVersion, fps, width, height, durationInFrames,
    maxScale: compiled.camera.maxScale,
    camera,
    texts,
    inserts: compiled.inserts.map((insert) => ({ id: insert.id, kind: insert.kind, from: insert.from, to: insert.to })),
    cues: {
      kept: compiled.cues.kept.map((cue) => ({ id: cue.id, name: cue.name, startFrame: cue.startFrame, hitFrame: cue.hitFrame, notable: cue.notable, bed: cue.bed })),
      dropped: compiled.cues.dropped.map((entry) => ({ id: entry.cue.id, conflictWith: entry.conflictWith, reason: entry.reason })),
    },
    hook: compiled.hook,
    waivers: compiled.waivers,
  };
}
