// Гейты по отрендеренному слою: длина к исходнику (G6) и отсутствие голоса в звуке слоя (G7).
const { BLOCK_SEC, audibleOutside, bestLagPearson, windowedMax } = require('./audio');
const { gate } = require('./report');

const r2 = (value) => Math.round(value * 100) / 100;
const fmt = (value) => String(r2(value)).replace('.', ',');
const rate = (fps) => String(Number(fps.toFixed(3))).replace('.', ',');

// Сдвиг звука слоя относительно исходника, который ещё ищет корреляция (±300 мс): задержка
// муксера/буфера при рендере, как в windowedMax.
const MAX_LAG_BLOCKS = 6;
// Похожее на голос окно (сигнал C) засчитывается, только если в нём есть хотя бы столько звука вне
// эффектов: на чистом плотном слое окно случайно совпадает с речью до r 0,80–0,85.
const WINDOW_OUTSIDE_SEC = 0.1;
const EPS = 1e-9;

// Обе длительности — в кадрах исходника: при другом FPS сравнивать кадры слоя с кадрами исходника
// бессмысленно, а сам другой FPS гейт и так останавливает.
function gateLayerDuration({ layer, source }, profile) {
  const tolerance = profile.duration.toleranceFrames;
  const diff = Math.round(layer.duration * source.fps) - Math.round(source.duration * source.fps);
  const sameGeometry = layer.width === source.width && layer.height === source.height
    && Math.abs(layer.fps - source.fps) < 1e-3;
  const sameLength = Math.abs(diff) <= tolerance;
  const hints = [];
  if (!sameGeometry) {
    hints.push(`слой ${layer.width}×${layer.height}@${rate(layer.fps)}, исходник ${source.width}×${source.height}@${rate(source.fps)}: `
      + 'слой рендерится в размере и FPS исходника');
  }
  if (!sameLength) hints.push('длительность композиции должна совпадать с исходником: пересоздайте layer.json командой layer new');
  return gate('G6', 'Длина слоя', {
    status: sameGeometry && sameLength ? 'pass' : 'fail',
    value: diff, unit: 'кадр.', threshold: `±${tolerance} кадр к исходнику, тот же размер и FPS`,
    hint: hints.join('; '),
  });
}

// Окна эффектов слоя в секундах: все kept-звуки манифеста, подложки (bed) тоже —
// [startFrame, startFrame + durationFrames) / fps.
function effectSpans(cues, fps) {
  if (!Array.isArray(cues)) throw new Error('gateVoiceLeak: нужен cues — массив cues.kept из манифеста слоя');
  if (cues.length && !(Number.isFinite(fps) && fps > 0)) throw new Error('gateVoiceLeak: нужен fps слоя > 0, чтобы перевести кадры звуков в секунды');
  return cues.map((cue) => {
    const ok = cue && Number.isFinite(cue.startFrame) && cue.startFrame >= 0
      && Number.isFinite(cue.durationFrames) && cue.durationFrames > 0;
    if (!ok) throw new Error(`манифест повреждён: звук ${(cue && (cue.id || cue.name)) || '?'} должен иметь startFrame ≥ 0 и durationFrames > 0`);
    return [cue.startFrame / fps, (cue.startFrame + cue.durationFrames) / fps];
  });
}

const overlapSec = (stretches, from, to) => stretches
  .reduce((sum, s) => sum + Math.max(0, Math.min(s.toSec, to) - Math.max(s.fromSec, from)), 0);

// Три сигнала. A (главный) — слышимый звук слоя вне эффектов из манифеста: в звуке слоя kit по
// контракту только эффекты. B — корреляция огибающих слоя и исходника по всей дорожке с поиском
// сдвига: ловит полную утечку голоса, даже спрятанную под длинной подложкой. C — самое похожее на
// голос окно, но только если в нём есть и звук вне эффектов.
function gateVoiceLeak({ layerEnv, sourceEnv, audioMode, cues, fps }, profile) {
  const title = 'Голос в звуке слоя';
  const leak = profile.leak;
  const threshold = `вне эффектов < ${fmt(leak.outsideWarnSec)} с (стоп от ${fmt(leak.outsideStopSec)} с), `
    + `похожесть на голос < ${fmt(leak.stop)}`;
  if (audioMode === 'mute') return gate('G7', title, { status: 'skipped', threshold, hint: 'звук слоя не используется (audioMode mute)' });
  const spans = effectSpans(cues, fps);
  if (!layerEnv || !layerEnv.length) {
    return gate('G7', title, { status: 'warn', threshold, hint: 'в слое нет звуковой дорожки: поставьте audioMode mute или добавьте эффекты' });
  }
  const loudest = layerEnv.reduce((max, v) => Math.max(max, v), -Infinity);
  if (loudest <= leak.silentDb) {
    return gate('G7', title, { status: 'warn', threshold, hint: 'звук слоя почти беззвучный: поставьте audioMode mute или добавьте эффекты' });
  }

  const outside = audibleOutside(layerEnv, spans, { minDb: leak.silentDb, headSec: leak.headSec, tailSec: leak.tailSec });
  const hasSource = Boolean(sourceEnv && sourceEnv.length);
  const whole = hasSource ? bestLagPearson(layerEnv, sourceEnv, MAX_LAG_BLOCKS) : null;
  const windowBlocks = Math.round(leak.windowSec / BLOCK_SEC);
  const window = hasSource ? windowedMax(layerEnv, sourceEnv, windowBlocks, { minDbA: leak.silentDb }) : null;
  const windowFrom = window ? window.startBlock * BLOCK_SEC : 0;
  const windowTo = windowFrom + windowBlocks * BLOCK_SEC;
  const windowCounts = Boolean(window && window.r >= leak.windowWarn
    && overlapSec(outside.stretches, windowFrom, windowTo) >= WINDOW_OUTSIDE_SEC - EPS);
  const wholeHigh = Boolean(whole && whole.r >= leak.stop);

  const status = wholeHigh || outside.seconds >= leak.outsideStopSec ? 'fail'
    : outside.seconds >= leak.outsideWarnSec || windowCounts ? 'warn' : 'pass';

  const hints = [];
  if (wholeHigh || windowCounts) {
    const lag = wholeHigh ? whole.lag : window.lag;
    hints.push(`похоже на голос аватара (сдвиг ${Math.round(lag * BLOCK_SEC * 1000)} мс)`);
  } else if (outside.seconds >= leak.outsideWarnSec) {
    hints.push(`посторонний звук вне эффектов: ${fmt(outside.seconds)} с`);
  }
  if (status !== 'pass') {
    hints.push('у видео аватара и вставок в слое должен быть muted: голос идёт только из мастер-видео, в звуке слоя — только эффекты');
  }
  hints.push(whole ? `похожесть на голос r = ${fmt(whole.r)} (порог ${fmt(leak.stop)})` : 'похожесть на голос не посчитана');

  const gateSpans = outside.stretches.slice(0, 5)
    .map((s) => ({ fromSec: r2(s.fromSec), toSec: r2(s.toSec), note: 'звук вне эффектов' }));
  if (windowCounts) gateSpans.push({ fromSec: r2(windowFrom), toSec: r2(windowTo), note: 'звук слоя повторяет голос' });

  return gate('G7', title, { status, value: outside.seconds, unit: 'с', threshold, spans: gateSpans, hint: hints.join('; ') });
}

module.exports = { gateLayerDuration, gateVoiceLeak };
