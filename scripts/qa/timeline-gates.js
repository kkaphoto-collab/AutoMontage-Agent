// Гейты по манифесту слоя: считаются до рендера, за доли секунды.
const { gate } = require('./report');

const r2 = (value) => Math.round(value * 100) / 100;
const fmt = (value) => String(r2(value)).replace('.', ',');
const span = (fromFrame, toFrame, fps, note) => ({ fromSec: r2(fromFrame / fps), toSec: r2(toFrame / fps), note });
const factor = (a, b) => (a > b ? a / b : b / a);

// Проверка целостности манифеста: оба гейта читают camera.* по индексу кадра — обрезанный или
// битый массив (чужой профиль рендера, ручная правка manifest.json) должен дать понятную ошибку
// сразу здесь, а не NaN/undefined где-то в середине detectCameraEvents. Экспортируется отдельно:
// раннер задачи 24 переиспользует ровно эту проверку перед вызовом любого гейта по манифесту.
function assertCameraArrays(manifest) {
  const camera = manifest && manifest.camera;
  const n = manifest && manifest.durationInFrames;
  for (const key of ['s', 'requested', 'dx', 'dy', 'blur', 'opacity']) {
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
  const flat = (g) => g < 1 || g >= n || factor(camera.s[g], camera.s[g - 1]) < 1.01;
  const step = (g) => g >= 1 && factor(camera.s[g], camera.s[g - 1]) >= 1 + t.weakScale && flat(g - 1) && flat(g + 1);
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
      if (camera.requested[g] / camera.s[g] >= t.eatenPunch) return true;
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
      const scaleWeak = visible && jump >= 1 + t.weakScale && !eaten(f);
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

module.exports = { assertCameraArrays, detectCameraEvents, gateRhythm, gateWeakCuts, speakerPlans };
