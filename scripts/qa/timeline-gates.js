// Гейты по манифесту слоя: считаются до рендера, за доли секунды.
const { gate } = require('./report');
const { overflow, safeRect } = require('./safe-rect');

const r2 = (value) => Math.round(value * 100) / 100;
const fmt = (value) => String(r2(value)).replace('.', ',');
const span = (fromFrame, toFrame, fps, note) => ({ fromSec: r2(fromFrame / fps), toSec: r2(toFrame / fps), note });
const factor = (a, b) => (a > b ? a / b : b / a);

// Общая проверка «съеденности» кадра: requested перевалил через видимый s заметно больше
// eatenPunch — клэмп камеры, а не собственное решение автора приблизиться. Один порог (`>=`) для
// G2 (окно вперёд внутри detectCameraEvents) и G3 (по каждому кадру) — раньше они незаметно
// разошлись на `>=`/`>`.
const isEatenFrame = (requested, s, f, eatenPunch) => requested[f] / s[f] >= eatenPunch;

// Общая проверка ступеньки: жёсткий однокадровый рез с плоскими (<1 %) соседями с обеих сторон —
// рез между двумя shots kit, а не растущий несколько кадров панч-ин. Используется только внутри
// detectCameraEvents (G1/G2) — G3 больше не решает причину клэмпа по форме кривой, а читает
// cameraAt.base (ревью пакета 2 задачи 22).
function isScaleStep(s, g, weakScale) {
  const n = s.length;
  const flat = (i) => i < 1 || i >= n || factor(s[i], s[i - 1]) < 1.01;
  return g >= 1 && g < n && factor(s[g], s[g - 1]) >= 1 + weakScale && flat(g - 1) && flat(g + 1);
}

// Группирует подряд идущие кадры, для которых predicate(f) истинен, в диапазоны [from, to) — G3
// (кадры выше предела масштаба) и G4 (кадры со скрытым спикером) читают одну и ту же группировку.
function frameRuns(n, predicate) {
  const runs = [];
  let open = null;
  for (let f = 0; f < n; f += 1) {
    if (predicate(f)) { if (open) open.to = f + 1; else open = { from: f, to: f + 1 }; }
    else if (open) { runs.push(open); open = null; }
  }
  if (open) runs.push(open);
  return runs;
}

// Проверка целостности манифеста: оба гейта читают camera.* по индексу кадра — обрезанный или
// битый массив (чужой профиль рендера, ручная правка manifest.json) должен дать понятную ошибку
// сразу здесь, а не NaN/undefined где-то в середине detectCameraEvents. Экспортируется отдельно:
// раннер задачи 24 переиспользует ровно эту проверку перед вызовом любого гейта по манифесту.
function assertCameraArrays(manifest) {
  const camera = manifest && manifest.camera;
  const n = manifest && manifest.durationInFrames;
  for (const key of ['s', 'requested', 'base', 'dx', 'dy', 'blur', 'opacity']) {
    const arr = camera && camera[key];
    if (!Array.isArray(arr) || arr.length !== n || !arr.every((v) => Number.isFinite(v))) {
      throw new Error(`манифест повреждён: camera.${key} должен быть массивом из ${n} конечных чисел`);
    }
  }
}

