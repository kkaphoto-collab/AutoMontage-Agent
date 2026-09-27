import { ref25, secToFrame } from './time.js';

export const NOTABLE_ROLES = Object.freeze(['whoosh', 'swoosh', 'impact', 'riser', 'shutter']);
export const ROLE_VOLUME = Object.freeze({
  whoosh: 0.7, swoosh: 0.7, impact: 0.7, riser: 0.5, shutter: 0.6,
  pop: 0.55, click: 0.55, swish: 0.5, ui: 0.5, typing: 0.4,
});
const ROLE_PRIO = { impact: 3, riser: 3, whoosh: 2, swoosh: 2, shutter: 2 };
export const roleOf = (name) => String(name).split('-')[0];

export function resolveSound(library, spec) {
  const name = typeof spec === 'string' ? spec : spec?.name;
  const sounds = library?.sounds || {};
  if (sounds[name]) return { name, ...sounds[name] };
  const byRole = Object.entries(sounds).find(([soundName, sound]) => (sound.role || roleOf(soundName)) === name);
  if (!byRole) throw new Error(`звук «${name}» не найден в библиотеке слоя (public/sfx)`);
  return { name: byRole[0], ...byRole[1] };
}

export function pickSound(library, role) {
  const sounds = library?.sounds || {};
  if (sounds[role]) return role;
  return Object.entries(sounds).some(([name, sound]) => (sound.role || roleOf(name)) === role) ? role : null;
}

// Звуки из элементов (sfx на входе, typing на наборе) и из списка extra [{at, name, vol, prio}].
export function sfxFromItems(items, extra, { fps, library, durationInFrames }) {
  const cues = [];
  // Растущий индекс делает id уникальным всегда: два бед-звука (например, две подложки набора
  // текста), стартующие на одном кадре, иначе получали бы одинаковый `name@hitFrame` и ломали
  // React-ключи в SfxTrack.
  let n = 0;
  const push = (spec, hitFrame, { bedFrames = null, prio } = {}) => {
    const sound = resolveSound(library, spec);
    const role = sound.role || roleOf(sound.name);
    const own = typeof spec === 'object' ? spec.vol : undefined;
    const vol = own ?? sound.volume ?? ROLE_VOLUME[role] ?? 0.5;
    // leadFrames — в кадрах эталона 25 fps, как и все остальные длительности kit (см. ref25 в
    // time.js/camera.js/motion.js), а не в кадрах композиции — иначе один и тот же plan.js звучит
    // по-разному на разных fps. Math.round без минимума в 1, поэтому leadFrames:0 остаётся 0.
    const lead = typeof spec === 'object' && Number.isFinite(spec.leadFrames)
      ? Math.round((spec.leadFrames * fps) / 25) : Math.round((sound.peakSec || 0) * fps);
    const startFrame = Math.max(0, hitFrame - lead);
    const natural = Math.max(1, Math.round(sound.lengthSec * fps));
    const durationFrames = Math.max(1, Math.min(bedFrames ?? natural, natural, durationInFrames - startFrame));
    cues.push({
      id: `${sound.name}@${hitFrame}#${n}`, name: sound.name, file: sound.file, startFrame, hitFrame, durationFrames,
      vol, role, notable: NOTABLE_ROLES.includes(role), bed: bedFrames !== null, prio: prio ?? ROLE_PRIO[role] ?? 1,
    });
    n += 1;
  };
  for (const item of items) {
    if (item.sfx) push(item.sfx, item.from);
    if (item.typeFrom !== undefined && item.typeTo > item.typeFrom && item.typeSfx !== null) {
      const span = item.typeTo - item.typeFrom;
      const short = library?.sounds?.typing;
      const long = library?.sounds?.['typing-long'];
      // Никто явно не просил typeSfx, а в библиотеке нет ни typing, ни typing-long — обычный
      // ролик без такого звука в паке, подложку молча пропускаем. Явный item.typeSfx (даже на
      // отсутствующий звук) — это запрос автора plan.js, resolveSound должен бросить как раньше.
      if (item.typeSfx || short || long) {
        const spec = item.typeSfx || (long && short && span > short.lengthSec * fps ? 'typing-long' : 'typing');
        push(spec, item.typeFrom, { bedFrames: span, prio: 0 });
      }
    }
  }
  for (const entry of extra || []) push(entry, secToFrame(entry.at, fps), { prio: entry.prio });
  // Только звуки, чей удар реально попадает в композицию: лид может утащить startFrame в 0
  // (звук просто раньше стартует), но если сам hitFrame ушёл до начала или за конец ролика,
  // звук ему уже не принадлежит.
  return cues.filter((cue) => cue.hitFrame >= 0 && cue.hitFrame < durationInFrames);
}

// Не больше одного заметного звука в секунду и не ближе 0,3 с между любыми; набор текста — подложка.
export function thinCues(cues, { fps, minGapSec = 0.3, notableGapSec = 1.0 } = {}) {
  const kept = [];
  const dropped = [];
  const minGap = minGapSec * fps;
  const notableGap = notableGapSec * fps;
  const ordered = [...cues].sort((a, b) => b.prio - a.prio || a.hitFrame - b.hitFrame);
  for (const cue of ordered) {
    if (cue.bed) {
      kept.push(cue);
      continue;
    }
    const clash = kept.find((k) => !k.bed && (
      Math.abs(k.hitFrame - cue.hitFrame) < minGap
      || (k.notable && cue.notable && Math.abs(k.hitFrame - cue.hitFrame) < notableGap)));
    if (clash) {
      const reason = clash.notable && cue.notable && Math.abs(clash.hitFrame - cue.hitFrame) >= minGap ? 'notable-gap' : 'min-gap';
      dropped.push({ cue, conflictWith: clash.id, reason });
    } else {
      kept.push(cue);
    }
  }
  kept.sort((a, b) => a.startFrame - b.startFrame);
  return { kept, dropped };
}

export const dbToGain = (db) => 10 ** (db / 20);

// masterDb −5 — утверждённый уровень эффектов относительно «горячих» громкостей в плане; движок
// затем подмешивает звук слоя ещё на −18 dB (audioMode "mix", см. D5/D6 в context.md).
// fade — не жёсткая константа 5 кадров, а ref25(5, fps) эталонных кадров: хвост звука обязан
// затухать одно и то же ВРЕМЯ на любом fps (5 кадров на 50fps — это вдвое короче по времени, чем
// на 25fps). SfxTrack передаёт fps из useVideoConfig(); значение по умолчанию 25 сохраняет старое
// поведение вызовов без явного fps.
export function cueVolume(cue, localFrame, masterDb = -5, fps = 25) {
  const fade = Math.max(1, Math.min(ref25(5, fps), Math.floor(cue.durationFrames / 3)));
  const tail = Math.min(1, Math.max(0, (cue.durationFrames - localFrame) / fade));
  return cue.vol * dbToGain(masterDb) * tail;
}
