import { Audio, Sequence, staticFile, useVideoConfig } from 'remotion';
import { cueVolume } from './sfx.js';

// Звуковая дорожка слоя: одна Sequence на каждый оставшийся после thinCues звук (compiled.cues.kept).
// fps берём из композиции, а не жёстко 25 — cueVolume сам переводит длину затухания хвоста в
// эталонные 25fps кадры (ref25), чтобы звук затухал одно и то же время на любом fps.
export function SfxTrack({ cues, masterDb = -5 }) {
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
