import { AbsoluteFill, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { EASE, prog } from './motion.js';
import { safeRect } from './safe.js';
import { ref25 } from './time.js';

export const REVEAL_FRAMES = 9;
export const CLOSE_FRAMES = 6;

// Инсеты карточки вставки (для CSS inset()) считаем от той же safe-зоны, что и текстовые
// элементы, а не отдельной константой под 1080x1920 — иначе на 1920x1080 карточка получает
// неправильную высоту (safe-зона 9:16 не подходит для 16:9). top/left — уже офсеты от края,
// right/bottom safeRect отдаёт как абсолютные координаты — переводим их обратно в офсеты.
export function revealCard(width, height) {
  const safe = safeRect(width, height);
  return { top: safe.top, right: width - safe.right, bottom: height - safe.bottom, left: safe.left };
}

// 0 — вставка ещё карточкой внутри safe-зоны, 1 — на весь кадр; null — вставки нет.
// REVEAL/CLOSE — кадры эталонных 25 fps, пересчитываются под fps композиции.
export function revealProgress(frame, insert, fps = 25) {
  if (frame < insert.from || frame >= insert.to) return null;
  const reveal = ref25(REVEAL_FRAMES, fps);
  const close = ref25(CLOSE_FRAMES, fps);
  return prog(frame, insert.from, reveal) * (1 - prog(frame, insert.to - close, close, EASE.inOut));
}

export function FullscreenReveal({ insert, children }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const p = revealProgress(frame, insert, fps);
  if (p === null) return null;
  const card = revealCard(width, height);
  const inset = (value) => (value * (1 - p)).toFixed(1);
  // Радиус скругления задан для короткой стороны 1080 (портрет) / 1920 (ландшафт) и масштабируется
  // вместе с реальным разрешением композиции — та же логика, что camera.js применяет к пресетам.
  const portrait = height > width;
  const radius = 28 * (width / (portrait ? 1080 : 1920));
  const clipPath = `inset(${inset(card.top)}px ${inset(card.right)}px ${inset(card.bottom)}px ${inset(card.left)}px round ${(radius * (1 - p)).toFixed(1)}px)`;
  return <AbsoluteFill data-kit-bleed={insert.id} style={{ clipPath }}>{children}</AbsoluteFill>;
}

// Сток играет с собственного нуля (Sequence), в отличие от аватара; звук стока всегда выключен.
// kb необязателен в контракте (`kb?: [1.03, 1.1]`) — свой дефолт держим и здесь, а не только в
// compileInserts, потому что StockInsert может получить вставку и напрямую, без компиляции.
export function StockInsert({ insert, children = null }) {
  const frame = useCurrentFrame();
  const kb = insert.kb || [1.03, 1.1];
  const t = Math.min(1, Math.max(0, (frame - insert.from) / Math.max(1, insert.to - insert.from)));
  const zoom = kb[0] + (kb[1] - kb[0]) * t;
  return (
    <FullscreenReveal insert={insert}>
      <AbsoluteFill style={{ transform: `scale(${zoom.toFixed(4)})` }}>
        <Sequence from={insert.from} layout="none">
          <OffthreadVideo src={staticFile(insert.src)} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </Sequence>
      </AbsoluteFill>
      {children}
    </FullscreenReveal>
  );
}
