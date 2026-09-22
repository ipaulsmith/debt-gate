import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = join(packageRoot, 'bin', 'debt-gate.mjs');

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
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function debtGate(cwd, ...args) {
  return run(cwd, process.execPath, [cli, ...args]);
}

function state(root, value) {
  write(join(root, 'state.json'), `${JSON.stringify(value, null, 2)}\n`);
}

function baseline(root) {
  return JSON.parse(readFileSync(join(root, '.debt-gate', 'baseline.json'), 'utf8'));
}

function setBaseline(root, ids) {
  write(join(root, '.debt-gate', 'baseline.json'), `${JSON.stringify({
    schemaVersion: 1,
    items: ids.map((id) => ({ id })),
  }, null, 2)}\n`);
}

function commitAll(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-m', message);
}

function fixture(t, initial = [{ id: 'legacy:a', path: 'src/a.js', message: 'legacy call' }], format = 'jsonl') {
  const root = mkdtempSync(join(tmpdir(), 'debt-gate-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Debt Gate Test');
  git(root, 'config', 'user.email', 'debt-gate@example.invalid');
  write(join(root, 'tools', 'scan.mjs'), `import { readFileSync } from 'node:fs';
const value = JSON.parse(readFileSync('state.json', 'utf8'));
if (value.malformed === true) process.stdout.write('{bad json\\n');
else if (${JSON.stringify(format)} === 'json') process.stdout.write(JSON.stringify({ findings: value.findings }) + '\\n');
else for (const finding of value.findings) process.stdout.write(JSON.stringify(finding) + '\\n');
`);
  write(join(root, 'tools', 'repair.mjs'), `import { readFileSync } from 'node:fs';
const value = JSON.parse(readFileSync('state.json', 'utf8'));
const request = JSON.parse(await new Promise((resolve) => {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (part) => input += part);
  process.stdin.on('end', () => resolve(input));
}));
const repairs = [];
for (const id of request.ids) {
  if (value.repaired.includes(id)) repairs.push({ id, repaired: true, evidence: 'replacement exists' });
}
if (${JSON.stringify(format)} === 'json') process.stdout.write(JSON.stringify({ repairs }) + '\\n');
else for (const repair of repairs) process.stdout.write(JSON.stringify(repair) + '\\n');
`);
  write(join(root, 'policy.json'), '{"migration":"legacy"}\n');
  state(root, { findings: initial, repaired: [] });
  const initialized = debtGate(root, 'init', '--scanner', 'tools/scan.mjs', '--repair', 'tools/repair.mjs', '--trust', 'policy.json', '--format', format);
  assert.equal(initialized.status, 0, initialized.stderr);
  commitAll(root, 'record existing debt');
  git(root, 'checkout', '-b', 'feature');
  return root;
}

function directoryPolicyFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'debt-gate-policy-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Debt Gate Test');
  git(root, 'config', 'user.email', 'debt-gate@example.invalid');
  write(join(root, 'tools', 'scan.mjs'), "process.stdout.write('');\n");
  write(join(root, 'tools', 'repair.mjs'), "process.stdout.write('');\n");
  write(join(root, 'tools', 'rules', 'legacy.json'), '{"rule":"legacy"}\n');
  write(join(root, 'tools', 'rules', 'café.json'), '{"rule":"unicode"}\n');
  write(join(root, 'tools', 'rules', 'with space.json'), '{"rule":"space"}\n');
  write(join(root, 'tools', 'rules', 'with\ttab.json'), '{"rule":"tab"}\n');
  write(join(root, 'tools', 'rules', 'with\nnewline.json'), '{"rule":"newline"}\n');
  const initialized = debtGate(root, 'init', '--scanner', 'tools/scan.mjs', '--repair', 'tools/repair.mjs', '--trust', 'tools');
  assert.equal(initialized.status, 0, initialized.stderr);
  commitAll(root, 'establish directory policy');
  git(root, 'checkout', '-b', 'feature');
  return root;
}

