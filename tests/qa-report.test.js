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

// Orchestrator adjustment 2: гейт (например, применяющий waiver или считающий вставки) не должен
// иметь возможность поменять порог для следующего гейта той же проверки — это была бы случайная
// связь между независимыми гейтами через общий объект профиля.
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

// Orchestrator adjustment 1: 59.999 с делится на минуты ДО округления даёт 59,999.toFixed(2) =
// "60.00" внутри уже отрезанной минутной части — печатался бы обман "0:60,00". Округляем до
// сантисекунд сначала, потом делим на минуты.
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

test('reports land in <project>/qa and reject unsafe names', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = buildReport({ kind: 'layer-check', profile: 'avatar', gates: [] });
  const paths = writeReport(dir, 'layer-motion-v01-check', report);
  assert.equal(JSON.parse(fs.readFileSync(paths.jsonPath, 'utf8')).kind, 'layer-check');
  assert.ok(fs.readFileSync(paths.textPath, 'utf8').includes('всё хорошо'));
  assert.throws(() => writeReport(dir, '../escape', report), /имя отчёта/);
});

// Orchestrator adjustment 3: если renameSync падает (диск, права, антивирус держит файл), временный
// файл не должен остаться лежать в qa/ — иначе следующий запуск копит мусор.
test('a failed rename cleans up its temp file instead of littering qa/', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-report-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = buildReport({ kind: 'layer-check', profile: 'avatar', gates: [] });
  const brokenFileSystem = {
    mkdirSync: fs.mkdirSync.bind(fs),
    writeFileSync: fs.writeFileSync.bind(fs),
    renameSync: () => { throw new Error('диск занят'); },
    unlinkSync: fs.unlinkSync.bind(fs),
  };
  assert.throws(() => writeReport(dir, 'layer-motion-v01-check', report, brokenFileSystem), /диск занят/);
  const left = fs.readdirSync(path.join(dir, 'qa'));
  assert.deepEqual(left.filter((name) => name.endsWith('.tmp')), []);
});
