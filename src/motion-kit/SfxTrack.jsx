import { Audio, Sequence, staticFile, useVideoConfig } from 'remotion';
import { cueVolume } from './sfx.js';

// masterDb валидируется здесь же, а не только внутри cueVolume: в настоящем Remotion volume()
// зовётся только пока Sequence конкретного звука активна, поэтому испорченный
// layer.json → sfxMasterDb иначе всплыл бы не на кадре 0, а только когда рендер дойдёт до первого
// звука — минуты работы ffmpeg/Remotion впустую. Проверка внутри cueVolume остаётся как есть.
function assertMasterDb(masterDb) {
  if (!(Number.isFinite(masterDb) && masterDb <= 0)) {
    throw new Error(`layer.json → sfxMasterDb должен быть конечным числом ≤ 0 (по умолчанию −5 дБ) — получено ${String(masterDb)}`);
  }
}

// Звуковая дорожка слоя: одна Sequence на каждый оставшийся после thinCues звук (compiled.cues.kept).
// fps берём из композиции, а не жёстко 25 — cueVolume сам переводит длину затухания хвоста в
// эталонные 25fps кадры (ref25), чтобы звук затухал одно и то же время на любом fps.
export function SfxTrack({ cues, masterDb = -5 }) {
  assertMasterDb(masterDb);
  const { fps } = useVideoConfig();
  return (
    <>
      {cues.map((cue) => (
        <Sequence key={cue.id} from={cue.startFrame} durationInFrames={cue.durationFrames} layout="none">
          <Audio src={staticFile(cue.file)} volume={(f) => cueVolume(cue, f, masterDb, fps)} />
        </Sequence>
      ))}
    </>
  );
}