test('init, help, version, JSON output, and nested invocation are usable', (t) => {
  const root = fixture(t);
  assert.deepEqual(baseline(root).items.map((item) => item.id), ['legacy:a']);

  const help = debtGate(root, '--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /npx debt-gate check/);

  const version = debtGate(root, '--version');
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^0\.1\.0/);

  mkdirSync(join(root, 'src'), { recursive: true });
  const checked = debtGate(join(root, 'src'), 'check', '--base', 'main', '--json');
  assert.equal(checked.status, 0, checked.stderr);
  const output = JSON.parse(checked.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.counts.inherited, 1);
  assert.equal(output.source, 'worktree');
});

test('JSON command protocol works in addition to JSONL', (t) => {
  const root = fixture(t, [{ id: 'legacy:a' }], 'json');
  assert.equal(debtGate(root, 'check', '--base', 'main').status, 0);
  state(root, { findings: [], repaired: ['legacy:a'] });
  const checked = debtGate(root, 'check', '--base', 'main', '--json');
  assert.equal(checked.status, 1);
  assert.equal(JSON.parse(checked.stdout).needsAccept, true);
});

test('same-count swaps and new findings are rejected', (t) => {
  const root = fixture(t);
  state(root, { findings: [{ id: 'legacy:b', path: 'src/b.js' }], repaired: [] });
  const checked = debtGate(root, 'check', '--base', 'main', '--json');
  assert.equal(checked.status, 1);
  const output = JSON.parse(checked.stdout);
  assert.deepEqual(output.changes.newFindings.map((finding) => finding.id), ['legacy:b']);
  assert.deepEqual(output.changes.unprovenDisappearances, ['legacy:a']);
});

test('moving a finding preserves identity, while renaming its id does not', (t) => {
  const root = fixture(t);
  state(root, { findings: [{ id: 'legacy:a', path: 'src/moved/a.js' }], repaired: [] });
  assert.equal(debtGate(root, 'check', '--base', 'main').status, 0);

  state(root, { findings: [{ id: 'legacy:renamed', path: 'src/moved/a.js' }], repaired: [] });
  const renamed = debtGate(root, 'check', '--base', 'main', '--json');
  assert.equal(renamed.status, 1);
  assert.deepEqual(JSON.parse(renamed.stdout).changes.newFindings.map((finding) => finding.id), ['legacy:renamed']);
});

test('ledger edits and deletion cannot erase inherited debt', (t) => {
  const root = fixture(t);
  setBaseline(root, []);
  let checked = debtGate(root, 'check', '--base', 'main', '--json');
  assert.equal(checked.status, 1);
  assert.deepEqual(JSON.parse(checked.stdout).changes.invalidRetirements, ['legacy:a']);

  unlinkSync(join(root, '.debt-gate', 'baseline.json'));
  checked = debtGate(root, 'check', '--base', 'main', '--json');
  assert.equal(checked.status, 3);
  assert.equal(JSON.parse(checked.stdout).error.kind, 'authority');
});

test('truncated or schema-invalid ledgers fail closed', async (t) => {
  for (const [name, contents] of [
    ['truncated', '{"schemaVersion":1,"items":['],
    ['wrong schema', '{"schemaVersion":2,"items":[]}\n'],
    ['duplicate entries', '{"schemaVersion":1,"items":[{"id":"legacy:a"},{"id":"legacy:a"}]}\n'],
  ]) {
    await t.test(name, (subtest) => {
      const root = fixture(subtest);
      write(join(root, '.debt-gate', 'baseline.json'), contents);
      const checked = debtGate(root, 'check', '--base', 'main', '--json');
      assert.equal(checked.status, 3);
      assert.equal(JSON.parse(checked.stdout).error.kind, 'authority');
    });
  }
});

test('a repair must be proved, explicitly accepted, and cannot later regress', (t) => {
  const root = fixture(t);
  state(root, { findings: [], repaired: [] });
  let checked = debtGate(root, 'check', '--base', 'main', '--json');
  assert.equal(checked.status, 1);
  assert.deepEqual(JSON.parse(checked.stdout).changes.unprovenDisappearances, ['legacy:a']);

  state(root, { findings: [], repaired: ['legacy:a'] });
  checked = debtGate(root, 'check', '--base', 'main', '--json');
  assert.equal(checked.status, 1);
  assert.equal(JSON.parse(checked.stdout).needsAccept, true);

  const accepted = debtGate(root, 'accept', '--base', 'main', '--json');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout).accepted, ['legacy:a']);
  assert.deepEqual(baseline(root).items, []);
  commitAll(root, 'repair legacy a');

  checked = debtGate(root, 'check', '--base', 'main');
  assert.equal(checked.status, 0, checked.stderr);

  state(root, { findings: [{ id: 'legacy:a', path: 'src/a.js' }], repaired: [] });
  checked = debtGate(root, 'check', '--base', 'main', '--json');
  assert.equal(checked.status, 1);
  assert.deepEqual(JSON.parse(checked.stdout).changes.newFindings.map((finding) => finding.id), ['legacy:a']);
});