// scale — короткая сторона кадра / 1080: пороги в px заданы для кадра 1080×1920 и масштабируются.
// fps — окно панч-ина 6 кадров задано для 25 fps (пружина kit живёт в секундах). Оба обязательны:
// молчаливый дефолт 1/25 на нестандартном кадре или fps посчитал бы событие не тем порогом.
function detectCameraEvents(camera, t, scale, fps) {
  if (!(scale > 0)) throw new Error('detectCameraEvents: нужен scale > 0 (короткая сторона кадра / 1080)');
  if (!(fps > 0)) throw new Error('detectCameraEvents: нужен fps > 0');
  const n = camera.s.length;
  const shiftPx = t.shiftPx * scale;
  const weakShiftPx = t.weakShiftPx * scale;
  const punchWindow = Math.max(1, Math.round((6 * fps) / 25));
  const sharp = (f) => camera.opacity[f] >= 0.99 && camera.blur[f] < t.sharpBlurPx;

  const events = [];
  const weak = [];

  // Одиночный кадр-«ступенька»: скачок ≥ weakScale за 1 кадр с плоскими соседями (<1 % изменения
  // с каждой стороны) — жёсткий рез между двумя shots kit (одна камера ещё доигрывает старый
  // дрейф, другая уже стоит на новом плане), а не растущий несколько кадров панч-ин. Ступеньку
  // нужно судить только порогами реза/слабого реза, а не порогом панча — иначе, например, 12%-й
  // рез между W и M засчитывается как «панч» и вообще не попадает в G2.
  const step = (g) => isScaleStep(camera.s, g, t.weakScale);
  const stepIn = (a, b) => { for (let g = Math.max(1, a + 1); g <= b; g += 1) if (step(g)) return true; return false; };
  // Настоящий рез/смена фокуса внутри окна панча — тоже не панч: без этой проверки рез, случившийся
  // прямо во время нарастания соседнего панча, мог бы дать вторую, ложную вспышку «панча» сразу
  // после самого реза.
  const hardIn = (a, b) => events.some((e) => (e.kind === 'cut' || e.kind === 'focus') && e.frame > a && e.frame <= b);
  // Первый кадр настоящего роста внутри окна панча. Наивная версия («отматываем, пока строго
  // растёт») ломалась на дрейфующих shots (drift: 'in'): камера там растёт почти на каждом кадре
  // сама по себе, независимо от панча, и такая ходьба назад проваливалась на десятки кадров раньше
  // настоящего начала панча (до 0,18 с на 74 из 144 дрейфующих случаев). Правильный критерий —
  // не «растёт ли кадр вообще», а «растёт ли он заметно относительно САМОГО панча»: сначала находим
  // top — наибольший однокадровый прирост во всём окне (это и есть пик пружины панча), затем
  // отматываем назад, пока однокадровый прирост остаётся ≥ 10 % от top. Дрейф даёт прирост в разы
  // меньше пика панча и обрывает отмотку сразу за настоящим стартом.
  const riseStart = (to, from) => {
    let top = 0;
    for (let g = from + 1; g <= to; g += 1) top = Math.max(top, camera.s[g] / camera.s[g - 1] - 1);
    let g = to;
    while (g > from && camera.s[g] / camera.s[g - 1] - 1 >= 0.1 * top && camera.s[g - 1] < camera.s[g]) g -= 1;
    return g;
  };
  // «Съеденный» (упёршийся в maxScale) панч: requested в одном из ближайших кадров заметно выше
  // видимого s — клэмп камеры, а не собственное решение автора приблизиться. Клэмп обычно
  // проявляется не в САМОМ кадре f, а на кадр-два позже (пружина ещё не успела упереться в потолок
  // именно на f) — поэтому смотрим вперёд на всё окно панча, а не только на сам кадр. Это отдельная
  // проблема (гейт G3 задачи 22), не слабый джамп-кат — не показываем в G2.
  const eaten = (f) => {
    for (let g = f; g <= Math.min(n - 1, f + punchWindow); g += 1) {
      if (isEatenFrame(camera.requested, camera.s, g, t.eatenPunch)) return true;
    }
    return false;
  };

  for (let f = 1; f < n; f += 1) {
    const b2 = Math.max(0, f - 2);
    const b6 = Math.max(0, f - punchWindow);
    const jump = factor(camera.s[f], camera.s[b2]);
    // Евклидово расстояние сдвига лица: диагональный сдвиг 70×70 px реален (≈99 px), а не 70 —
    // Chebyshev-максимум по одной оси недооценивал диагональ.
    const shift = Math.hypot(camera.dx[f] - camera.dx[b2], camera.dy[f] - camera.dy[b2]);
    if (sharp(f) !== sharp(f - 1)) events.push({ frame: f, kind: 'focus' });
    else if (jump >= 1 + t.jumpScale || shift >= shiftPx) events.push({ frame: f, kind: 'cut' });
    else if (camera.s[f] / camera.s[b6] >= 1 + t.punchScale && !stepIn(b6, f) && !hardIn(b6, f)) {
      // Здесь ещё сырой кадр f (момент, когда прирост перевалил punchScale) — не отодвигаем его
      // сразу: пружина панча держит это условие истинным несколько кадров подряд, и окно b6 у
      // каждого из них своё (может сползти на уже подросшую базу, если s успел выйти на плато).
      // Отодвигаем назад только ОДИН раз — уже после схлопывания — у первого сырого кадра пачки.
      events.push({ frame: f, kind: 'punch' });
    } else {
      // Слабую смену показываем в G2, только если её видно: если в f или в опорном кадре b2 спикер
      // уже не резкий (away/blur/вставка), эту вибрацию масштаба или лица зритель не видит.
      const visible = sharp(f) && sharp(b2);
      // «Съеденный» панч (клэмп у потолка спирали) не показываем в G2 — это проблема G3. Но
      // ступеньку (жёсткий рез между двумя shots, не спираль) зритель видит независимо от клэмпа:
      // если она ведёт в пресет выше maxScale, это всё ещё заметный скачок и обязан остаться в G2
      // (Step 0 задачи 22), даже если requested/s у неё тоже перевалил eatenPunch.
      const scaleWeak = visible && jump >= 1 + t.weakScale && (step(f) || !eaten(f));
      const shiftWeak = visible && shift >= weakShiftPx;
      if (scaleWeak || shiftWeak) {
        weak.push({ frame: f, ratio: camera.s[f] / camera.s[b2], shift, reason: scaleWeak ? 'scale' : 'shift' });
      }
    }
  }
  // Схлопываем только повторы ОДНОГО вида в пределах 2 кадров: иначе рез сразу после панча (или
  // наоборот) в пределах этих же 2 кадров съедался бы соседней записью другого вида, и «резы» после
  // панча пропадали бы из событий совсем.
  const collapse = (list) => list.filter((e, i) => i === 0 || e.frame - list[i - 1].frame > 2 || e.kind !== list[i - 1].kind);
  // Отодвигаем начало панча к настоящему старту роста только у выжившего (первого в пачке) кадра —
  // после схлопывания у каждой пачки панча остаётся ровно один представитель, и riseStart честно
  // считает его собственное окно [f−punchWindow, f] заново.
  const kept = collapse(events).map((e) => (e.kind === 'punch'
    ? { ...e, frame: riseStart(e.frame, Math.max(0, e.frame - punchWindow)) }
    : e));
  const nearEvent = (w) => events.some((e) => Math.abs(e.frame - w.frame) <= punchWindow);
  return { events: kept, weak: collapse(weak.filter((w) => !nearEvent(w))), sharp };
}

