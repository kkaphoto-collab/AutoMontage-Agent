const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getProfile, WAIVABLE } = require('../scripts/qa/profiles');
const { applyWaivers, buildReport, exitCodeFor, formatReport, gate, writeReport } = require('../scripts/qa/report');

test('profiles keep ordered voice-music corridors and share the rhythm rule', () => {
  for (const name of ['avatar', 'live']) {
    const v = getProfile(name).voiceMusic;
    assert.ok(v.stopLow < v.warnLow && v.warnLow < v.target && v.target < v.warnHigh && v.warnHigh < v.stopHigh, name);
    assert.deepEqual(getProfile(name).rhythm, { stopSec: 2.5, warnSec: 2.2 });
  }
  assert.throws(() => getProfile('tiktok'), /неизвестный профиль проверок «tiktok»/);
  assert.deepEqual([...WAIVABLE], ['G1', 'G4', 'G11']);
});

// Гейт получает профиль по общей ссылке (несколько гейтов одной проверки, один и тот же объект):
// без глубокой заморозки один гейт мог бы тихо поменять порог для гейта, который выполнится после
// него в этом же прогоне.
test('profiles are deeply frozen, so a gate cannot mutate thresholds seen by later gates', () => {
  const avatar = getProfile('avatar');
  assert.ok(Object.isFrozen(avatar));
  assert.ok(Object.isFrozen(avatar.rhythm));
  assert.ok(Object.isFrozen(avatar.camera));
  assert.ok(Object.isFrozen(avatar.voiceMusic));
  let threw = false;
  try {
    avatar.rhythm.stopSec = 999;
  } catch {
    threw = true;
  }
  // В строгом режиме присваивание в замороженный объект бросает; в нестрогом — тихо ничего не
  // меняет. Оба исхода означают, что порог не мутировал.
  assert.ok(threw || avatar.rhythm.stopSec === 2.5);
  assert.equal(avatar.rhythm.stopSec, 2.5);
});

test('waivers need a reason and only soften waivable gates', () => {
  const gates = [gate('G1', 'Ритм спикера', { status: 'fail' }), gate('G5', 'Safe-zone текста', { status: 'fail' }), gate('G4', 'Спикер в первые 3 с', { status: 'fail' })];
  const out = applyWaivers(gates, [{ gate: 'G1', reason: 'правка владельца: пауза на эмоции' }, { gate: 'G5', reason: 'хочу' }, { gate: 'G4', reason: ' ' }]);
  assert.deepEqual(out.map((g) => g.status), ['waived', 'fail', 'fail']);
  assert.match(out[0].hint, /исключение: правка владельца/);
});

// Мутационная проверка: если убрать условие "g.status !== 'fail'", waiver стал бы менять статус
// предупреждения, а не только провала — это уже другое, более сильное решение, чем «списать
// провал», и владелец не давал такого waiver.
test('a waiver only softens the fail gate it names, not a warn gate with the same id', () => {
  const out = applyWaivers([gate('G1', 'x', { status: 'warn' })], [{ gate: 'G1', reason: 'r' }]);
  assert.equal(out[0].status, 'warn');
});

// waiver.reason.trim() в hint — с ведущими/хвостовыми пробелами, чтобы поймать регресс на
// нетримленый текст.
test('a waiver hint trims the stored reason, not just the match check', () => {
  const out = applyWaivers([gate('G1', 'x', { status: 'fail' })], [{ gate: 'G1', reason: '  пауза на эмоции  ' }]);
  assert.equal(out[0].hint, 'исключение: пауза на эмоции');
});

// waivers — не обязательно то, что уже провалидировал compileLayer: applyWaivers может получить
// manifest.json прямо с диска или ручной вызов. Форма входа доверия не заслуживает, но падать на
// ней нельзя — просто не находим исключение.
test('applyWaivers ignores malformed waiver entries instead of crashing', () => {
  const failing = [gate('G1', 'x', { status: 'fail' })];
  for (const bad of [{ G1: 'x' }, [null], [{ gate: 'G1', reason: 123 }], [{ gate: 'G1', reason: ['ok'] }]]) {
    const out = applyWaivers(failing, bad);
    assert.equal(out[0].status, 'fail', JSON.stringify(bad));
  }
});

