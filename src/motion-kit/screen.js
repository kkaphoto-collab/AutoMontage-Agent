import { EASE, prog } from './motion.js';
import { ref25 } from './time.js';

export const BROWSER_COLORS = Object.freeze({ bar: '#1f2328', text: '#c9d1d9', page: '#ffffff' });
export const FLASH_FRAMES = 6; // эталонные 25fps кадры — тот же смысл, что REVEAL_FRAMES/CLOSE_FRAMES у вставок.

// Доля прокрутки страницы (0..1), а не пиксели: plan.js не знает натуральный размер картинки,
// поэтому фиксированный maxScroll в px мог упереться в белый низ скриншота раньше конца окна.
// scroll — какую долю страницы нужно показать к концу окна (обычно 1 — всю), клэмпится в [0,1]:
// ScrollShot переводит долю в objectPosition, а не в translateY, поэтому физически не может
// проскроллить мимо своего низа — короткий скриншот просто почти не двигается.
export function scrollShare(frame, from, to, scroll = 1) {
  const share = Math.min(1, Math.max(0, scroll));
  return share * prog(frame, from, Math.max(1, to - from), EASE.inOut);
}

// frame/at — кадры композиции; frames — эталонные 25fps кадры, переводятся в кадры композиции
// прямо здесь через fps, поэтому «frames» значит одно и то же и в компоненте, и в тесте — не
// путается между эталонными и уже посчитанными под fps кадрами, как было раньше.
export function flashOpacity(frame, at, fps = 25, frames = FLASH_FRAMES) {
  const span = ref25(frames, fps);
  if (frame < at || frame >= at + span) return 0;
  return 0.6 * (1 - (frame - at) / span);
}