// Хронологический порядок: гейт сам решает, что ему нужно (самый длинный план, топ-5 самых
// длинных для spans) — сортировка внутри speakerPlans скрывала бы от будущего вызывающего кода
// исходный порядок.
function speakerPlans(camera, detected, fps) {
  const cuts = new Set(detected.events.map((e) => e.frame));
  const plans = [];
  let start = null;
  for (let f = 0; f <= camera.s.length; f += 1) {
    const isSharp = f < camera.s.length && detected.sharp(f);
    if (start !== null && (!isSharp || cuts.has(f))) {
      plans.push({ from: start, to: f, sec: (f - start) / fps });
      start = null;
    }
    if (isSharp && start === null) start = f;
  }
  return plans;
}

const frameScale = (manifest) => Math.min(manifest.width, manifest.height) / 1080;

function gateRhythm(manifest, profile) {
  assertCameraArrays(manifest);
  const { fps } = manifest;
  const scale = frameScale(manifest);
  const plans = speakerPlans(manifest.camera, detectCameraEvents(manifest.camera, profile.camera, scale, manifest.fps), fps);
  const { stopSec, warnSec } = profile.rhythm;
  // Спикер ни разу не был резким и видимым за весь ролик — ритм оценивать не по чему: это не
  // «идеальные 0 секунд», а сигнал «гейт не увидел спикера вообще».
  if (!plans.length) {
    return gate('G1', 'Ритм спикера', {
      status: 'skipped', threshold: `≤ ${fmt(stopSec)} с`,
      hint: 'спикер не виден — ритм не оценивается',
    });
  }
  const longest = plans.reduce((max, p) => (p.sec > max ? p.sec : max), 0);
  const status = longest > stopSec + 1e-9 ? 'fail' : longest > warnSec + 1e-9 ? 'warn' : 'pass';
  const shiftPx = Math.round(profile.camera.shiftPx * scale);
  const jumpPct = Math.round(profile.camera.jumpScale * 100);
  return gate('G1', 'Ритм спикера', {
    status, value: r2(longest), unit: 'с', threshold: `≤ ${fmt(stopSec)} с`,
    spans: plans.filter((p) => p.sec > warnSec + 1e-9).sort((a, b) => b.sec - a.sec).slice(0, 5)
      .map((p) => span(p.from, p.to, fps, `план ${fmt(p.sec)} с без события`)),
    hint: `разбейте план: джамп-кат (≥ ${jumpPct} % масштаба или сдвиг лица ≥ ${shiftPx} px), панч-ин на общем плане, размытие под графикой или уход под вставку`,
  });
}

