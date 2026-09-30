const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bundle } = require('@remotion/bundler');

const ROOT = path.resolve(__dirname, '..');

// Настоящий CLI грузит remotion.config.js через esbuild и выполняет его через eval внутри
// node_modules/@remotion/cli/dist/load-config.js – там __dirname указывает в node_modules,
// а не в scripts/. Этот тест повторяет тот же путь загрузки конфига, чтобы поймать ту же
// поломку alias, что видит реальный `npx remotion render`, а не синтетический вызов функции.
test('remotion.config.js resolves @automontage/motion-kit the same way the Remotion CLI loads it', { timeout: 180_000 }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-motion-kit-alias-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  // Слой лежит ВНЕ движка (projects/<id>/motion-vNN – здесь смоделирован временной папкой).
  const layerSrc = path.join(temporary, 'layer', 'src');
  fs.mkdirSync(layerSrc, { recursive: true });
  const entryPoint = path.join(layerSrc, 'index.jsx');
  fs.writeFileSync(entryPoint, [
    "import { registerRoot } from 'remotion';",
    "import { secToFrame } from '@automontage/motion-kit/core';",
    "import * as kit from '@automontage/motion-kit';",
    "registerRoot(() => null);",
    "globalThis.__probe = [secToFrame(1.5, 25), typeof kit.makeAnchors];",
    '',
  ].join('\n'));

  const cliPackage = path.dirname(require.resolve('@remotion/cli/package.json', { paths: [ROOT] }));
  const { loadConfigFile } = require(path.join(cliPackage, 'dist/load-config.js'));
  const { getWebpackOverrideFn, resetBundlerOverrides } = require(path.join(cliPackage, 'dist/config/override-webpack.js'));
  t.after(resetBundlerOverrides);

  // Тот же вызов, что делает CLI: bundle-и-eval remotion.config.js из корня движка.
  await loadConfigFile(ROOT, 'remotion.config.js', true);
  const override = getWebpackOverrideFn();

  const result = await bundle({
    entryPoint, rootDir: ROOT, publicDir: null, outDir: path.join(temporary, 'bundle'),
    enableCaching: false, ignoreRegisterRootWarning: true,
    webpackOverride: override,
  });
  const js = fs.readFileSync(path.join(result, 'bundle.js'), 'utf8');
  assert.ok(js.includes('makeAnchors'), 'бандл должен содержать код @automontage/motion-kit (index)');
  assert.ok(js.includes('secToFrame'), 'бандл должен содержать код @automontage/motion-kit/core');
});
