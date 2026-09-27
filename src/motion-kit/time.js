export const secToFrame = (sec, fps) => Math.round(sec * fps + 1e-6);
export const frameToSec = (frame, fps) => frame / fps;