test('report summary, exit codes and the Russian text', () => {
  const report = buildReport({ kind: 'layer-check', profile: 'avatar', now: new Date('2026-01-01T00:00:00Z'), gates: [
    gate('G1', 'Ритм спикера', { status: 'fail', value: 5, unit: 'с', threshold: '≤ 2,5 с', spans: [{ fromSec: 0, toSec: 5, note: 'план 5 с без события' }], hint: 'разбейте план' }),
    gate('G9', 'Плотность звуков', { status: 'warn' }),
  ] });
  assert.deepEqual(report.summary, { status: 'fail', fail: 1, warn: 1 });
  assert.equal(exitCodeFor(report), 1);
  assert.equal(exitCodeFor({ ...report, error: 'нет файла' }), 2);
  assert.equal(exitCodeFor(buildReport({ kind: 'x', profile: 'avatar', gates: [gate('G9', 'x', { status: 'warn' })] })), 0);
  const text = formatReport(report);
  assert.match(text, /СТОП/);
  assert.match(text, /❌ G1 Ритм спикера: 5 с \(порог ≤ 2,5 с\)/);
  assert.match(text, /0:00,00–0:05,00 план 5 с без события/);
  assert.match(text, /→ разбейте план/);
});

// Отчёт с error — не «всё хорошо», даже если gates пуст: сборка/чтение упали раньше, чем
// появился хоть один гейт, и это не «пройдено с предупреждениями», а «оценить нельзя».
test('a report with an error never reads as good and always exits 2, even with an empty error string', () => {
  const withError = buildReport({ kind: 'layer-check', profile: 'avatar', gates: [], error: 'не собирается plan.js' });
  assert.equal(withError.summary.status, 'error');
  assert.equal(exitCodeFor(withError), 2);
  const text = formatReport(withError);
  assert.doesNotMatch(text, /всё хорошо/);
  assert.match(text, /оценить нельзя/);
  assert.match(text, /❌ Оценить нельзя: не собирается plan\.js/);

  // '' не equal(null): нельзя долго тянуть пустую строку ошибки как «ошибки нет».
  const emptyError = buildReport({ kind: 'layer-check', profile: 'avatar', gates: [], error: '' });
  assert.equal(emptyError.summary.status, 'error');
  assert.equal(exitCodeFor(emptyError), 2);
  assert.ok(emptyError.error, 'пустая строка нормализуется в непустой текст ошибки');

  const noError = buildReport({ kind: 'layer-check', profile: 'avatar', gates: [] });
  assert.equal(noError.error, null);
  assert.equal(exitCodeFor(noError), 0);
});

// 59.999 с делится на минуты ДО округления даёт 59,999.toFixed(2) = "60.00" внутри уже отрезанной
// минутной части — печатался бы обман "0:60,00". Округляем до сантисекунд сначала, потом делим на
// минуты; отрицательные секунды (опечатка в плане, округление на границе нуля) зажимаем в 0.
test('clock rounds to centiseconds before splitting minutes, so 59.999s prints as 1:00,00', () => {
  const report = buildReport({ kind: 'layer-check', profile: 'avatar', gates: [
    gate('G1', 'x', { status: 'warn', spans: [
      { fromSec: 0, toSec: 0, note: 'zero' },
      { fromSec: 59.999, toSec: 59.999, note: 'edge' },
      { fromSec: 125.5, toSec: 125.5, note: 'two-oh-five' },
    ] }),
  ] });
  const text = formatReport(report);
  assert.match(text, /0:00,00–0:00,00 zero/);
  assert.match(text, /1:00,00–1:00,00 edge/);
  assert.match(text, /2:05,50–2:05,50 two-oh-five/);
});

// Секунды до нуля (опечатка в плане, округление на границе) не должны печататься как «-1:55,00» —
// это ничего не говорит человеку, который не думает во внутренних кадрах.
test('clock clamps negative seconds to 0:00,00 instead of printing a negative minute', () => {
  const report = buildReport({ kind: 'layer-check', profile: 'avatar', gates: [
    gate('G1', 'x', { status: 'warn', spans: [{ fromSec: -5, toSec: -0.001, note: 'negative' }] }),
  ] });
  assert.match(formatReport(report), /0:00,00–0:00,00 negative/);
});

