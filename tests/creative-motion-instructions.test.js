const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('every montage route points new chats to the shared choice contract', () => {
  const contract = read('skills/reel-turnkey/references/creative-motion.md');
  const entrypoints = [
    read('AGENTS.md'),
    read('skills/reel-turnkey/SKILL.md'),
    read('skills/reel-from-donor/SKILL.md'),
    read('skills/motion-reel/SKILL.md'),
  ];

  for (const entrypoint of entrypoints) {
    assert.match(entrypoint, /creative-motion\.md/u);
    assert.match(entrypoint, /Как\s+монтируем/iu);
  }

  for (const route of [
    /Уникальный Creative Motion[^\n]*рекоменду/iu,
    /Готовый стиль/iu,
    /По референсу/iu,
  ]) assert.match(contract, route);

  assert.match(contract, /нативные карточки\/кнопки/iu);
  assert.match(contract, /codex-followup/iu);
  assert.match(contract, /реши сам[\s\S]{0,160}Creative Motion/iu);
});

test('creative route is autonomous, project-local, and anti-template', () => {
  const contract = read('skills/reel-turnkey/references/creative-motion.md');
  const turnkey = read('skills/reel-turnkey/SKILL.md');
  const qa = read('skills/reel-turnkey/references/qa-checklist.md');
  const combined = `${contract}\n${turnkey}\n${qa}`;

  for (const invariant of [
    /не задавай[\s\S]*шрифт[\s\S]*цвет[\s\S]*музык/iu,
    /project-local/iu,
    /глобальн.*таймкод/iu,
    /современн.*кирилли/iu,
    /не повторяй одну композицию/iu,
    /одинаков.*motion-механик.*сосед/iu,
    /пуст.*чёрн.*переход/iu,
    /реальн.*интерфейс/iu,
    /официальн.*логотип/iu,
    /скриншот.*крупно и целиком/iu,
    /узел.*соединител.*следующ.*узел/iu,
    /начале, середине и конце/iu,
  ]) assert.match(combined, invariant);

  assert.doesNotMatch(turnkey, /Не генерируй новый дизайн ролика/u);
});

test('public guidance and behavioral evals expose the new choice', () => {
  for (const file of ['README.md', 'docs/MONTAGE-GUIDE.md', 'docs/TEMPLATES.md']) {
    const document = read(file);
    assert.match(document, /Уникальный Creative Motion/iu, file);
    assert.match(document, /Готовый стиль/iu, file);
    assert.match(document, /По референсу/iu, file);
  }

  const turnkeyEvals = JSON.parse(read('skills/reel-turnkey/evals/evals.json'));
  const delegated = turnkeyEvals.evals.find(item => item.id === 9);
  assert.ok(delegated);
  assert.match(delegated.expected_output, /автоном/iu);

  const donorEvals = JSON.parse(read('skills/reel-from-donor/evals/evals.json'));
  assert.match(JSON.stringify(donorEvals), /не задаёт серию вопросов/iu);
});

test('all public adapters advertise the autonomous route chooser', () => {
  for (const prefix of ['.agents', '.claude', '.codex']) {
    for (const skill of ['reel-turnkey', 'reel-from-donor']) {
      const adapter = read(`${prefix}/skills/${skill}/SKILL.md`);
      assert.match(adapter, /Creative Motion/u);
      assert.match(adapter, /skills\/(?:reel-turnkey|reel-from-donor)\/SKILL\.md/u);
    }
  }

  const canonicalMotion = read('skills/motion-reel/SKILL.md');
  for (const prefix of ['.agents', '.codex']) {
    assert.equal(read(`${prefix}/skills/motion-reel/SKILL.md`), canonicalMotion);
  }
});

