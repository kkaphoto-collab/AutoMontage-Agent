import { AbsoluteFill, Freeze, OffthreadVideo, staticFile, useCurrentFrame } from 'remotion';
import { CAMERA_DEFAULTS, cameraAt } from './camera.js';

export function speakerTransform(state, track) {
  const filters = [];
  if (state.blur > 0.05) filters.push(`blur(${state.blur.toFixed(2)}px)`);
  if (state.dim < 0.999) filters.push(`brightness(${state.dim.toFixed(3)})`);
  return {
    position: 'absolute', left: 0, top: 0, width: track.width, height: track.height,
    transformOrigin: `${track.face.x}px ${track.face.y}px`,
    // translate() записан ДО scale(): так итоговый сдвиг точки лица равен ровно dx/dy – то, что
    // читают гейты G1/G2 из манифеста камеры. Поменять порядок на scale() translate() – сдвиг лица
    // начнёт масштабироваться вместе с картинкой, и манифест разойдётся с тем, что видно в кадре.
    transform: `translate(${state.dx.toFixed(3)}px, ${state.dy.toFixed(3)}px) scale(${state.s.toFixed(6)})`,
    filter: filters.length ? filters.join(' ') : undefined,
  };
}

// Заливка краёв боковых планов: центрированный оверскан (по 10 % запаса с каждой стороны от
// уменьшенной вчетверо копии, растянутой в 4,8 раза), а не от левого верхнего угла – иначе
// blur(5px) съедает края и оставляет тёмную полосу шириной в десятки px на R- и top-планах,
// где камера уходит в сторону.
export function speakerFillStyle(track) {
  const { width: w, height: h } = track;
  return {
    position: 'absolute', left: -0.1 * w, top: -0.1 * h, width: w / 4, height: h / 4,
    transform: 'scale(4.8)', transformOrigin: '0 0',
    filter: 'blur(5px) brightness(0.7)',
  };
}

// Мягкий край резкой копии на планах с заливкой: без него копия обрывалась жёстким швом над
// размытой заливкой (вертикальным на L/R, горизонтальным при сдвиге dy). Маска растушёвывает все
// четыре края копии на featherPx пикселей кадра по плавной кривой (smoothstep – без светлой полосы
// на концах линейного перехода): край за пределами кадра дальше featherPx остаётся невидимым, а
// открытый край плавно уходит в заливку. Маска живёт в координатах копии до scale(), поэтому её
// ширина делится на s. Две маски – x на самой копии и y на вложенном блоке: mask-composite
// intersect в Chrome оставлял на вертикальном краю копии светлую линию в 1 px. Гейты не меняются:
// камера, масштаб и сдвиг лица те же.
const SMOOTH = [[0.25, 0.156], [0.5, 0.5], [0.75, 0.844]];
export function speakerEdgeMask(state, track) {
  if (!state.fill) return null;
  const feather = (CAMERA_DEFAULTS.fill.featherPx * track.k) / state.s;
  const at = (t) => (feather * t).toFixed(3);
  const stops = ['transparent 0px', ...SMOOTH.map(([t, a]) => `rgba(0,0,0,${a}) ${at(t)}px`), `#000 ${at(1)}px`,
    `#000 calc(100% - ${at(1)}px)`, ...SMOOTH.map(([t, a]) => `rgba(0,0,0,${a}) calc(100% - ${at(t)}px)`).reverse(), 'transparent 100%'];
  const ramp = (to) => `linear-gradient(to ${to}, ${stops.join(', ')})`;
  return { feather, x: { maskImage: ramp('right') }, y: { maskImage: ramp('bottom') } };
}

// Аватар – один OffthreadVideo muted по глобальному таймкоду (голос идёт из мастер-видео).
// SpeakerLayer обязан стоять на верхнем уровне композиции, а не внутри <Sequence>: useCurrentFrame
// здесь – глобальный кадр исходника, тот же, что видит манифест гейтов.
// Хвост после lastFrame заморожен; открытые края боковых планов залиты уменьшенной размытой копией,
// а резкая копия уходит в заливку мягким краем (speakerEdgeMask).
export function SpeakerLayer({ src, track, lastFrame, trimBefore = 0 }) {
  const frame = useCurrentFrame();
  const state = cameraAt(track, frame);
  if (!state.visible) return null;
  const video = (
    <OffthreadVideo src={staticFile(src)} muted trimBefore={trimBefore || undefined}
      style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
  );
  // lastFrame – кадр композиции (не кадр исходного файла): для клипа длиной N кадров, обрезанного
  // на T кадров спереди (trimBefore = T), это N − 1 − T.
  // Freeze держим смонтированным всегда, когда lastFrame конечен, и переключаем только active –
  // иначе смена обёртки в момент перехода через lastFrame размонтирует и заново монтирует video.
  const held = Number.isFinite(lastFrame)
    ? <Freeze frame={lastFrame} active={frame > lastFrame}>{video}</Freeze>
    : video;
  // Вложенный блок маски стоит всегда (без стиля вне заливки): дерево одно и то же на любом плане,
  // и смена плана с заливкой не размонтирует видео.
  const mask = speakerEdgeMask(state, track);
  return (
    <AbsoluteFill style={{ opacity: state.opacity }}>
      {state.fill ? <div style={speakerFillStyle(track)}>{held}</div> : null}
      <div style={{ ...speakerTransform(state, track), ...mask?.x }}>
        <div style={mask ? { position: 'absolute', inset: 0, ...mask.y } : undefined}>{held}</div>
      </div>
    </AbsoluteFill>
  );
}
