import { Audio, Sequence, staticFile, useVideoConfig } from 'remotion';
import { assertMasterDb, cueVolume } from './sfx.js';

// masterDb валидируется здесь же, а не только внутри cueVolume: в настоящем Remotion volume()
// зовётся только пока Sequence конкретного звука активна, поэтому испорченный
// layer.json → sfxMasterDb иначе всплыл бы не на кадре 0, а только когда рендер дойдёт до первого
// звука — минуты работы ffmpeg/Remotion впустую. assertMasterDb общая с cueVolume (sfx.js), чтобы
// сообщение не разъехалось на два текста в двух местах.

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
