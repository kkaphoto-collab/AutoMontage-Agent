const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { runForwardingSignals, SIGNAL_FORWARDING } = require('../scripts/cli');
const cli = path.resolve(__dirname, '../scripts/cli.js');
test('public CLI advertises motion and routes it ahead of legacy build', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /automontage motion/);
  const motion = spawnSync(process.execPath, [cli, 'motion', '--help'], { encoding: 'utf8' });
  assert.equal(motion.status, 0, motion.stderr);
  assert.match(motion.stdout, /motion.*audio|motion.*narration/s);
  assert.match(motion.stdout, /--script.*--voice elevenlabs.*--accept-provider-cost/);
  assert.match(motion.stdout, /separate paid API/);
  assert.doesNotMatch(motion.stderr, /ENOENT|build\.js/);
});

test('public CLI advertises multi-take commands and routes takes to its own script', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /automontage takes add --project-dir/);
  assert.match(help.stdout, /automontage takes pack --project-dir/);
  assert.match(help.stdout, /edit\/v02-takes\.json/);
  const usage = spawnSync(process.execPath, [cli, 'takes'], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: automontage takes add\|pack/);
  assert.doesNotMatch(usage.stderr, /build\.js|ENOENT/);
  const takesHelp = spawnSync(process.execPath, [cli, 'takes', '--help'], { encoding: 'utf8' });
  assert.equal(takesHelp.status, 0, takesHelp.stderr);
  assert.match(takesHelp.stdout, /usage: automontage takes add\|pack/);
});

// Step 0 задачи 33: на Windows у Node нет настоящих POSIX-сигналов — child.kill(signal) там делает
// TerminateProcess, то есть убивает ребёнка мимо его собственной уборки (например, layer new удаляет
// недостроенную папку по SIGINT). Консольное событие и так доходит до ребёнка напрямую через общую
// консольную группу, поэтому на win32 внешний процесс не должен слать сигнал сам — только дождаться
// и передать дальше настоящий код выхода ребёнка.
test('runForwardingSignals never force-kills the child on win32; on other platforms it forwards the signal and, either way, passes the child exit code through unchanged', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const killed = [];
    const child = new EventEmitter();
    child.kill = (signal) => killed.push(signal);
    const processLike = new EventEmitter();
    let exitCode = null;
    processLike.exit = (code) => { exitCode = code; };

    runForwardingSignals(
      SIGNAL_FORWARDING.layer,
      ['check', '--project-dir', 'p'],
      { platform, spawnImpl: () => child, processLike },
    );

    processLike.emit('SIGTERM');
    assert.deepEqual(killed, platform === 'win32' ? [] : ['SIGTERM'], platform);
    // Ребёнок сам решил свой код выхода (собственная уборка на SIGTERM/SIGHUP) — снаружи он просто
    // передаётся дальше, а не переопределяется таблицей signalExitCodes.
    child.emit('exit', 143);
    assert.equal(exitCode, 143, platform);
  }
});