test('reports land in <project>/qa and reject unsafe names', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = buildReport({ kind: 'layer-check', profile: 'avatar', gates: [] });
  const paths = writeReport(dir, 'layer-motion-v01-check', report);
  assert.equal(JSON.parse(fs.readFileSync(paths.jsonPath, 'utf8')).kind, 'layer-check');
  assert.ok(fs.readFileSync(paths.textPath, 'utf8').includes('всё хорошо'));
  assert.throws(() => writeReport(dir, '../escape', report), /имя отчёта/);
  // Регресс на регэксп, который допустил бы '/': путь-обход через один сегмент имени.
  assert.throws(() => writeReport(dir, 'a/b', report), /имя отчёта/);
  assert.throws(() => writeReport(dir, 'x'.repeat(82), report), /имя отчёта/);
});

// Если renameSync падает (диск, права, антивирус держит файл), временный файл не должен остаться
// лежать в qa/ — иначе следующий запуск копит мусор рядом с настоящими отчётами.
test('a failed rename cleans up its temp file instead of littering qa/', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-report-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = buildReport({ kind: 'layer-check', profile: 'avatar', gates: [] });
  const brokenFileSystem = {
    mkdirSync: fs.mkdirSync.bind(fs),
    writeFileSync: fs.writeFileSync.bind(fs),
    renameSync: () => { throw new Error('диск занят'); },
    rmSync: fs.rmSync.bind(fs),
  };
  assert.throws(() => writeReport(dir, 'layer-motion-v01-check', report, brokenFileSystem), /диск занят/);
  const left = fs.readdirSync(path.join(dir, 'qa'));
  assert.deepEqual(left.filter((name) => name.endsWith('.tmp') || name.includes('.tmp-')), []);
});

// Тот же приём, но сбой в другой точке: writeFileSync может успеть частично записать временный
// файл (диск переполнился на середине, антивирус прервал запись) и только потом бросить — временный
// файл должен исчезнуть точно так же, как при сбое renameSync, а не остаться битым мусором в qa/.
test('a writeFileSync that writes a partial temp file and then throws also cleans it up', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-report-atomic-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = buildReport({ kind: 'layer-check', profile: 'avatar', gates: [] });
  const brokenFileSystem = {
    mkdirSync: fs.mkdirSync.bind(fs),
    writeFileSync: (file, text, options) => {
      // Реально пишем на диск только часть текста — временный файл существует, когда бросаем.
      fs.writeFileSync(file, String(text).slice(0, 3), options);
      throw new Error('диск переполнен');
    },
    renameSync: fs.renameSync.bind(fs),
    rmSync: fs.rmSync.bind(fs),
  };
  assert.throws(() => writeReport(dir, 'layer-motion-v01-check', report, brokenFileSystem), /диск переполнен/);
  const left = fs.readdirSync(path.join(dir, 'qa'));
  assert.deepEqual(left.filter((name) => name.includes('.tmp-')), []);
});

test('gate() rejects a status outside pass/warn/fail/waived/skipped', () => {
  assert.throws(() => gate('G2', 'x', { status: 'weird' }), /status должен быть одним из/);
});

// gate(..., { spans: undefined }) — явное undefined в fields перекрывает дефолт через spread;
// без страховки formatReport упал бы на g.spans.slice(...).
test('gate() falls back to an empty spans array even when spans: undefined is passed explicitly', () => {
  const g = gate('G1', 'x', { status: 'warn', spans: undefined });
  assert.deepEqual(g.spans, []);
});

// threshold: 0 — валидный порог (например, целевая громкость 0 dB), truthy-проверка его теряла бы;
// числовой threshold форматируется через number() (запятая), а не печатается сырым числом с точкой.
test('formatReport shows a zero threshold and renders numeric thresholds with a Russian comma', () => {
  const text = formatReport(buildReport({ kind: 'preview', profile: 'avatar', gates: [
    gate('G8', 'Голос', { status: 'warn', value: 0, unit: 'dB', threshold: 0 }),
    gate('G3', 'Масштаб', { status: 'fail', value: 1.2345, threshold: 2.5 }),
  ] }));
  assert.match(text, /G8 Голос: 0 dB \(порог 0\)/);
  assert.match(text, /G3 Масштаб: 1,23 \(порог 2,5\)/);
});

