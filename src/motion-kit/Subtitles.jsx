import { useCurrentFrame, useVideoConfig } from 'remotion';
import { captionSpans } from './captions.js';

const round1 = (value) => Math.round(value * 10) / 10;

// Секундная развёртка для внешних вызовов (миллиметраж plan.js) и тестов плана — сам компонент
// решает видимость по кадру через captionSpans (см. ниже), то же правило, что видит buildManifest,
// поэтому на дробном s*fps рендер и манифест не расходятся на кадр.
export function activeChunk(chunks, sec, hide = []) {
  if (hide.some((h) => sec >= h.from && sec < h.to)) return null;
  return chunks.find((chunk) => sec >= chunk.s && sec < chunk.show) || null;
}

// 1–4 слова в полосе внутри safe-зоны; ещё не сказанные слова приглушены (караоке, по секундам —
// внутри уже видимого chunk дробный кадр не создаёт заметного глазу рассинхрона). Видимость самого
// chunk решает captionSpans по текущему кадру — то же самое, что видит buildManifest в
// out/manifest.json, поэтому гейт видит ровно то, что нарисовано. fontSize и тень масштабируются
// вместе с полосой (44px и тень «0 3px 12px» — эталон при lane.h=84, как на 1080x1920); явный
// fontSize перекрывает расчёт.
export function Subtitles({ chunks, lane, hide = [], fontFamily = 'sans-serif', fontSize, color = '#ffffff',
  dimOpacity = 0.45, accent = null, accentWords = [] }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const span = captionSpans(chunks, hide, fps, durationInFrames).find((s) => frame >= s.from && frame < s.until);
  if (!span) return null;
  const chunk = chunks[span.index];
  const sec = frame / fps;
  const k = lane.h / 84;
  const size = fontSize ?? round1(44 * k);
  const shadowY = round1(3 * k);
  const shadowBlur = round1(12 * k);
  return (
    <div data-kit-text="captions" style={{ position: 'absolute', left: lane.x, top: lane.y, width: lane.w, height: lane.h,
      display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', overflow: 'hidden' }}>
      <span style={{ fontFamily, fontSize: size, fontWeight: 800, color, lineHeight: 1.1,
        textShadow: `0 ${shadowY}px ${shadowBlur}px rgba(0,0,0,.55)` }}>
        {chunk.units.map((unit, i) => (
          <span key={i} style={{ opacity: sec >= unit.s ? 1 : dimOpacity,
            color: accent && accentWords.includes(unit.t.replace(/[.,!?…:;]+$/u, '')) ? accent : undefined }}>
            {i ? ' ' : ''}{unit.t}
          </span>
        ))}
      </span>
    </div>
  );
}
