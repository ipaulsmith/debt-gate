import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = join(packageRoot, 'bin', 'debt-gate.mjs');
const swapSource = fileURLToPath(new URL('swap.c', import.meta.url));

function run(cwd, command, args) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('concurrent parent-directory replacement cannot redirect a ledger write', {
  timeout: 120_000,
  skip: !['darwin', 'linux'].includes(process.platform),
}, async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'debt-gate-race-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, 'repo');
  const external = join(sandbox, 'external');
  const swap = join(sandbox, 'swap');
  mkdirSync(root);
  mkdirSync(external);
  execFileSync('cc', ['-O2', swapSource, '-o', swap], { stdio: ['ignore', 'pipe', 'pipe'] });

  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Race Test');
  git(root, 'config', 'user.email', 'race@example.invalid');
  writeFileSync(join(root, 'scan.mjs'),
    "import {existsSync} from 'node:fs'; if (!existsSync('fixed')) console.log(JSON.stringify({id:'a'}));\n");
  writeFileSync(join(root, 'repair.mjs'),
    "import {writeFileSync} from 'node:fs'; let input=''; for await (const c of process.stdin) input+=c; " +
    "writeFileSync('ready','1'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30); " +
    "console.log(JSON.stringify({id:'a',repaired:true,evidence:'fixed'}));\n");
  let result = run(root, process.execPath, [cli, 'init', '--scanner', 'scan.mjs', '--repair', 'repair.mjs']);
  assert.equal(result.status, 0, result.stderr);
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'record existing debt');
  git(root, 'switch', '-c', 'feature');

  const baselinePath = join(root, '.debt-gate', 'baseline.json');
  const originalBaseline = readFileSync(baselinePath);
  const externalBaseline = JSON.stringify({
    schemaVersion: 1,
    items: [{ id: 'a' }],
    otherImportantData: 'PRESERVE',
  });
  writeFileSync(join(root, 'fixed'), '1');
  writeFileSync(join(external, 'config.json'), readFileSync(join(root, '.debt-gate', 'config.json')));
  symlinkSync(external, join(root, '.swap'));

  for (let attempt = 0; attempt < 50; attempt += 1) {
    writeFileSync(baselinePath, originalBaseline);
    writeFileSync(join(external, 'baseline.json'), externalBaseline);
    rmSync(join(root, 'ready'), { force: true });
    const worker = spawn(swap, [join(root, '.debt-gate'), join(root, '.swap'), join(root, 'ready')]);
    const workerExit = once(worker, 'exit');
    result = run(root, process.execPath, [cli, 'accept', '--base', 'main', '--json']);
    worker.kill('SIGTERM');
    const [workerStatus, workerSignal] = await workerExit;
    assert(workerStatus === 0 || (workerStatus === null && workerSignal === 'SIGTERM'));
    assert([0, 3].includes(result.status), result.stdout || result.stderr);
    assert.equal(readFileSync(join(external, 'baseline.json'), 'utf8'), externalBaseline);
    assert.deepEqual(readdirSync(external).sort(), ['baseline.json', 'config.json']);
  }
});

test('concurrent parent-directory replacement cannot redirect init files', {
  timeout: 120_000,
  skip: !['darwin', 'linux'].includes(process.platform),
}, async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'debt-gate-init-race-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, 'repo');
  const external = join(sandbox, 'external');
  const swap = join(sandbox, 'swap');
  mkdirSync(root);
  mkdirSync(external);
  execFileSync('cc', ['-O2', swapSource, '-o', swap], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(root, 'init', '-b', 'main');
  writeFileSync(join(root, 'scan.mjs'),
    "import {writeFileSync} from 'node:fs'; writeFileSync('ready','1'); " +
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30); console.log(JSON.stringify({id:'a'}));\n");
  writeFileSync(join(root, 'repair.mjs'), "process.stdout.write('');\n");
  writeFileSync(join(external, 'sentinel'), 'PRESERVE');
  symlinkSync(external, join(root, '.swap'));

  for (let attempt = 0; attempt < 30; attempt += 1) {
    rmSync(join(root, '.debt-gate'), { recursive: true, force: true });
    rmSync(join(root, 'ready'), { force: true });
    const worker = spawn(swap, [join(root, '.debt-gate'), join(root, '.swap'), join(root, 'ready')]);
    const workerExit = once(worker, 'exit');
    const result = run(root, process.execPath, [cli, 'init', '--scanner', 'scan.mjs', '--repair', 'repair.mjs', '--json']);
    worker.kill('SIGTERM');
    const [workerStatus, workerSignal] = await workerExit;
    assert(workerStatus === 0 || (workerStatus === null && workerSignal === 'SIGTERM'));
    assert([0, 2].includes(result.status), result.stdout || result.stderr);
    assert.equal(readFileSync(join(external, 'sentinel'), 'utf8'), 'PRESERVE');
    assert.deepEqual(readdirSync(external), ['sentinel']);
  }
});
