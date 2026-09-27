const fs = require('node:fs');
const path = require('node:path');

// Remotion excludes node_modules from its JS/JSX loader. An npm installation puts
// our own renderer there too; exempt only this package's real source directory.
function includeInstalledSource(config, sourceDirectory) {
  const source = fs.realpathSync(sourceDirectory);
  return {
    ...config,
    module: {
      ...config.module,
      rules: config.module.rules.map(rule => {
        if (!(rule.test instanceof RegExp) || !rule.test.test('component.jsx')
          || !(rule.exclude instanceof RegExp)) return rule;
        const original = rule.exclude;
        return {
          ...rule,
          exclude(file) {
            const relative = path.relative(source, file);
            if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return false;
            original.lastIndex = 0;
            return original.test(file);
          },
        };
      }),
    },
  };
}

const MOTION_KIT_ALIAS = '@automontage/motion-kit';
const MOTION_KIT_DIR = path.join(__dirname, '..', 'src', 'motion-kit');

// Проектные motion-слои импортируют общие детали по стабильному имени, где бы ни лежал слой.
function withMotionKitAlias(config) {
  return {
    ...config,
    resolve: {
      ...config.resolve,
      alias: { ...(config.resolve?.alias || {}), [MOTION_KIT_ALIAS]: MOTION_KIT_DIR },
    },
  };
}

module.exports = { MOTION_KIT_ALIAS, MOTION_KIT_DIR, includeInstalledSource, withMotionKitAlias };