test('delete-then-restore and remove-then-readd ledger history cannot reopen capacity', (t) => {
  const root = fixture(t);
  const original = readFileSync(join(root, '.debt-gate', 'baseline.json'));

  unlinkSync(join(root, '.debt-gate', 'baseline.json'));
  commitAll(root, 'delete ledger');
  write(join(root, '.debt-gate', 'baseline.json'), original);
  commitAll(root, 'restore ledger');

  const checked = debtGate(root, 'check', '--base', 'main', '--json');
  assert.equal(checked.status, 1);
  assert.deepEqual(JSON.parse(checked.stdout).changes.ledgerReintroduced.map((item) => item.id), ['legacy:a']);
});

test('a ledger removal hidden on a merged side branch still tightens the ceiling', (t) => {
  const root = fixture(t);
  git(root, 'checkout', '-b', 'ledger-side');
  setBaseline(root, []);
  commitAll(root, 'remove debt on side branch');
  git(root, 'checkout', 'feature');
  git(root, 'merge', '--no-ff', '-s', 'ours', '-m', 'hide side branch ledger state', 'ledger-side');

  const checked = debtGate(root, 'check', '--base', 'main', '--json');
  assert.equal(checked.status, 1);
  assert.deepEqual(JSON.parse(checked.stdout).changes.ledgerReintroduced.map((item) => item.id), ['legacy:a']);
});

test('independent sibling repairs merge without being mistaken for reintroduction', async (t) => {
  for (const primary of ['repair-a', 'repair-b']) {
    await t.test(`merge into ${primary}`, (subtest) => {
      const root = fixture(subtest, [{ id: 'legacy:a' }, { id: 'legacy:b' }]);
      git(root, 'branch', 'repair-a', 'main');
      git(root, 'branch', 'repair-b', 'main');

      git(root, 'checkout', 'repair-a');
      state(root, { findings: [{ id: 'legacy:b' }], repaired: ['legacy:a'] });
      assert.equal(debtGate(root, 'accept', '--base', 'main').status, 0);
      commitAll(root, 'repair a');

      git(root, 'checkout', 'repair-b');
      state(root, { findings: [{ id: 'legacy:a' }], repaired: ['legacy:b'] });
      assert.equal(debtGate(root, 'accept', '--base', 'main').status, 0);
      commitAll(root, 'repair b');

      const secondary = primary === 'repair-a' ? 'repair-b' : 'repair-a';
      git(root, 'checkout', primary);
      const merging = run(root, 'git', ['merge', '--no-ff', '--no-commit', secondary]);
      assert.notEqual(merging.status, 0, 'the fixture expects conflicts to exercise a real merge resolution');
      state(root, { findings: [], repaired: ['legacy:a', 'legacy:b'] });
      setBaseline(root, []);
      commitAll(root, 'merge independent repairs');

      const checked = debtGate(root, 'check', '--base', 'main', '--json');
      assert.equal(checked.status, 0, checked.stdout || checked.stderr);
      assert.deepEqual(JSON.parse(checked.stdout).changes.ledgerReintroduced, []);
    });
  }
});