function gateWeakCuts(manifest, profile) {
  assertCameraArrays(manifest);
  const scale = frameScale(manifest);
  const { weak } = detectCameraEvents(manifest.camera, profile.camera, scale, manifest.fps);
  const shiftPx = Math.round(profile.camera.shiftPx * scale);
  const jumpPct = Math.round(profile.camera.jumpScale * 100);
  return gate('G2', 'Слабые джамп-каты', {
    status: weak.length ? 'warn' : 'pass', value: weak.length, unit: 'шт.', threshold: `≥ ${jumpPct} % или ≥ ${shiftPx} px`,
    spans: weak.slice(0, 5).map((w) => span(w.frame, w.frame + 1, manifest.fps,
      w.reason === 'shift' ? `сдвиг ${Math.round(w.shift)} px` : `скачок ${Math.round((factor(w.ratio, 1) - 1) * 100)} %`)),
    hint: 'такую смену зритель не видит: увеличьте разницу крупности или сдвиньте лицо в треть кадра',
  });
}

// G3: масштаб аватара не крупнее profile.scale.max. Причину клэмпа решает cameraAt.base (масштаб
// пресета × дрейф, ДО панчей и ДО ограничения maxScale) — не эвристика по форме кривой (ревью
// пакета 2 задачи 22: жёсткий рез между shots и застывший клэмп неотличимы по одной лишь форме —
// панч, удержанный через рез W→M, у которого base никогда не превышал предел, обязан остаться
// «панч упёрся в предел»; пресет выше предела с кадра 0 или растущий только за счёт дрейфа без
// единого панча обязан читаться как «пресет крупнее предела», даже пока камера просто стоит на
// клэмпнутом уровне несколько кадров подряд).
function gateScale(manifest, profile) {
  assertCameraArrays(manifest);
  const { s, requested, base } = manifest.camera;
  const { fps } = manifest;
  const limit = profile.scale.max;
  const max = s.reduce((m, v) => Math.max(m, v), 0);
  const overLimit = max > limit + 1e-3;
  // Сам масштаб (после клэмпа кита) выше предела профиля — такое может дать только собственный
  // camera.maxScale плана выше limit (кит никогда сам не превышает свой maxScale). Спаны — кадры,
  // где видимый s реально выше предела, а не «съеденные» — их может не быть вовсе (requested==s).
  if (overLimit) {
    const overRuns = frameRuns(s.length, (f) => s[f] > limit + 1e-3);
    return gate('G3', 'Масштаб аватара', {
      status: 'fail', value: Math.round(max * 1000) / 1000, threshold: `≤ ${fmt(limit)}`,
      spans: overRuns.slice(0, 5).map((r) => span(r.from, r.to, fps, `масштаб выше предела ${fmt(limit)}`)),
      hint: `выше ${fmt(limit)} масштаб может дать только camera.maxScale > ${fmt(limit)} в ките — проверьте план слоя`,
    });
  }
  const zones = [];
  let open = null;
  for (let f = 0; f < s.length; f += 1) {
    const eaten = isEatenFrame(requested, s, f, profile.camera.eatenPunch);
    // Причина клэмпа — сам ли пресет (с дрейфом, БЕЗ учёта панча) уже был бы «съеден» относительно
    // видимого s этого кадра. Сравнение с s[f], а не с фиксированным порогом профиля: план с
    // пониженным camera.maxScale (ниже 1,25) клэмпит s ниже профильного предела, и base там может
    // быть съеден, даже оставаясь ниже 1,25; легальный пресет (например 1,24 < 1,25), который сам
    // по себе съеден не был бы, но становится съеден вместе с панчем, — вина панча, а не пресета
    // (Step 0 задачи 23).
    const cause = eaten ? (base[f] / s[f] >= profile.camera.eatenPunch ? 'preset' : 'punch') : null;
    if (cause && open && open.cause === cause) open.to = f + 1;
    else { if (open) zones.push(open); open = cause ? { from: f, to: f + 1, cause } : null; }
  }
  if (open) zones.push(open);
  const NOTE = { punch: 'панч-ин упёрся в предел', preset: 'пресет крупнее предела — уменьшите s пресета' };
  const hasPreset = zones.some((z) => z.cause === 'preset');
  return gate('G3', 'Масштаб аватара', {
    status: zones.length ? 'warn' : 'pass', value: Math.round(max * 1000) / 1000, threshold: `≤ ${fmt(limit)}`,
    spans: zones.slice(0, 5).map((z) => span(z.from, z.to, fps, NOTE[z.cause])),
    hint: hasPreset
      ? 'пресет камеры крупнее предела масштаба — уменьшите сам пресет, а не панч'
      : zones.length
        ? 'ставьте панч-ин на общем плане W или заканчивайте его до склейки'
        : 'ставьте панч-ин на общем плане W',
  });
}

