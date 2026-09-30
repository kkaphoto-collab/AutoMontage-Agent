'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveProjectsBaseDir } = require('../scripts/projects-dir');

function tempRoot(envText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-'));
  if (envText !== undefined) fs.writeFileSync(path.join(root, '.env'), envText);
  return root;
}

test('defaults to <root>/projects', () => {
  const root = tempRoot();
  assert.equal(resolveProjectsBaseDir(root, {}), path.join(root, 'projects'));
});

test('reads AUTOMONTAGE_PROJECTS_DIR from .env without a shell export', () => {
  const root = tempRoot('X=1\nAUTOMONTAGE_PROJECTS_DIR=/Volumes/DOC/p # note\n');
  assert.equal(resolveProjectsBaseDir(root, {}), '/Volumes/DOC/p');
});

test('process env wins over .env; quoted values work', () => {
  const root = tempRoot('AUTOMONTAGE_PROJECTS_DIR="/a/b"\n');
  assert.equal(resolveProjectsBaseDir(root, {}), '/a/b');
  assert.equal(resolveProjectsBaseDir(root, { AUTOMONTAGE_PROJECTS_DIR: '/c/d' }), '/c/d');
});

test('empty value in .env falls back to default', () => {
  const root = tempRoot('AUTOMONTAGE_PROJECTS_DIR=\n');
  assert.equal(resolveProjectsBaseDir(root, {}), path.join(root, 'projects'));
});
