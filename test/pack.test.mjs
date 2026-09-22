import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function run(cwd, command, args, options = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    ...options,
  });
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-m', message);
}

async function observeCreateSession(source) {
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const account = Object.freeze({ accountId: 'account-1' });
  const stableId = Symbol('stable-id');
  let legacyCalls = 0;
  let stableCalls = 0;
  let value;
  let threw = false;
  try {
    value = module.createSession(account, Object.freeze({
      randomSessionId() {
        legacyCalls += 1;
        return 'legacy-id';
      },
      stableAccountId(received) {
        stableCalls += 1;
        assert.equal(received, account);
        return stableId;
      },
    }));
  } catch {
    threw = true;
  }
  return {
    legacyCalls,
    stableCalls,
    intendedResult: !threw && value?.id === stableId && value?.account === account,
  };
}

test('packed artifact installs and preserves the guarantee in a fresh repository', { timeout: 60_000 }, async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'debt-gate-pack-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const packed = run(packageRoot, 'npm', ['pack', '--json', '--pack-destination', sandbox]);
  assert.equal(packed.status, 0, packed.stderr);
  const packResult = JSON.parse(packed.stdout);
  const manifest = Array.isArray(packResult) ? packResult[0] : packResult['debt-gate'];
  assert(manifest, 'npm pack did not return a debt-gate manifest');
  const paths = manifest.files.map((file) => file.path);
  assert(paths.includes('bin/debt-gate.mjs'));
  assert(paths.includes('src/engine.mjs'));
  assert(paths.includes('README.md'));
  assert(paths.includes('assets/readme/debt-gate-hero.svg'));
  assert(paths.includes('LICENSE'));
  assert(paths.includes('examples/deprecated-api/scanner.mjs'));
  assert(paths.includes('examples/deprecated-api/js-tokens.mjs'));
  assert.equal(paths.some((path) => path.startsWith('test/')), false);
  assert.equal(paths.some((path) => path.includes('.claude') || path.includes('node_modules')), false);

  write(join(sandbox, 'package.json'), '{"name":"fresh-consumer","private":true}\n');
  const tarball = join(sandbox, manifest.filename);
  const installed = run(sandbox, 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball]);
  assert.equal(installed.status, 0, installed.stderr);
  const bin = join(sandbox, 'node_modules', '.bin', 'debt-gate');
  const help = run(sandbox, bin, ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /debt-gate 0\.1\.0/);
  assert.match(help.stdout, /npx debt-gate init/);
  const imported = run(sandbox, process.execPath, [
    '--input-type=module',
    '--eval',
    "import { DebtGateError, evaluate, initialize } from 'debt-gate'; console.log(DebtGateError.name, typeof evaluate, typeof initialize);",
  ]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout.trim(), 'DebtGateError function function');

  const root = join(sandbox, 'fresh-repo');
  mkdirSync(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Pack Test');
  git(root, 'config', 'user.email', 'pack@example.invalid');
  write(join(root, 'tools', 'scan.mjs'), `import { readFileSync } from 'node:fs';
const state = JSON.parse(readFileSync('state.json', 'utf8'));
for (const finding of state.findings) process.stdout.write(JSON.stringify(finding) + '\\n');
`);
  write(join(root, 'tools', 'repair.mjs'), `import { readFileSync } from 'node:fs';
const state = JSON.parse(readFileSync('state.json', 'utf8'));
let input = ''; for await (const chunk of process.stdin) input += chunk;
for (const id of JSON.parse(input).ids) if (state.repaired.includes(id)) {
  process.stdout.write(JSON.stringify({ id, repaired: true, evidence: 'new representation exists' }) + '\\n');
}
`);
  const setState = (value) => write(join(root, 'state.json'), `${JSON.stringify(value)}\n`);
  setState({ findings: [{ id: 'debt:a' }], repaired: [] });

  let result = run(root, bin, ['init', '--scanner', 'tools/scan.mjs', '--repair', 'tools/repair.mjs']);
  assert.equal(result.status, 0, result.stderr);
  commitAll(root, 'establish debt');
  git(root, 'checkout', '-b', 'feature');

  setState({ findings: [{ id: 'debt:a' }, { id: 'debt:b' }], repaired: [] });
  result = run(root, bin, ['check', '--base', 'main', '--json']);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).changes.newFindings.map((finding) => finding.id), ['debt:b']);

  setState({ findings: [], repaired: ['debt:a'] });
  result = run(root, bin, ['check', '--base', 'main', '--json']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).needsAccept, true);
  result = run(root, bin, ['accept', '--base', 'main', '--json']);
  assert.equal(result.status, 0, result.stderr);
  commitAll(root, 'accept real repair');

  setState({ findings: [{ id: 'debt:a' }], repaired: [] });
  result = run(root, bin, ['check', '--base', 'main', '--json']);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).changes.newFindings.map((finding) => finding.id), ['debt:a']);

  const exampleRoot = join(sandbox, 'example-repo');
  cpSync(join(sandbox, 'node_modules', 'debt-gate', 'examples', 'deprecated-api'), exampleRoot, { recursive: true });
  git(exampleRoot, 'init', '-b', 'main');
  git(exampleRoot, 'config', 'user.name', 'Pack Test');
  git(exampleRoot, 'config', 'user.email', 'pack@example.invalid');
  result = run(exampleRoot, bin, [
    'init',
    '--scanner', 'scanner.mjs',
    '--repair', 'repair.mjs',
    '--trust', 'migration-rules.json',
    '--trust', 'js-tokens.mjs',
  ]);
  assert.equal(result.status, 0, result.stderr);
  commitAll(exampleRoot, 'establish example debt');
  git(exampleRoot, 'checkout', '-b', 'migrate-session');
  const baselinePath = join(exampleRoot, '.debt-gate', 'baseline.json');
  const inheritedBaseline = readFileSync(baselinePath, 'utf8');

  write(join(exampleRoot, 'src', 'session.js'), `export function createSession(account, identity) {
  // identity.stableAccountId(account) is only a comment
  return { id: identity.randomSessionId /* formatting cannot hide this */ (), account };
}
`);
  write(baselinePath, '{"schemaVersion":1,"items":[]}\n');
  result = run(exampleRoot, bin, ['accept', '--base', 'main', '--json']);
  assert.equal(result.status, 1, result.stdout || result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).changes.invalidRetirements, ['session:random-id']);
  assert.equal(readFileSync(baselinePath, 'utf8'), '{"schemaVersion":1,"items":[]}\n');

  write(baselinePath, inheritedBaseline);
  write(join(exampleRoot, 'src', 'session.js'), `export function createSession(account, identity) {
  const note = 'identity.stableAccountId(account)';
  return { id: account.id, account };
}
`);
  result = run(exampleRoot, bin, ['accept', '--base', 'main', '--json']);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.equal(JSON.parse(result.stdout).counts.findings, 1);
  assert.equal(readFileSync(baselinePath, 'utf8'), inheritedBaseline);

  const invalidRepairs = [
    'export function createSession(account, identity) {\n' +
      '  return\n' +
      '  { id: identity.stableAccountId(account), account };\n' +
      '}\n',
    'export function createSession(account, identity) {\n' +
      '  return /* a line break inside this comment\n' +
      '  */ { id: identity.stableAccountId(account), account };\n' +
      '}\n',
    'export function createSession(account, identity) {\n' +
      '  `${identity.randomSessionId()}`;\n' +
      '  return { id: identity.stableAccountId(account), account };\n' +
      '}\n',
    'export function createSession(account, identity) {\n' +
      '  return "not a session"\n' +
      '  { id: identity.stableAccountId(account), account };\n' +
      '}\n',
    'export function createSession(account, identity) {\n' +
      '  const replacementLookingFragment = () => ({ id: identity.stableAccountId(account), account });\n' +
      '  return { id: account.accountId, account };\n' +
      '}\n',
    'export function createSession(account, identity) {\n' +
      '  identity.stableAccountId;\n' +
      '  return { id: account.accountId, account };\n' +
      '}\n',
    'export function createSession(account, identity) {\n' +
      '  const id = identity.stableAccountId(account);\n' +
      '  return { id, account: null };\n' +
      '}\n',
  ];
  for (const source of invalidRepairs) {
    write(baselinePath, inheritedBaseline);
    write(join(exampleRoot, 'src', 'session.js'), source);
    const observed = await observeCreateSession(source);
    assert.equal(
      observed.legacyCalls === 0 && observed.stableCalls === 1 && observed.intendedResult,
      false,
      `runtime oracle unexpectedly accepted ${JSON.stringify(observed)}`,
    );
    const scanner = run(exampleRoot, process.execPath, ['scanner.mjs']);
    assert.equal(scanner.status, 0, scanner.stderr);
    assert.deepEqual(scanner.stdout.trim().split('\n').map((line) => JSON.parse(line).id), ['session:random-id']);
    const predicate = run(exampleRoot, process.execPath, ['repair.mjs'], {
      input: '{"ids":["session:random-id"]}\n',
    });
    assert.equal(predicate.status, 0, predicate.stderr);
    assert.equal(predicate.stdout, '');
    result = run(exampleRoot, bin, ['accept', '--base', 'main', '--json']);
    assert.equal(readFileSync(baselinePath, 'utf8'), inheritedBaseline);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.accepted ?? [], []);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    assert.equal(output.counts.findings, 1);
  }

  write(join(exampleRoot, 'src', 'session.js'), 'export function unrelated() {}\n');
  result = run(exampleRoot, bin, ['accept', '--base', 'main', '--json']);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.equal(JSON.parse(result.stdout).counts.findings, 1);
  assert.equal(readFileSync(baselinePath, 'utf8'), inheritedBaseline);

  write(join(exampleRoot, 'src', 'session.js'), `export function createSession(account, identity) {
  return { id: identity.stableAccountId(account), account };
}
`);
  result = run(exampleRoot, bin, ['check', '--base', 'main', '--json']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).needsAccept, true);
  result = run(exampleRoot, bin, ['accept', '--base', 'main', '--json']);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).accepted, ['session:random-id']);
  commitAll(exampleRoot, 'accept the intended example repair');

  write(join(exampleRoot, 'src', 'session.js'), `export function createSession(account, identity) {
  return { id: identity.randomSessionId(), account };
}
`);
  result = run(exampleRoot, bin, ['check', '--base', 'main', '--json']);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).changes.newFindings.map((finding) => finding.id), ['session:random-id']);
});