// G4: правило автора (docs/BATCH-REELS-WORKFLOW.md, docs/editing-rules.md) — «в первом кадре и
// первые 2–3 секунды виден спикер»: блюр/текст поверх допустимы, полное исчезновение — нет. Кадр
// внутри cover-вставки — лицо закрыто карточкой независимо от camera.opacity, даже пока уход
// камеры ещё гаснет (CAMERA_DEFAULTS.away.enterFrames не даёт opacity погаснуть мгновенно). СТОП,
// если спикер скрыт хоть на одном кадре в [0, mustSec); ПРЕДУПРЕЖДЕНИЕ — если скрыт только в
// [mustSec, sec). Хук-перечисление освобождает от обоих требований.
function gateHook(manifest, profile) {
  assertCameraArrays(manifest);
  const { fps } = manifest;
  const { sec, mustSec } = profile.hook;
  const mustFrames = Math.min(manifest.durationInFrames, Math.round(mustSec * fps));
  const totalFrames = Math.min(manifest.durationInFrames, Math.round(sec * fps));
  const threshold = `виден на каждом кадре первых ${fmt(mustSec)} с, лучше — весь диапазон ${fmt(sec)} с`;
  if (manifest.hook === 'enumeration') {
    return gate('G4', 'Спикер в первые 3 с', { threshold, hint: 'хук-перечисление: спикер появляется после объектов' });
  }
  const covered = (f) => manifest.inserts.some((i) => i.cover && f >= i.from && f < i.to);
  const hidden = (f) => manifest.camera.opacity[f] <= 0.01 || covered(f);
  const hiddenRuns = frameRuns(totalFrames, hidden);
  if (!hiddenRuns.length) return gate('G4', 'Спикер в первые 3 с', { threshold });
  const spans = hiddenRuns.slice(0, 5).map((r) => span(r.from, r.to, fps, 'спикера не видно'));
  if (hiddenRuns.some((r) => r.from < mustFrames)) {
    return gate('G4', 'Спикер в первые 3 с', {
      status: 'fail', threshold, spans,
      hint: `покажите спикера на каждом кадре первых ${fmt(mustSec)} с (можно размытым) или объявите hook: "enumeration"`,
    });
  }
  return gate('G4', 'Спикер в первые 3 с', {
    status: 'warn', threshold, spans,
    hint: `спикер пропадает между ${fmt(mustSec)} и ${fmt(sec)} с — верните его в кадр`,
  });
}

const SAFE_SIDES = { left: 'слева', right: 'справа', top: 'сверху', bottom: 'снизу' };
const CAPTION_LABEL = 'субтитры (полоса)';
const isCaptionId = (id) => id.startsWith('caption-');

// Порог в человеческом виде считаем от геометрии САМОГО кадра (safeRect), а не хардкодим
// «70/130/250/420 px» — эти числа верны только для 1080×1920; на 16:9 (1920×1080) safeRect отдаёт
// другой прямоугольник, и подпись обязана называть именно его.
function safeZoneThreshold(width, height) {
  const safe = safeRect(width, height);
  const left = Math.round(safe.left);
  const top = Math.round(safe.top);
  const right = Math.round(width - safe.right);
  const bottom = Math.round(height - safe.bottom);
  return `слева ${left}, справа ${right}, сверху ${top}, снизу ${bottom} px на каждом кадре`;
}