test('motion layer brief and creative motion start with the kit and its gates', () => {
  const brief = read('skills/reel-turnkey/references/motion-layer-brief.md');
  for (const rule of [
    'automontage layer new', 'automontage layer check', '70/130/250/420', '2,5 с', 'muted',
    'public/SOURCE.md', 'hook: \'enumeration\'', 'waivers',
    // Кадр слоя без защищённого env-файла отдал бы браузеру Remotion значения из .env движка.
    '--env-file=config/remotion-public.env', 'cover: true', 'automontage inbox --accept',
  ]) {
    assert.ok(brief.includes(rule), rule);
  }
  // Не просто упоминание /api/approve, а запрет: утверждает только владелец.
  assert.match(brief, /не утверждай[^\n]*\n?[^\n]*не вызывай API пульта \(`\/api\/approve`\)/u);
  assert.doesNotMatch(brief, /\/Users\/|\/home\/|projects\/20\d\d/u);
  assert.doesNotMatch(brief, /\u2014/u);
  const creative = read('skills/reel-turnkey/references/creative-motion.md');
  assert.match(creative, /automontage layer new/);
  assert.match(creative, /audioMode: "mix"/);
  assert.match(creative, /motion-layer-brief\.md/);
  const checklist = read('skills/reel-turnkey/references/qa-checklist.md');
  assert.match(checklist, /2,5 секунды/);
  assert.match(checklist, /automontage layer check/);
  // Правило владельца о музыке остаётся рядом с G8, чья заглушка ждёт калибровки.
  assert.match(checklist, /12–18 dB ниже голоса/u);
  assert.match(checklist, /G8[\s\S]*заглушк/u);
  // Широкое правило: музыку ради заглушки G8 не трогают вовсе, а не только игнорируют подсказку.
  for (const [name, text] of [['brief', brief], ['creative', creative], ['checklist', checklist]]) {
    assert.match(text, /ради заглушки не меня/u, name);
  }
});

test('reel skills start motion layers from the kit and gate them before the pult', () => {
  for (const file of ['skills/motion-reel/SKILL.md', 'skills/reel-from-donor/SKILL.md', 'skills/reel-turnkey/SKILL.md']) {
    const text = read(file);
    assert.match(text, /automontage layer new/, file);
    assert.match(text, /automontage layer check/, file);
    assert.match(text, /motion-layer-brief\.md/, file);
    const block = text.split('## Motion-слой из kit')[1]?.split('\n## ')[0];
    assert.ok(block, `${file}: нет блока «Motion-слой из kit»`);
    for (const step of ['automontage layer render', 'automontage layer import', 'automontage layer brief',
      'automontage preview', 'automontage layer sheet', 'automontage layer stock', 'docs/MOTION-KIT.md']) {
      assert.ok(block.includes(step), `${file}: ${step}`);
    }
    // Отчёты preview бывают с ⚠️: в пульт не пускает только ❌, а не «зелёный» итог.
    assert.match(block, /без ❌/u, file);
    assert.doesNotMatch(text, /зелёными отчётами/u, file);
    // layer sheet работает с текущим preview, а не с рендером слоя.
    assert.match(block, /layer sheet[^\n]*\n?[^\n]*текущего preview/u, file);
    // Заглушка G8 до калибровки: brief без музыки, громкость музыки ради неё не трогают.
    assert.match(block, /без `--music`/u, file);
    assert.match(block, /ради заглушки не\s+меня/u, file);
    assert.match(block, /music\.gainDb[^\n]*не выполняй/u, file);
    // Утверждает только владелец.
    assert.match(block, /Утверждает только владелец[\s\S]{0,40}«Утверждаю» в пульте[\s\S]{0,20}«утверждаю»\s+в\s+чате/u, file);
    assert.doesNotMatch(block, /\u2014/u, file);
    assert.doesNotMatch(block, /\/Users\/|\/home\/|projects\/20\d\d/u, file);
  }

  const motion = read('skills/motion-reel/SKILL.md');
  // Ролик только из озвучки остаётся на встроенном MotionReel; kit – для аватара или спикера в кадре.
  assert.match(motion, /без видео спикера[^\n]*\n?[^\n]*встроенным `MotionReel`, как раньше/u);
  assert.match(motion, /kit нужен, когда в кадре есть аватар или спикер/iu);
  // Известный пробел D-038: preview motion-reel барьер гейтов не проверяет.
  assert.match(motion, /барьер[\s\S]{0,80}D-038/u);

  // Слой kit несёт звук эффектов: mix, а немой по умолчанию только слой без kit.
  const turnkey = read('skills/reel-turnkey/SKILL.md');
  assert.match(turnkey, /Слой kit подключается с `audioMode: "mix"`/u);
  assert.match(turnkey, /--audio mute/u);
  assert.doesNotMatch(turnkey, /`brollMedia` с `audioMode: mute`/u);
});
