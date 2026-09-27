import { AbsoluteFill, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { insertOpacity, KB_DEFAULT, revealCard, revealProgress } from './inserts.js';

export function FullscreenReveal({ insert, children }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const p = revealProgress(frame, insert, fps);
  if (p === null) return null;
  const opacity = insertOpacity(frame, insert, fps);
  const card = revealCard(width, height);
  const inset = (value) => (value * (1 - p)).toFixed(1);
  // Тот же коэффициент, что и safeRect: ширина к канону 1080 (портрет) / 1920 (ландшафт) — радиус
  // скругления масштабируется вместе с реальным разрешением композиции.
  const portrait = height > width;
  const radius = 28 * (width / (portrait ? 1080 : 1920));
  const clipPath = `inset(${inset(card.top)}px ${inset(card.right)}px ${inset(card.bottom)}px ${inset(card.left)}px round ${(radius * (1 - p)).toFixed(1)}px)`;
  return <AbsoluteFill data-kit-bleed={insert.id} style={{ clipPath, opacity }}>{children}</AbsoluteFill>;
}

// StockInsert получает уже скомпилированную вставку (compileInserts): from/to — кадры глобального
// таймкода, а не секунды плана. Сам StockInsert обязан стоять на верхнем уровне композиции, а не
// внутри чужой <Sequence> — useCurrentFrame() здесь глобальный кадр (от него считают и Ken Burns,
// и revealProgress), как и в SpeakerLayer. Внутренний <Sequence from={insert.from}> нужен только
// видео стока: оно проигрывается с собственного нуля, а не с глобального таймкода, как аватар.
export function StockInsert({ insert, children = null }) {
  const frame = useCurrentFrame();
  if (!Number.isInteger(insert.from) || !Number.isInteger(insert.to)) {
    throw new Error(
      `StockInsert ждёт скомпилированную вставку с кадрами from/to (compileInserts), а получил секунды плана? (insert.id=${insert.id}, from=${insert.from}, to=${insert.to})`
    );
  }
  const kb = insert.kb || KB_DEFAULT;
  const t = Math.min(1, Math.max(0, (frame - insert.from) / Math.max(1, insert.to - insert.from)));
  const zoom = kb[0] + (kb[1] - kb[0]) * t;
  return (
    <FullscreenReveal insert={insert}>
      <AbsoluteFill style={{ transform: `scale(${zoom.toFixed(4)})` }}>
        <Sequence from={insert.from} durationInFrames={insert.to - insert.from} layout="none">
          <OffthreadVideo src={staticFile(insert.src)} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </Sequence>
      </AbsoluteFill>
      {children}
    </FullscreenReveal>
  );
}
