'use strict';
const fs = require('node:fs');
const path = require('node:path');

const KEY = 'AUTOMONTAGE_PROJECTS_DIR';

function readFromDotEnv(root) {
  try {
    const text = fs.readFileSync(path.join(root, '.env'), 'utf8');
    let value = '';
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(
        new RegExp(`^\\s*(?:export\\s+)?${KEY}\\s*=\\s*(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^#\\r\\n]*))\\s*(?:#.*)?$`),
      );
      if (match) value = (match[1] ?? match[2] ?? match[3]).trim();
    }
    return value;
  } catch (_) {
    return '';
  }
}

// Single source of the projects base directory: process env, then <root>/.env, then <root>/projects.
// Reading .env here means every entry point (preview, motion, pult, inbox) agrees without shell exports.
function resolveProjectsBaseDir(root, env = process.env) {
  const fromEnv = typeof env[KEY] === 'string' ? env[KEY].trim() : '';
  const configured = fromEnv || readFromDotEnv(root);
  return configured ? path.resolve(root, configured) : path.join(root, 'projects');
}

module.exports = { resolveProjectsBaseDir };
