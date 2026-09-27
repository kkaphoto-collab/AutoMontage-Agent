// Kit и проектный слой в Node: тот же код, что рендерит Remotion, собирается esbuild в CommonJS.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { MOTION_KIT_ALIAS, MOTION_KIT_DIR } = require('./remotion-webpack');

const ENGINE_ROOT = path.join(__dirname, '..');
const LAYER_FILES = ['layer.json', 'src/plan.js', 'src/words.js', 'src/sfx-library.js'];

function bundle(contents, resolveDir, sourcefile) {
  return buildSync({
    stdin: { contents, resolveDir, sourcefile, loader: 'js' },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['remotion'],
    alias: { [MOTION_KIT_ALIAS]: MOTION_KIT_DIR },
    logLevel: 'silent',
  }).outputFiles[0].text;
}

// 'remotion' остаётся внешним и берётся из node_modules движка, где бы ни лежал слой.
function evaluate(text, filename) {
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(ENGINE_ROOT);
  compiled._compile(text, filename);
  return compiled.exports;
}

let core = null;
function loadKitCore() {
  if (!core) {
    const file = path.join(MOTION_KIT_DIR, 'core.js');
    core = evaluate(bundle(`export * from ${JSON.stringify(file)};`, MOTION_KIT_DIR, 'kit-core.js'), file);
  }
  return core;
}

function buildLayerManifest(layerDir) {
  const name = path.basename(layerDir);
  for (const file of LAYER_FILES) {
    if (!fs.existsSync(path.join(layerDir, file))) {
      throw new Error(`слой ${name}: нет ${file} (слой создаётся командой automontage layer new)`);
    }
  }
  const at = (file) => JSON.stringify(path.join(layerDir, file));
  const entry = [
    `import layer from ${at('layer.json')};`,
    `import words from ${at('src/words.js')};`,
    `import sfxLibrary from ${at('src/sfx-library.js')};`,
    `import buildPlan from ${at('src/plan.js')};`,
    `import { buildManifest, compileLayer } from '${MOTION_KIT_ALIAS}/core';`,
    'export function manifest() {',
    '  const ctx = { ...layer, words, sfxLibrary };',
    '  return buildManifest(compileLayer(buildPlan(ctx), ctx));',
    '}',
  ].join('\n');
  let text;
  try {
    text = bundle(entry, layerDir, 'layer-manifest.js');
  } catch (error) {
    throw new Error(`слой ${name}: не собирается plan.js — ${error.errors?.[0]?.text || error.message}`);
  }
  return evaluate(text, path.join(layerDir, 'src', 'plan.js')).manifest();
}

module.exports = { buildLayerManifest, loadKitCore };