// Проверка целостности texts: оба гейта G5 читают box по индексу — битый или NaN-бокс (несобранный
// enter.from в старом manifest.json, ручная правка) не должен молча пройти мимо overflow() (NaN
// со всем сравнивается как false) — манифест обязан упасть понятной ошибкой, как остальные гейты
// падают на camera.* (assertCameraArrays). Настоящий корень такого NaN чинит src/motion-kit/
// compile.js (валидация enter.from) — эта проверка защищает от повреждённого manifest.json.
function assertTexts(manifest) {
  const texts = manifest && manifest.texts;
  if (!Array.isArray(texts)) throw new Error('манифест повреждён: texts должен быть массивом');
  const isBox = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite);
  texts.forEach((text, k) => {
    if (!text || typeof text.id !== 'string' || !text.id) {
      throw new Error(`манифест повреждён: texts[${k}] должен иметь строковый id`);
    }
    if (text.static !== undefined) {
      if (!isBox(text.static)) {
        throw new Error(`манифест повреждён: texts[${k}] (${text.id}).static должен быть массивом из 4 конечных чисел`);
      }
      return;
    }
    if (!Array.isArray(text.frames)) {
      throw new Error(`манифест повреждён: texts[${k}] (${text.id}).frames должен быть массивом`);
    }
    text.frames.forEach((box, i) => {
      if (box !== null && !isBox(box)) {
        throw new Error(`манифест повреждён: texts[${k}] (${text.id}).frames[${i}] должен быть null или массивом из 4 конечных чисел`);
      }
    });
  });
}

// G5: каждый бокс текста на каждом кадре его жизни обязан помещаться в safe-зону. Статичная полоса
// субтитров (caption-<n>, а после окна hide — caption-<n>b, caption-<n>c…, Task 18) проверяется
// один раз по своему static-прямоугольнику — у неё нет покадровых frames. Сканируем ВСЮ жизнь
// текста (не останавливаемся на первом нарушении, Step 0 задачи 23): по каждому тексту запоминаем
// первый и последний нарушивший кадр и МАКСИМАЛЬНЫЙ выход по каждой стороне — влёт может выйти
// сильнее всего не на первом видимом кадре (например перелёт pop), а разрыв [first, last+1) один
// на текст показывает всю нарушившую полосу, а не вспышку в один кадр.
function gateSafeZone(manifest) {
  assertTexts(manifest);
  const safe = safeRect(manifest.width, manifest.height);
  const found = [];
  for (const text of manifest.texts) {
    const boxes = text.static ? [text.static] : text.frames;
    let first = null;
    let last = null;
    const max = {};
    for (let i = 0; i < boxes.length; i += 1) {
      const b = boxes[i];
      if (!b) continue;
      const out = overflow({ left: b[0], top: b[1], right: b[2], bottom: b[3] }, safe);
      if (out) {
        if (first === null) first = i;
        last = i;
        for (const [side, px] of Object.entries(out)) max[side] = Math.max(max[side] || 0, px);
      }
    }
    if (first === null) continue;
    // Статичная полоса субтитров нарушает всю свою жизнь целиком (один и тот же бокс на каждом
    // кадре) — спан [from, until), а не [from, from+1) одного проверенного индекса.
    const fromFrame = text.static ? text.from : text.from + first;
    const toFrame = text.static ? text.until : text.from + last + 1;
    found.push({ id: text.id, fromFrame, toFrame, max, caption: isCaptionId(text.id) });
  }

  // Все куски субтитров (caption-<n>, caption-<n>b, caption-<n>c…) делят один и тот же static-
  // прямоугольник captions.lane — это ОДНА структурная проблема разметки, а не N текстов; считаем
  // её одним элементом в value и в spans, а не по числу кусков (Step 0 задачи 23).
  const captions = found.filter((v) => v.caption);
  const items = found.filter((v) => !v.caption);
  if (captions.length) {
    const max = {};
    for (const v of captions) for (const [side, px] of Object.entries(v.max)) max[side] = Math.max(max[side] || 0, px);
    items.push({
      id: CAPTION_LABEL,
      fromFrame: Math.min(...captions.map((v) => v.fromFrame)),
      toFrame: Math.max(...captions.map((v) => v.toFrame)),
      max, caption: true,
    });
  }
  // Хронологический порядок: спаны обязаны показывать первые ПО ВРЕМЕНИ нарушения, а не первые по
  // порядку элементов внутри manifest.texts (порядок items в plan.js не обязан совпадать с
  // порядком показа на экране, Step 0 задачи 23).
  items.sort((a, b) => a.fromFrame - b.fromFrame);

  const note = (v) => `${v.id}: ${Object.entries(v.max).map(([side, px]) => `${SAFE_SIDES[side]} до +${px} px`).join(', ')}`;
  const hint = captions.length
    ? 'полоса субтитров выходит за safe-зону — поправьте captions.lane или уберите свою lane'
    : 'держите влёт, перелёт и выход внутри safe-зоны: уменьшите сдвиг входа или переставьте box';
  return gate('G5', 'Safe-zone текста', {
    status: items.length ? 'fail' : 'pass', value: items.length, unit: 'элем.',
    threshold: safeZoneThreshold(manifest.width, manifest.height),
    spans: items.slice(0, 5).map((v) => span(v.fromFrame, v.toFrame, manifest.fps, note(v))),
    hint,
  });
}

