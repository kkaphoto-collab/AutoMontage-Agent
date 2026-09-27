import { AbsoluteFill, Freeze, OffthreadVideo, staticFile, useCurrentFrame } from 'remotion';
import { cameraAt } from './camera.js';

export function speakerTransform(state, track) {
  const filters = [];
  if (state.blur > 0.05) filters.push(`blur(${state.blur.toFixed(2)}px)`);
  if (state.dim < 0.999) filters.push(`brightness(${state.dim.toFixed(3)})`);
  return {
    position: 'absolute', left: 0, top: 0, width: track.width, height: track.height,
    transformOrigin: `${track.face.x}px ${track.face.y}px`,
    transform: `translate(${state.dx.toFixed(2)}px, ${state.dy.toFixed(2)}px) scale(${state.s.toFixed(4)})`,
    filter: filters.length ? filters.join(' ') : undefined,
    opacity: state.opacity,
  };
}

// Аватар — один OffthreadVideo muted по глобальному таймкоду (голос идёт из мастер-видео).
// Хвост после lastFrame заморожен; открытые края боковых планов залиты уменьшенной размытой копией.
export function SpeakerLayer({ src, track, lastFrame, trimBefore = 0 }) {
  const frame = useCurrentFrame();
  const state = cameraAt(track, frame);
  if (!state.visible) return null;
  const video = (
    <OffthreadVideo src={staticFile(src)} muted trimBefore={trimBefore || undefined}
      style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
  );
  const held = Number.isFinite(lastFrame) && frame > lastFrame ? <Freeze frame={lastFrame}>{video}</Freeze> : video;
  return (
    <AbsoluteFill>
      {state.fill ? (
        <div style={{ position: 'absolute', left: 0, top: 0, width: track.width / 4, height: track.height / 4,
          transform: 'scale(4.4)', transformOrigin: '0 0', filter: 'blur(5px) brightness(0.7)' }}>{held}</div>
      ) : null}
      <div style={speakerTransform(state, track)}>{held}</div>
    </AbsoluteFill>
  );
}
