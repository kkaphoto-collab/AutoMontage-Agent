// Сборка слоя из деталей motion-kit. Режиссура – в plan.js, дизайн карточек и вставок – в scenes.jsx.
import { useMemo } from 'react';
import { AbsoluteFill } from 'remotion';
import { FontLoader, FullscreenReveal, KitBox, SfxTrack, ShutterFlash, SpeakerLayer, StockInsert, Subtitles,
  compilePlan } from '@automontage/motion-kit';
import layer from '../layer.json';
import buildPlan from './plan.js';
import { CAPTION_FONT, FONTS, InsertContent, SceneContent } from './scenes.jsx';
import sfxLibrary from './sfx-library.js';
import words from './words.js';

// Опечатка в CAPTION_FONT (имя семьи не из FONTS) не должна тихо увести субтитры в запасной
// шрифт: FontLoader регистрирует ТОЛЬКО имена из FONTS, а document.fonts.load(CAPTION_FONT) внутри
// Subtitles на незарегистрированное имя резолвится немедленно – ждать нечего, это не зависание, а
// тихая подмена шрифта, которую легко не заметить в preview. Проверяем один раз при загрузке модуля.
if (!FONTS.some((face) => face.family === CAPTION_FONT)) {
  throw new Error(`Root.jsx: CAPTION_FONT «${CAPTION_FONT}» отсутствует среди FONTS слоя (scenes.jsx)`);
}

// Сток – StockInsert; остальные полноэкранные (cover) вставки – FullscreenReveal с содержимым ролика,
// иначе спикер уходит под вставку, а кадр остаётся чёрным. Вставку без cover (donor) ролик рисует сам.
// Другое сочетание kind/cover разошлось бы с манифестом гейтов (G4 читает cover) – стоп.
export function Insert({ insert }) {
  if (insert.cover && insert.kind === 'stock') return <StockInsert insert={insert} />;
  if (insert.cover && ['screen', 'scene', 'donor'].includes(insert.kind)) {
    return <FullscreenReveal insert={insert}><InsertContent insert={insert} /></FullscreenReveal>;
  }
  if (!insert.cover && insert.kind === 'donor') return <InsertContent insert={insert} />;
  throw new Error(`Root.jsx: вставка ${insert.id} (kind ${insert.kind}, cover ${insert.cover}) вне контракта слоя – cover: false только у donor`);
}

export function LayerComposition() {
  // Та же точка сборки, что у Node-манифеста layer check: гейт проверяет ровно этот слой.
  const compiled = useMemo(() => compilePlan(buildPlan, { ...layer, words, sfxLibrary }), []);
  // FontLoader – гейт: ничего из слоя не попадает в кадр, пока шрифты не загрузились.
  // Вспышка – на ударе каждого оставшегося звука затвора: звук и свет не расходятся.
  return (
    <AbsoluteFill style={{ backgroundColor: '#000000' }}>
      <FontLoader faces={FONTS}>
        <SpeakerLayer src={layer.speaker.src} track={compiled.camera} lastFrame={layer.speaker.lastFrame} />
        {compiled.inserts.map((insert) => <Insert key={insert.id} insert={insert} />)}
        {compiled.items.map((item) => <KitBox key={item.id} item={item}><SceneContent item={item} /></KitBox>)}
        {compiled.cues.kept.filter((cue) => cue.role === 'shutter').map((cue) => <ShutterFlash key={cue.id} at={cue.hitFrame} />)}
        {compiled.captions ? <Subtitles {...compiled.captions} fontFamily={CAPTION_FONT} /> : null}
        <SfxTrack cues={compiled.cues.kept} masterDb={layer.sfxMasterDb} />
      </FontLoader>
    </AbsoluteFill>
  );
}