test('a merge cannot restore debt removed by either reachable parent', (t) => {
  const root = fixture(t, [{ id: 'legacy:a' }, { id: 'legacy:b' }]);
  git(root, 'branch', 'retains-a', 'main');
  state(root, { findings: [{ id: 'legacy:b' }], repaired: ['legacy:a'] });
  assert.equal(debtGate(root, 'accept', '--base', 'main').status, 0);
  commitAll(root, 'repair a');

  git(root, 'checkout', 'retains-a');
  write(join(root, 'side.txt'), 'side\n');
  commitAll(root, 'unrelated side change');
  git(root, 'checkout', 'feature');
  git(root, 'merge', '--no-ff', '--no-edit', 'retains-a');
  setBaseline(root, ['legacy:a', 'legacy:b']);
  state(root, { findings: [{ id: 'legacy:a' }, { id: 'legacy:b' }], repaired: [] });
  commitAll(root, 'restore removed debt in merge result');

  const checked = debtGate(root, 'check', '--base', 'main', '--json');
  assert.equal(checked.status, 1);
  assert.deepEqual(JSON.parse(checked.stdout).changes.ledgerReintroduced.map((item) => item.id), ['legacy:a']);
});

test('committing the ledger removal before the semantic repair cannot pass until proof exists', (t) => {
  const root = fixture(t);
  setBaseline(root, []);
  commitAll(root, 'try baseline first');

  let checked = debtGate(root, 'check', '--base', 'main', '--json');
  assert.equal(checked.status, 1);
  assert.deepEqual(JSON.parse(checked.stdout).changes.invalidRetirements, ['legacy:a']);

  state(root, { findings: [], repaired: ['legacy:a'] });
  commitAll(root, 'perform actual repair');
  checked = debtGate(root, 'check', '--base', 'main', '--json');
  assert.equal(checked.status, 0, checked.stdout || checked.stderr);
});

test('documented boundary: commits removed from the reachable graph are not an authority source', (t) => {
  const root = fixture(t);
  state(root, { findings: [], repaired: ['legacy:a'] });
  assert.equal(debtGate(root, 'accept', '--base', 'main').status, 0);
  commitAll(root, 'temporary tightening');
  git(root, 'reset', '--hard', 'main');

  const checked = debtGate(root, 'check', '--base', 'main', '--json');
  assert.equal(checked.status, 0, checked.stdout || checked.stderr);
  assert.equal(JSON.parse(checked.stdout).counts.effectiveCeiling, 1);
});

