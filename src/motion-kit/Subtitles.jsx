import { useLayoutEffect, useRef } from 'react';
import { cancelRender, continueRender, delayRender, useCurrentFrame, useVideoConfig } from 'remotion';
import { captionFontSize, captionSpans, narrowFitBounds } from './captions.js';
import { secToFrame } from './time.js';
import { normWord } from './words.js';

const round1 = (value) => Math.round(value * 10) / 10;
// Тень при кегле 44px — «0 3px 12px», зафиксированные тестами отношения к самому кеглю.
const SHADOW_Y_RATIO = 3 / 44;
const SHADOW_BLUR_RATIO = 12 / 44;
const LINE_HEIGHT_CSS = 1.1;

// Важно: Subtitles обязан монтироваться на верхнем уровне композиции (как SpeakerLayer/SfxTrack),
// а не внутри чужой <Sequence> — иначе useCurrentFrame()/useVideoConfig().durationInFrames стали
// бы локальными для этой Sequence, и captionSpans здесь считал бы кадры не от начала ролика, как
// buildManifest, а от начала Sequence — рендер и манифест разошлись бы на кадр её сдвига.
//
// 1–4 слова в полосе внутри safe-зоны; ещё не сказанные слова приглушены (караоке, по кадру через
// secToFrame — тот же перевод секунд в кадры, что использует compileInserts/compileItems, поэтому
// первое слово загорается ровно на первом видимом кадре chunk, без паразитного «немого» кадра из-за
// независимого округления). Видимость самого chunk решает captionSpans по текущему кадру — то же
// самое, что видит buildManifest в out/manifest.json, поэтому гейт видит ровно то, что нарисовано.
//
// Кегль — от разрешения композиции (тот же k, что captionLane использует под safe-зону), а не от
// высоты полосы: кастомная полоса не должна раздувать текст. captionFontSize только УМЕНЬШАЕТ base
// под тесную полосу (высота + запас под тень). Ширина — nowrap с автоподгонкой: как TextBox в
// src/motion/parts.jsx (useLayoutEffect + delayRender + бинарный поиск по scrollWidth), только
// подгоняем ширину одной строки, а не перенос. В SSR-тестах layout-эффекты не выполняются, поэтому
// рендерится непорезанный (до подгонки) размер — captionFontSize уже гарантирует, что он не вылезет
// по высоте, а перенос строк исключён самим nowrap.
export function Subtitles({ chunks, lane, hide = [], fontFamily = 'sans-serif', fontSize, color = '#ffffff',
  dimOpacity = 0.45, accent = null, accentWords = [] }) {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const span = captionSpans(chunks, { hide, fps, durationInFrames }).find((s) => frame >= s.from && frame < s.until);
  const chunk = span ? chunks[span.index] : null;

  const k = width / (height > width ? 1080 : 1920);
  const base = fontSize ?? 44 * k;
  const size = round1(captionFontSize({ base, laneH: lane.h }));
  const shadowY = round1(size * SHADOW_Y_RATIO);
  const shadowBlur = round1(size * SHADOW_BLUR_RATIO);

  const textRef = useRef(null);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return; // нечего показывать — подгонять нечего, delayRender не нужен.
    const handle = delayRender('motion-kit: подгонка субтитров');
    // Измерение синхронно (scrollWidth уже доступен сразу после layout), в отличие от TextBox,
    // которому нужен await document.fonts.load — поэтому здесь не нужен cancelled-флаг на случай
    // размонтирования посреди async-паузы: цикл всегда успевает завершиться до commit.
    try {
      let low = 1;
      let high = size;
      // 0.25px — тот же порог сходимости, что и в TextBox.
      while (high - low > 0.25) {
        const mid = (low + high) / 2;
        el.style.fontSize = `${mid}px`;
        const fits = el.scrollWidth <= lane.w + 1;
        ({ low, high } = narrowFitBounds({ low, high, fits }));
      }
      el.style.fontSize = `${Math.floor(low * 4) / 4}px`;
    } catch (error) {
      cancelRender(error);
    } finally {
      continueRender(handle);
    }
    // Подгонка обязана перезапускаться только когда меняется реально видимый текст, доступная
    // ширина полосы, расчётный (до подгонки) кегль или шрифт — не на каждый кадр внутри одного и
    // того же chunk (иначе каждый кадр видео ждал бы новый delayRender).
  }, [chunk?.text, lane.w, size, fontFamily]);

  if (!chunk) return null;
  const accentSet = accent ? new Set(accentWords.map(normWord)) : null;
  return (
    <div data-kit-text="captions" style={{ position: 'absolute', left: lane.x, top: lane.y, width: lane.w, height: lane.h,
      display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', overflow: 'hidden' }}>
      <span ref={textRef} style={{ fontFamily, fontSize: size, fontWeight: 800, color, lineHeight: LINE_HEIGHT_CSS,
        whiteSpace: 'nowrap', textShadow: `0 ${shadowY}px ${shadowBlur}px rgba(0,0,0,.55)` }}>
        {chunk.units.map((unit, i) => (
          <span key={i} style={{ opacity: frame >= secToFrame(unit.s, fps) ? 1 : dimOpacity,
            color: accentSet && accentSet.has(normWord(unit.t)) ? accent : undefined }}>
            {i ? ' ' : ''}{unit.t}
          </span>
        ))}
      </span>
    </div>
  );
}
