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

// Зазор между краем кадра и краем резкой копии, px кадра (> 0 – с этой стороны видна заливка).
function copyGaps(state, { face, width, height }) {
  return {
    left: face.x * (1 - state.s) + state.dx,
    right: width - (face.x + state.dx + state.s * (width - face.x)),
    top: face.y * (1 - state.s) + state.dy,
    bottom: height - (face.y + state.dy + state.s * (height - face.y)),
  };
}

// Наибольший зазор каждой стороны за весь план: сколько кадра эта сторона вообще открывает (сдвиг
// пресета, покачивание, дрейф и панч). Кэш по дорожке и плану: Remotion считает кадры по одному.
const reachCache = new WeakMap();
function shotReach(track, index) {
  let byShot = reachCache.get(track);
  if (!byShot) { byShot = new Map(); reachCache.set(track, byShot); }
  if (!byShot.has(index)) {
    const shot = track.shots[index];
    const reach = { left: -Infinity, right: -Infinity, top: -Infinity, bottom: -Infinity };
    for (let f = shot.from; f < shot.to; f += 1) {
      const gaps = copyGaps(cameraAt(track, f), track);
      for (const side of Object.keys(reach)) reach[side] = Math.max(reach[side], gaps[side]);
    }
    byShot.set(index, reach);
  }
  return byShot.get(index);
}

// Мягкий край резкой копии на планах с заливкой: без него копия обрывалась жёстким швом над
// размытой заливкой (вертикальным на L/R, горизонтальным при сдвиге dy). Каждая сторона копии
// растушёвана по плавной кривой (smoothstep – без светлой полосы на концах линейного перехода) на
// столько, сколько она открывает за план, но не больше featherPx и не меньше minFeatherPx: открытый
// край плавно уходит в заливку, а край, который стоит на краю кадра и открывается только
// покачиванием (бока top при s = 1), не заменяет настоящую картинку размытой заливкой на 96 px.
// Маска живёт в координатах копии до scale(), поэтому её ширина делится на s. Две маски – x на
// самой копии и y на вложенном блоке: mask-composite intersect в Chrome оставлял на вертикальном
// краю копии светлую линию в 1 px. Гейты не меняются: камера, масштаб и сдвиг лица те же.
const SMOOTH = [[0.25, 0.156], [0.5, 0.5], [0.75, 0.844]];
export function speakerEdgeMask(state, track) {
  if (!state.fill) return null;
  const { featherPx, minFeatherPx } = CAMERA_DEFAULTS.fill;
  const reach = shotReach(track, state.shot);
  const feather = Object.fromEntries(Object.entries(reach).map(([side, px]) => [side,
    Math.min(featherPx * track.k, Math.max(minFeatherPx * track.k, px)) / state.s]));
  const px = (value) => `${value.toFixed(3)}px`;
  const ramp = (to, head, tail) => `linear-gradient(to ${to}, ${['transparent 0px',
    ...SMOOTH.map(([t, a]) => `rgba(0,0,0,${a}) ${px(head * t)}`), `#000 ${px(head)}`, `#000 calc(100% - ${px(tail)})`,
    ...SMOOTH.map(([t, a]) => `rgba(0,0,0,${a}) calc(100% - ${px(tail * t)})`).reverse(), 'transparent 100%'].join(', ')})`;
  return {
    feather,
    x: { maskImage: ramp('right', feather.left, feather.right) },
    y: { maskImage: ramp('bottom', feather.top, feather.bottom) },
  };
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
  // Вложенный блок маски стоит всегда: дерево одно и то же на любом плане, и смена плана с заливкой
  // не размонтирует видео. Он всегда растянут на всю копию (absolute, inset 0): без этого height: 100%
  // видео считался бы от блока с высотой auto, и исходник другой пропорции терял бы cover-кадрирование.
  const mask = speakerEdgeMask(state, track);
  return (
    <AbsoluteFill style={{ opacity: state.opacity }}>
      {state.fill ? <div style={speakerFillStyle(track)}>{held}</div> : null}
      <div style={{ ...speakerTransform(state, track), ...mask?.x }}>
        <div style={{ position: 'absolute', inset: 0, ...mask?.y }}>{held}</div>
      </div>
    </AbsoluteFill>
  );
}