// G10: минимальное число стоковых вставок по длине ролика — вкусовой порог, только предупреждение.
function gateStock(manifest, profile) {
  const count = manifest.inserts.filter((i) => i.kind === 'stock').length;
  const seconds = manifest.durationInFrames / manifest.fps;
  const min = seconds < profile.stock.shortSec ? profile.stock.minShort : profile.stock.min;
  return gate('G10', 'Стоковые вставки', {
    status: count >= min ? 'pass' : 'warn', value: count, unit: 'шт.', threshold: `≥ ${min}`,
    hint: 'заполните пустые участки B-roll по смыслу фраз: automontage layer stock',
  });
}

// Сливает подряд идущие (касающиеся или пересекающиеся, зазор ≤ gapFrames) вставки одного прогона
// в один диапазон перед измерением «подряд» для G11 — два соседних донора, разделённые короткой
// паузой, обязаны читаться как один эпизод, а не как два отдельных прохождения лимита. Сортировка
// по from — входной порядок вставок не гарантирован; вложенная вставка (целиком внутри другой)
// поглощается через Math.max(last.to, insert.to), а не расширяет диапазон её собственным to.
function mergeRuns(inserts, gapFrames) {
  const sorted = [...inserts].sort((a, b) => a.from - b.from);
  const runs = [];
  for (const insert of sorted) {
    const last = runs[runs.length - 1];
    if (last && insert.from - last.to <= gapFrames) {
      last.to = Math.max(last.to, insert.to);
      last.ids.push(insert.id);
    } else {
      runs.push({ from: insert.from, to: insert.to, ids: [insert.id] });
    }
  }
  return runs;
}

// G11: чужое видео — не дольше profile.donor.maxSec подряд. «Подряд» — прогон донорских вставок,
// слитых при паузе ≤ profile.donor.gapSec. cover решает только видимость спикера под вставкой
// (оверлей vs полноэкранный донор) и никак не влияет на этот вердикт. value — самый длинный прогон
// донора всегда, даже когда гейт проходит: это метрика профиля, а не только повод для fail.
function gateDonor(manifest, profile) {
  const { fps } = manifest;
  // floor, не round: округление вверх (например 0,5 с при 25 fps → 13 кадров = 0,52 с) слило бы
  // прогоны с паузой длиннее заявленного gapSec — floor гарантирует, что порог в кадрах никогда не
  // превышает gapSec ни на каком fps (Step 0 задачи 23).
  const gapFrames = Math.floor(profile.donor.gapSec * fps + 1e-9);
  const donors = manifest.inserts.filter((i) => i.kind === 'donor');
  const runs = mergeRuns(donors, gapFrames);
  const long = runs.filter((r) => (r.to - r.from) / fps > profile.donor.maxSec + 1e-9);
  return gate('G11', 'Чужое видео', {
    status: long.length ? 'fail' : 'pass',
    value: runs.length ? r2(Math.max(...runs.map((r) => (r.to - r.from) / fps))) : 0, unit: 'с',
    threshold: `≤ ${fmt(profile.donor.maxSec)} с подряд`,
    spans: long.map((r) => span(r.from, r.to, fps, r.ids.join('+'))),
    hint: 'чужой ролик — только 2–3 с для контекста, дальше собственные анимации по смыслу; '
      + 'донор без cover — оверлей поверх спикера, полноэкранный донор ставьте с cover: true; '
      + 'cover решает только видимость спикера и на этот вердикт (длину прогона) не влияет',
  });
}

module.exports = {
  assertCameraArrays, detectCameraEvents, gateDonor, gateHook, gateRhythm, gateSafeZone, gateScale, gateStock, gateWeakCuts, speakerPlans,
};
