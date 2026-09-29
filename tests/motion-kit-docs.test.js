const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('motion kit is documented for people and agents', () => {
  const guide = read('docs/MOTION-KIT.md');
  for (const id of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12']) assert.match(guide, new RegExp(`\\b${id}\\b`));
  for (const cmd of ['layer new', 'layer check', 'layer render', 'layer import', 'layer brief', 'layer stock', 'layer sheet']) assert.match(guide, new RegExp(cmd));
  assert.match(guide, /@automontage\/motion-kit\/core/);
  assert.match(read('README.md'), /automontage layer new --project-dir/);
  assert.match(read('.env.example'), /^AUTOMONTAGE_SFX_DIR=$/m);
  assert.match(read('ASSETS.md'), /AUTOMONTAGE_SFX_DIR/);
  // Слепое пятно G5: сдвиг из кода сцены внутри KitBox манифест не видит (пробный слой, moveTo).
  assert.match(guide, /Слепое пятно: манифест берёт движение только из анимации kit/);
  assert.match(guide, /`KitBox` не обрезает детей/);
  assert.match(guide, /G5 зелёный, а в кадре текст за safe-зоной/);
  assert.doesNotMatch(guide, /\/Users\/|projects\/20\d\d/);
});