test('config, scanner, repair predicate, and file-type changes are rejected from the branch', async (t) => {
  const cases = [
    ['config', (root) => write(join(root, '.debt-gate', 'config.json'), `${readFileSync(join(root, '.debt-gate', 'config.json'), 'utf8')} `)],
    ['scanner output format', (root) => {
      const config = JSON.parse(readFileSync(join(root, '.debt-gate', 'config.json'), 'utf8'));
      config.scanner.format = 'json';
      write(join(root, '.debt-gate', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    }],
    ['scanner', (root) => write(join(root, 'tools', 'scan.mjs'), `${readFileSync(join(root, 'tools', 'scan.mjs'), 'utf8')}\n// weakened`)],
    ['repair', (root) => write(join(root, 'tools', 'repair.mjs'), `${readFileSync(join(root, 'tools', 'repair.mjs'), 'utf8')}\n// weakened`)],
    ['declared enforcement policy', (root) => write(join(root, 'policy.json'), '{"migration":"disabled"}\n')],
    ['symlink', (root) => {
      const target = join(root, 'scanner-copy.mjs');
      write(target, readFileSync(join(root, 'tools', 'scan.mjs')));
      unlinkSync(join(root, 'tools', 'scan.mjs'));
      symlinkSync(target, join(root, 'tools', 'scan.mjs'));
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, (subtest) => {
      const root = fixture(subtest);
      mutate(root);
      const checked = debtGate(root, 'check', '--base', 'main', '--json');
      assert.equal(checked.status, 3, checked.stdout || checked.stderr);
      assert.equal(JSON.parse(checked.stdout).error.kind, 'authority');
    });
  }
});

test('trusted directory inventories are globally ordered and preserve unusual Git filenames', (t) => {
  const root = directoryPolicyFixture(t);
  const worktree = debtGate(root, 'check', '--base', 'main', '--json');
  assert.equal(worktree.status, 0, worktree.stdout || worktree.stderr);
  const staged = debtGate(root, 'check', '--base', 'main', '--staged', '--json');
  assert.equal(staged.status, 0, staged.stdout || staged.stderr);
});

test('trusted directory changes fail closed in worktree and staged modes', async (t) => {
  const cases = [
    ['added file', (root) => write(join(root, 'tools', 'rules', 'added.json'), '{}\n')],
    ['removed file', (root) => unlinkSync(join(root, 'tools', 'rules', 'legacy.json'))],
    ['changed content', (root) => write(join(root, 'tools', 'rules', 'legacy.json'), '{"rule":"weakened"}\n')],
    ['changed executable bit', (root) => chmodSync(join(root, 'tools', 'rules', 'legacy.json'), 0o755)],
    ['file replaced by symlink', (root) => {
      const target = join(root, 'outside-policy.json');
      write(target, '{"rule":"legacy"}\n');
      unlinkSync(join(root, 'tools', 'rules', 'legacy.json'));
      symlinkSync(target, join(root, 'tools', 'rules', 'legacy.json'));
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, (subtest) => {
      const root = directoryPolicyFixture(subtest);
      mutate(root);
      const worktree = debtGate(root, 'check', '--base', 'main', '--json');
      assert.equal(worktree.status, 3, worktree.stdout || worktree.stderr);
      git(root, 'add', '-A');
      const staged = debtGate(root, 'check', '--base', 'main', '--staged', '--json');
      assert.equal(staged.status, 3, staged.stdout || staged.stderr);
    });
  }
});

test('ledger writes never follow direct or ancestor symbolic links', async (t) => {
  await t.test('accept refuses a direct ledger symlink', (subtest) => {
    const root = fixture(subtest);
    const external = join(root, '..', `${Date.now()}-external-ledger.json`);
    subtest.after(() => rmSync(external, { force: true }));
    const sentinel = '{"schemaVersion":1,"items":[{"id":"legacy:a"}],"keep":"sentinel"}\n';
    write(external, sentinel);
    state(root, { findings: [], repaired: ['legacy:a'] });
    unlinkSync(join(root, '.debt-gate', 'baseline.json'));
    symlinkSync(external, join(root, '.debt-gate', 'baseline.json'));

    const accepted = debtGate(root, 'accept', '--base', 'main', '--json');
    assert.equal(accepted.status, 3, accepted.stdout || accepted.stderr);
    assert.match(JSON.parse(accepted.stdout).error.message, /symbolic link/i);
    assert.equal(readFileSync(external, 'utf8'), sentinel);
  });

  await t.test('accept refuses an ancestor directory symlink', (subtest) => {
    const root = fixture(subtest);
    const external = mkdtempSync(join(tmpdir(), 'debt-gate-external-ledger-'));
    subtest.after(() => rmSync(external, { recursive: true, force: true }));
    const config = readFileSync(join(root, '.debt-gate', 'config.json'));
    const sentinel = readFileSync(join(root, '.debt-gate', 'baseline.json'));
    write(join(external, 'config.json'), config);
    write(join(external, 'baseline.json'), sentinel);
    rmSync(join(root, '.debt-gate'), { recursive: true });
    symlinkSync(external, join(root, '.debt-gate'));
    state(root, { findings: [], repaired: ['legacy:a'] });

    const accepted = debtGate(root, 'accept', '--base', 'main', '--json');
    assert.equal(accepted.status, 3, accepted.stdout || accepted.stderr);
    assert.equal(readFileSync(join(external, 'baseline.json'), 'utf8'), sentinel.toString('utf8'));
  });

  await t.test('init refuses an ancestor directory symlink', (subtest) => {
    const root = mkdtempSync(join(tmpdir(), 'debt-gate-init-link-'));
    subtest.after(() => rmSync(root, { recursive: true, force: true }));
    git(root, 'init', '-b', 'main');
    const external = mkdtempSync(join(tmpdir(), 'debt-gate-init-external-'));
    subtest.after(() => rmSync(external, { recursive: true, force: true }));
    write(join(root, 'scan.mjs'), "process.stdout.write('');\n");
    write(join(root, 'repair.mjs'), "process.stdout.write('');\n");
    write(join(external, 'sentinel'), 'keep\n');
    symlinkSync(external, join(root, '.debt-gate'));

    const initialized = debtGate(root, 'init', '--scanner', 'scan.mjs', '--repair', 'repair.mjs', '--json');
    assert.equal(initialized.status, 2, initialized.stdout || initialized.stderr);
    assert.match(JSON.parse(initialized.stdout).error.message, /symbolic link/i);
    assert.equal(readFileSync(join(external, 'sentinel'), 'utf8'), 'keep\n');
    assert.equal(existsSync(join(external, 'config.json')), false);
  });
});

test('failed accept leaves a regular ledger byte-for-byte unchanged', (t) => {
  const root = fixture(t);
  const before = readFileSync(join(root, '.debt-gate', 'baseline.json'));
  state(root, { findings: [{ id: 'legacy:a' }, { id: 'legacy:b' }], repaired: [] });
  const accepted = debtGate(root, 'accept', '--base', 'main', '--json');
  assert.equal(accepted.status, 1);
  assert.deepEqual(readFileSync(join(root, '.debt-gate', 'baseline.json')), before);
});

test('staged mode checks exactly the index snapshot', (t) => {
  const root = fixture(t);
  state(root, { findings: [{ id: 'legacy:b' }], repaired: [] });

  const staged = debtGate(root, 'check', '--base', 'main', '--staged');
  assert.equal(staged.status, 0, staged.stderr);
  const worktree = debtGate(root, 'check', '--base', 'main');
  assert.equal(worktree.status, 1);
});

test('trusted installed checker wins over branch-local lookalikes', (t) => {
  const root = fixture(t);
  write(join(root, 'node_modules', 'debt-gate', 'bin', 'debt-gate.mjs'), 'process.exit(0);\n');
  write(join(root, 'node_modules', '.bin', 'debt-gate'), '#!/bin/sh\nexit 0\n');
  state(root, { findings: [{ id: 'legacy:b' }], repaired: [] });
  const checked = debtGate(root, 'check', '--base', 'main', '--json');
  assert.equal(checked.status, 1);
  assert.deepEqual(JSON.parse(checked.stdout).changes.newFindings.map((finding) => finding.id), ['legacy:b']);
});

test('malformed and duplicate scanner output fails closed', async (t) => {
  await t.test('malformed', (subtest) => {
    const root = fixture(subtest);
    state(root, { findings: [], repaired: [], malformed: true });
    const checked = debtGate(root, 'check', '--base', 'main', '--json');
    assert.equal(checked.status, 4);
    assert.equal(JSON.parse(checked.stdout).error.kind, 'tool');
  });
  await t.test('duplicate ids', (subtest) => {
    const root = fixture(subtest);
    state(root, { findings: [{ id: 'legacy:a' }, { id: 'legacy:a' }], repaired: [] });
    const checked = debtGate(root, 'check', '--base', 'main', '--json');
    assert.equal(checked.status, 4);
    assert.match(JSON.parse(checked.stdout).error.message, /duplicate/i);
  });
});

test('usage failures remain machine-readable and init-only options are rejected', (t) => {
  const root = fixture(t);
  const missingValue = debtGate(root, 'check', '--json', '--base');
  assert.equal(missingValue.status, 2);
  assert.equal(JSON.parse(missingValue.stdout).error.kind, 'usage');

  const initOnly = debtGate(root, 'check', '--base', 'main', '--format', 'jsonl', '--json');
  assert.equal(initOnly.status, 2);
  assert.match(JSON.parse(initOnly.stdout).error.message, /init-only/);
});

test('detached HEAD, stale main, merge, rebase, and linked worktrees retain authority', async (t) => {
  await t.test('detached HEAD', (subtest) => {
    const root = fixture(subtest);
    write(join(root, 'note.txt'), 'feature\n');
    commitAll(root, 'feature note');
    git(root, 'checkout', '--detach');
    assert.equal(debtGate(root, 'check', '--base', 'main').status, 0);
  });

  await t.test('stale branch after main advances and merge', (subtest) => {
    const root = fixture(subtest);
    write(join(root, 'feature.txt'), 'feature\n');
    commitAll(root, 'feature');
    git(root, 'checkout', 'main');
    write(join(root, 'main.txt'), 'main\n');
    commitAll(root, 'advance main');
    git(root, 'checkout', 'feature');
    assert.equal(debtGate(root, 'check', '--base', 'main').status, 0);
    git(root, 'merge', '--no-edit', 'main');
    assert.equal(debtGate(root, 'check', '--base', 'main').status, 0);
  });

  await t.test('rebase', (subtest) => {
    const root = fixture(subtest);
    write(join(root, 'feature.txt'), 'feature\n');
    commitAll(root, 'feature');
    git(root, 'checkout', 'main');
    write(join(root, 'main.txt'), 'main\n');
    commitAll(root, 'advance main');
    git(root, 'checkout', 'feature');
    git(root, 'rebase', 'main');
    assert.equal(debtGate(root, 'check', '--base', 'main').status, 0);
  });

  await t.test('linked worktree', (subtest) => {
    const root = fixture(subtest);
    const linked = mkdtempSync(join(tmpdir(), 'debt-gate-worktree-'));
    rmSync(linked, { recursive: true, force: true });
    subtest.after(() => rmSync(linked, { recursive: true, force: true }));
    git(root, 'worktree', 'add', '-b', 'linked', linked, 'main');
    assert.equal(debtGate(linked, 'check', '--base', 'main').status, 0);
  });
});

test('shallow history and ambiguous default refs fail closed', async (t) => {
  await t.test('shallow clone', (subtest) => {
    const source = fixture(subtest);
    git(source, 'checkout', 'main');
    const clone = mkdtempSync(join(tmpdir(), 'debt-gate-shallow-'));
    rmSync(clone, { recursive: true, force: true });
    subtest.after(() => rmSync(clone, { recursive: true, force: true }));
    execFileSync('git', ['clone', '--depth', '1', '--branch', 'main', `file://${source}`, clone], { encoding: 'utf8' });
    const checked = debtGate(clone, 'check', '--base', 'main', '--json');
    assert.equal(checked.status, 3);
    assert.match(JSON.parse(checked.stdout).error.message, /Shallow history/);
  });

  await t.test('diverged automatic refs', (subtest) => {
    const root = fixture(subtest);
    write(join(root, 'feature.txt'), 'feature\n');
    commitAll(root, 'feature commit');
    const featureCommit = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', 'main');
    write(join(root, 'main.txt'), 'main\n');
    commitAll(root, 'main commit');
    git(root, 'checkout', 'feature');
    git(root, 'update-ref', 'refs/remotes/origin/main', featureCommit);
    const checked = debtGate(root, 'check', '--json');
    assert.equal(checked.status, 3);
    assert.match(JSON.parse(checked.stdout).error.message, /diverge/i);
  });
});

test('automatic authority works without origin and prefers the fresher comparable main ref', async (t) => {
  await t.test('no origin', (subtest) => {
    const root = fixture(subtest);
    const checked = debtGate(root, 'check', '--json');
    assert.equal(checked.status, 0, checked.stdout || checked.stderr);
    assert.equal(JSON.parse(checked.stdout).authority.baseRef, 'main');
  });

  await t.test('stale origin/main', (subtest) => {
    const root = fixture(subtest);
    const oldMain = git(root, 'rev-parse', 'main');
    git(root, 'update-ref', 'refs/remotes/origin/main', oldMain);
    git(root, 'checkout', 'main');
    write(join(root, 'main.txt'), 'advance\n');
    commitAll(root, 'advance local main');
    git(root, 'checkout', 'feature');
    git(root, 'rebase', 'main');
    const checked = debtGate(root, 'check', '--json');
    assert.equal(checked.status, 0, checked.stdout || checked.stderr);
    assert.equal(JSON.parse(checked.stdout).authority.baseRef, 'main');
  });

  await t.test('stale local main', (subtest) => {
    const root = fixture(subtest);
    const oldMain = git(root, 'rev-parse', 'main');
    git(root, 'checkout', 'main');
    write(join(root, 'remote.txt'), 'advance\n');
    commitAll(root, 'advance remote main');
    const remoteMain = git(root, 'rev-parse', 'main');
    git(root, 'update-ref', 'refs/remotes/origin/main', remoteMain);
    git(root, 'checkout', 'feature');
    git(root, 'branch', '-f', 'main', oldMain);
    git(root, 'rebase', 'origin/main');
    const checked = debtGate(root, 'check', '--json');
    assert.equal(checked.status, 0, checked.stdout || checked.stderr);
    assert.equal(JSON.parse(checked.stdout).authority.baseRef, 'origin/main');
  });
});
