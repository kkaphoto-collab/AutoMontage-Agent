import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { BROWSER_COLORS, FLASH_FRAMES, flashOpacity, scrollShare } from './screen.js';

const DOTS = ['#ff5f57', '#febc2e', '#28c840'];

// Хром окна масштабируется под реальное разрешение так же, как safe-зона и радиус вставок:
// k = короткая сторона кадра / 1080. scale — явный override (например, для превью в интерфейсе
// Review, где composition-разрешение не совпадает с тем, что должен «увидеть» браузер).
export function BrowserFrame({ url, children, colors = {}, radius = 22, scale, fontFamily = 'sans-serif' }) {
  const { width, height } = useVideoConfig();
  const k = scale ?? Math.min(width, height) / 1080;
  const c = { ...BROWSER_COLORS, ...colors };
  const px = (value) => Math.round(value * k * 10) / 10;
  return (
    <div style={{ width: '100%', height: '100%', borderRadius: px(radius), overflow: 'hidden', background: c.page,
      boxShadow: `0 ${px(24)}px ${px(60)}px rgba(0,0,0,.35)`, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: px(64), flexShrink: 0, background: c.bar, display: 'flex', alignItems: 'center', gap: px(12), padding: `0 ${px(20)}px` }}>
        {DOTS.map((color) => <span key={color} style={{ width: px(16), height: px(16), borderRadius: px(8), background: color }} />)}
        <span style={{ marginLeft: px(16), flex: 1, height: px(36), borderRadius: px(18), background: 'rgba(255,255,255,.08)', color: c.text,
          fontFamily, fontSize: px(22), display: 'flex', alignItems: 'center', padding: `0 ${px(18)}px`,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{url}</span>
      </div>
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>{children}</div>
    </div>
  );
}

// Показывает долю страницы (scrollShare), а не пиксельный сдвиг: objectPosition тянет видимое
// окно cover-картинки по вертикали и физически не может уехать мимо её низа, в отличие от
// прежнего translateY(-px), который не знал натуральную высоту скриншота и рисковал прокрутить в
// белую пустоту раньше конца окна.
export function ScrollShot({ src, from, to, scroll = 1 }) {
  const frame = useCurrentFrame();
  const p = scrollShare(frame, from, to, scroll);
  return (
    <Img src={staticFile(src)} style={{
      position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
      objectPosition: `50% ${(100 * p).toFixed(2)}%`,
    }} />
  );
}

export function ShutterFlash({ at, frames = FLASH_FRAMES }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = flashOpacity(frame, at, fps, frames);
  return opacity > 0 ? <AbsoluteFill style={{ background: '#ffffff', opacity }} /> : null;
}
