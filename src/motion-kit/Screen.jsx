import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { EASE, prog } from './motion.js';
import { ref25 } from './time.js';

const DOTS = ['#ff5f57', '#febc2e', '#28c840'];

// Нейтральное окно браузера для настоящих скриншотов; цвета задаёт дизайн ролика.
export function BrowserFrame({ url, children, colors = { bar: '#1f2328', text: '#c9d1d9', page: '#ffffff' }, radius = 22 }) {
  return (
    <div style={{ width: '100%', height: '100%', borderRadius: radius, overflow: 'hidden', background: colors.page,
      boxShadow: '0 24px 60px rgba(0,0,0,.35)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 64, flexShrink: 0, background: colors.bar, display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px' }}>
        {DOTS.map((c) => <span key={c} style={{ width: 16, height: 16, borderRadius: 8, background: c }} />)}
        <span style={{ marginLeft: 16, flex: 1, height: 36, borderRadius: 18, background: 'rgba(255,255,255,.08)', color: colors.text,
          fontSize: 22, display: 'flex', alignItems: 'center', padding: '0 18px', whiteSpace: 'nowrap', overflow: 'hidden' }}>{url}</span>
      </div>
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>{children}</div>
    </div>
  );
}

export function scrollOffset(frame, from, to, maxScroll) {
  return maxScroll * prog(frame, from, Math.max(1, to - from), EASE.inOut);
}

// Длинный скриншот страницы прокручивается внутри окна — это «действие» на экране, а не pan/zoom картинки.
export function ScrollShot({ src, from, to, maxScroll = 0 }) {
  const frame = useCurrentFrame();
  const offset = scrollOffset(frame, from, to, maxScroll);
  return <Img src={staticFile(src)} style={{ width: '100%', display: 'block', transform: `translateY(-${offset.toFixed(1)}px)` }} />;
}

export function flashOpacity(frame, at, frames = 6) {
  if (frame < at || frame >= at + frames) return 0;
  return 0.6 * (1 - (frame - at) / frames);
}

// frames — кадры эталонных 25 fps (как REVEAL_FRAMES/CLOSE_FRAMES у вставок), а не кадры
// композиции: переводим их через ref25 здесь, а не внутри flashOpacity, чтобы сама функция
// осталась чистой и работала в уже конкретных кадрах композиции — так, как её вызывает тест.
export function ShutterFlash({ at, frames = 6 }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = flashOpacity(frame, at, ref25(frames, fps));
  return opacity > 0 ? <AbsoluteFill style={{ background: '#ffffff', opacity }} /> : null;
}
