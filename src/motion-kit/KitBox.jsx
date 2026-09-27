import { useCurrentFrame, useVideoConfig } from 'remotion';
import { animOf } from './motion.js';

export function kitBoxStyle(item, frame, fps) {
  const a = animOf(item, frame, fps);
  return {
    position: 'absolute', left: item.box.x, top: item.box.y, width: item.box.w, height: item.box.h,
    opacity: a.o,
    transform: `translate(${a.dx.toFixed(2)}px, ${a.dy.toFixed(2)}px) scale(${a.s.toFixed(4)}) rotate(${a.rot.toFixed(2)}deg)`,
    transformOrigin: 'center center',
    filter: a.blur > 0.05 ? `blur(${a.blur.toFixed(2)}px)` : undefined,
    clipPath: a.clip || undefined,
  };
}

// Любой текст и карточка слоя живут внутри KitBox: тогда гейт safe-zone видит их габарит.
export function KitBox({ item, children }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < item.from || frame >= item.until) return null;
  const marker = item.kind === 'media' || item.bleed ? {} : { 'data-kit-text': item.id };
  return <div {...marker} style={kitBoxStyle(item, frame, fps)}>{children}</div>;
}
