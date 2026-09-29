// Режиссура этого ролика. Времена – секунды исходника. Меняйте всё: layer check покажет, если ритм,
// safe-zone или звуки выйдут за правила. Импорт – только '@automontage/motion-kit/core' и файлы слоя.
//
// Шаблон расставляет элементы по долям длины; в ролике ставьте их на слова речи:
//   import { makeAnchors } from '@automontage/motion-kit/core';
//   const a = makeAnchors(words);
//   { id: 'repo', kind: 'text', at: a.at('репозиторий'), until: a.at('готово', { edge: 'end' }), ... }
//
// Исключение из гейта – только G1, G4 или G11 и только с причиной, она видна в отчёте:
//   waivers: [{ gate: 'G1', reason: 'длинный план – демонстрация экрана без склеек по просьбе автора' }],
import { autoShots, captionLane, pickSound, safeRect } from '@automontage/motion-kit/core';

// Первые 3 с спикер в кадре (G4): полноэкранные вставки – только после хука.
const HOOK_SEC = 3;

export default function buildPlan({ words, face, fps, width, height, durationInFrames, sfxLibrary }) {
  const duration = durationInFrames / fps;
  // Эталонные размеры – px кадра 1080 по короткой стороне; тот же k у камеры kit и у кегля в scenes.jsx.
  const k = Math.min(width, height) / 1080;
  const safe = safeRect(width, height);
  const lane = captionLane(width, height);
  const top = safe.top + 50 * k;
  // Box по центру safe-зоны. Все аргументы – px этого кадра: эталонные px умножайте на k.
  const centered = (w, y, h) => {
    const bw = Math.min(w, safe.right - safe.left);
    return { x: Math.round(safe.left + (safe.right - safe.left - bw) / 2), y: Math.round(y), w: Math.round(bw), h: Math.round(h) };
  };
  const at = (share) => Number((duration * share).toFixed(2));
  const title = words.slice(0, 3).map((w) => w.t).join(' ').replace(/[.,!?…:;]+$/u, '').toUpperCase();
  const shotAt = at(0.3);
  const stockAt = Math.max(at(0.6), HOOK_SEC);
  const hasStock = stockAt + 1 <= duration;
  // Карточка уходит до стока: вставка рисуется под элементами, и карточка иначе висела бы поверх неё.
  const shotUntil = hasStock ? Math.min(shotAt + 2.6, stockAt - 0.2) : shotAt + 2.6;
  // Затвор – после входа карточки (mask длится 0,32 с); вспышку Root.jsx ставит на его удар.
  const shutter = pickSound(sfxLibrary, 'shutter');
  const flashAt = Number((shotAt + 0.32).toFixed(2));
  // Полноэкранные вставки ролика: stock, screen (окно браузера), scene; donor – чужое видео.
  const inserts = [];
  if (hasStock) {
    inserts.push({ id: 'stock-1', kind: 'stock', from: stockAt, to: stockAt + 2, src: 'stock/placeholder.mp4', sfx: pickSound(sfxLibrary, 'whoosh') });
  }
  return {
    hook: 'speaker',
    camera: {
      face,
      shots: autoShots(words, { endSec: duration }),
      punches: [],
      blurs: [{ from: shotAt, to: shotUntil - 0.2, px: 20 }],
    },
    items: [
      ...(title ? [{ id: 'title', kind: 'text', at: 0.2, until: Math.min(2.4, shotAt), box: centered(780 * k, top, 220 * k),
        enter: { kind: 'pop' }, sfx: pickSound(sfxLibrary, 'pop'), props: { view: 'title', text: title } }] : []),
      { id: 'screenshot', kind: 'card', at: shotAt, until: shotUntil,
        box: centered(840 * k, top, Math.min(900 * k, lane.y - 40 * k - top)),
        enter: { kind: 'mask' }, props: { view: 'browser', url: 'example.com', src: 'shots/placeholder.png', scroll: 1 } },
    ],
    inserts,
    sfx: shutter ? [{ at: flashAt, name: shutter }] : [],
    // Субтитры уходят под каждую полноэкранную вставку – и под ту, что добавите позже; поверх донора остаются.
    captions: { hide: inserts.filter((i) => i.kind !== 'donor').map(({ from, to }) => ({ from, to })) },
  };
}
