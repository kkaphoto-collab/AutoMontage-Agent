const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const ROOT = path.join(__dirname, '..', '..');

// Собирает ESM/JSX-модуль движка в CommonJS и выполняет его. stubs подменяют модули
// (например, 'remotion' с useCurrentFrame), остальное грузится обычным require.
function loadEsm(relativeFile, { stubs = {} } = {}) {
  const filename = path.join(ROOT, relativeFile);
  const text = buildSync({
    entryPoints: [filename],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server', 'remotion'],
    alias: { '@automontage/motion-kit': path.join(ROOT, 'src', 'motion-kit') },
    logLevel: 'silent',
  }).outputFiles[0].text;
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (Object.hasOwn(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const compiled = new Module(filename, module);
    compiled.filename = filename;
    compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(text, filename);
    return compiled.exports;
  } finally {
    Module._load = originalLoad;
  }
}

module.exports = { ROOT, loadEsm };
