export const secToFrame = (sec, fps) => Math.round(sec * fps + 1e-6);
export const frameToSec = (frame, fps) => frame / fps;

// Константы камеры заданы в кадрах эталона 25 fps – переводим в кадры целевого fps, секунды
// остаются те же (12 кадров на 50 fps = 6 кадров на 25 fps = 0,24 с).
export const ref25 = (frames, fps) => Math.max(1, Math.round((frames * fps) / 25));