// Мутационная проверка: если убрать лимит .slice(0, 3), длинный список спанов раздувает .txt до
// нечитаемости. Полный список уже есть в .json — .txt должен на него указать, а не дублировать.
test('formatReport shows only 3 spans and points at the full JSON report for the rest', () => {
  const spans = [1, 2, 3, 4].map((i) => ({ fromSec: i, toSec: i + 1, note: `n${i}` }));
  const text = formatReport(buildReport({ kind: 'preview', profile: 'avatar', gates: [gate('G1', 'x', { status: 'fail', spans })] }));
  assert.match(text, /n1[\s\S]*n2[\s\S]*n3/);
  assert.doesNotMatch(text, /n4/);
  // Раньше здесь печатался буквальный плейсхолдер «qa/<имя>.json»: formatReport не знает
  // настоящего имени файла (его выбирает writeReport), печатать выдуманный путь — вводить в
  // заблуждение. Указываем на JSON-отчёт рядом, не называя файл, которого formatReport не видел.
  assert.doesNotMatch(text, /qa\/<имя>\.json/);
  assert.match(text, /…и ещё 1 — полный список в JSON-отчёте рядом/);
});

// Мутационная проверка: подсказка не должна печататься для pass — иначе pass-гейт с заметкой
// выглядел бы как замечание, требующее внимания, наравне с warn/fail/waived/skipped.
test('formatReport prints a gate hint everywhere except on a pass gate', () => {
  const text = formatReport(buildReport({ kind: 'preview', profile: 'avatar', gates: [
    gate('G6', 'x', { status: 'pass', hint: 'не должно печататься' }),
    gate('G9', 'x', { status: 'skipped', hint: 'нет музыки' }),
  ] }));
  assert.doesNotMatch(text, /не должно печататься/);
  assert.match(text, /→ нет музыки/);
});

// Мутационная проверка: verdict для warn не должен совпадать с verdict для pass — иначе владелец
// не заметит, что часть гейтов предупредила.
test('an all-warn report prints "есть предупреждения", not "всё хорошо"', () => {
  const text = formatReport(buildReport({ kind: 'preview', profile: 'avatar', gates: [gate('G9', 'x', { status: 'warn' })] }));
  assert.match(text, /есть предупреждения/);
  assert.doesNotMatch(text, /всё хорошо/);
});

// waived и skipped — не fail и не warn: если бы их считали иначе (как один из выживших мутантов
// пытался), любой waiver или пропущенный из-за отсутствия входа гейт красил бы весь отчёт в СТОП.
test('waived and skipped gates count neither as fail nor warn, so the report still passes', () => {
  const report = buildReport({ kind: 'preview', profile: 'avatar', gates: [
    gate('G1', 'x', { status: 'waived', hint: 'исключение: правка владельца' }),
    gate('G9', 'x', { status: 'skipped' }),
  ] });
  assert.deepEqual(report.summary, { status: 'pass', fail: 0, warn: 0 });
  assert.equal(exitCodeFor(report), 0);
  // Только waived (без fail/warn) — «всё хорошо», но с явным числом исключений, а не молча.
  assert.match(formatReport(report), /всё хорошо \(исключений: 1\)/);
});

test('buildReport keeps unused waivers as {gate, reason} and formatReport asks to remove them from plan.js', () => {
  const report = buildReport({ kind: 'layer-check', profile: 'avatar', gates: [gate('G1', 'Ритм')],
    unusedWaivers: [{ gate: 'G1', reason: ' длинный план экрана ', extra: true }] });
  assert.deepEqual(report.unusedWaivers, [{ gate: 'G1', reason: 'длинный план экрана' }]);
  // Лишнее исключение — подсказка автору, а не предупреждение: вердикт и код не меняются.
  assert.deepEqual(report.summary, { status: 'pass', fail: 0, warn: 0 });
  assert.equal(exitCodeFor(report), 0);
  assert.match(formatReport(report), /^☑️ исключение G1 не понадобилось: длинный план экрана — уберите его из plan\.js$/m);
  const plain = buildReport({ kind: 'layer-check', profile: 'avatar', gates: [] });
  assert.deepEqual(plain.unusedWaivers, []);
  assert.doesNotMatch(formatReport(plain), /не понадобилось/);
  // Отчёт, прочитанный с диска без поля, форматируется как раньше.
  const { unusedWaivers, ...old } = plain;
  assert.deepEqual(unusedWaivers, []);
  assert.doesNotMatch(formatReport(old), /не понадобилось/);
});
