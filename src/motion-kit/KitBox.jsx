import { useCurrentFrame, useVideoConfig } from 'remotion';
import { animOf, isShown } from './motion.js';

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

// Содержимое должно помещаться внутри item.box: гейт safe-zone (G5) видит именно этот
// прямоугольник, а не то, что текст реально нарисовал внутри (переполнение он не ловит).
export function KitBox({ item, children }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!Number.isFinite(item.from) || !Number.isFinite(item.until)) {
    // Частая ошибка – передать в KitBox сырой items[] из plan.js (там at/until в секундах плана,
    // а не item.from/until в кадрах композиции). KitBox рендерится на верхнем уровне, а не внутри
    // <Sequence>, и всегда ждёт результат compileLayer/compileItems.
    throw new Error(
      `KitBox ждёт скомпилированный элемент с кадрами from/until (compileLayer/compileItems), а получил секунды плана? (item.id=${item.id}, from=${item.from}, until=${item.until})`
    );
  }
  // Окно показа не проверяем отдельно: animOf сам возвращает o:0 вне [from, until), и isShown
  // отсекает этот случай той же единой проверкой, что использует манифест (itemExtentAt).
  const a = animOf(item, frame, fps);
  if (!isShown(a)) return null;
  const marker = item.kind === 'media' || item.bleed ? {} : { 'data-kit-text': item.id };
  return <div {...marker} style={kitBoxStyle(item, frame, fps)}>{children}</div>;
}
