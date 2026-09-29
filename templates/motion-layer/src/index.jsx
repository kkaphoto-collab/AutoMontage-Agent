import { Composition, registerRoot } from 'remotion';
import layer from '../layer.json';
import { LayerComposition } from './Root.jsx';

function Root() {
  return (
    <Composition id={layer.composition} component={LayerComposition} durationInFrames={layer.durationInFrames}
      fps={layer.fps} width={layer.width} height={layer.height} />
  );
}

registerRoot(Root);
