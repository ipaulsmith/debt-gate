import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const cli = join(packageRoot, 'bin', 'debt-gate.mjs');
const keep = process.argv.includes('--keep');
const outputArg = process.argv.find((argument) => argument.startsWith('--output='));
const outputPath = outputArg ? resolve(outputArg.slice('--output='.length)) : null;

const repositories = [
  {
    name: 'node-inspector/node-inspector',
    type: 'debugger',
    language: 'JavaScript',
    sha: '79e01c049286374f86dd560742a614019c02402f',
    target: 'lib/config.js',
    extensions: ['.cjs', '.js', '.mjs'],
    injectedPath: 'field-new-debt.js',
    injectedSource: "const util = require('util');\nmodule.exports = util.isArray([]);\n",
    reintroducedSource: '\nutil.isArray([]);\n',
    rule: {
      id: 'util-is-array',
      old: 'util.isArray(',
      replacement: 'Array.isArray(',
      message: 'Uses deprecated util.isArray',
    },
  },
  {
    name: 'codeclysm/extract',
    type: 'archive library',
    language: 'Go',
    sha: '9d5343d9116fe95ef462fd00e5837786e4c9d8d5',
    target: 'extractor.go',
    extensions: ['.go'],
    injectedPath: 'field-new-debt.go',
    injectedSource: 'package extract\n\nimport "io/ioutil"\n\nfunc legacy() { _, _ = ioutil.ReadAll(nil) }\n',
    reintroducedSource: '\nfunc fieldTestLegacy() { _, _ = ioutil.ReadAll(nil) }\n',
    rule: {
      id: 'ioutil-read-all',
      old: 'ioutil.ReadAll(',
      replacement: 'io.ReadAll(',
      message: 'Uses deprecated ioutil.ReadAll',
    },
  },
  {
    name: 'ddollar/foreman',
    type: 'process manager',
    language: 'Ruby',
    sha: '5b815c5d8077511664a712aca90b070229ca6413',
    target: 'lib/foreman/export/base.rb',
    extensions: ['.rb'],
    injectedPath: 'field-new-debt.rb',
    injectedSource: 'File.exists?("field-test")\n',
    reintroducedSource: '\nFile.exists?("field-test")\n',
    rule: {
      id: 'file-exists',
      old: 'File.exists?(',
      replacement: 'File.exist?(',
      message: 'Uses deprecated File.exists?',
    },
  },
];

function run(command, args, cwd, expected = [0]) {
  const started = performance.now();
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const durationMs = Math.round(performance.now() - started);
  if (result.error) throw result.error;
  if (!expected.includes(result.status)) {
    throw new Error([
      `${command} ${args.join(' ')} exited ${result.status}; expected ${expected.join(' or ')}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return { ...result, durationMs };
}

function git(cwd, ...args) {
  return run('git', args, cwd);
}

function commit(cwd, message) {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '--quiet', '-m', message);
}

function invoke(cwd, command, expected) {
  const result = run(process.execPath, [cli, command, '--base', 'main', '--json'], cwd, expected);
  return {
    exitCode: result.status,
    durationMs: result.durationMs,
    output: JSON.parse(result.stdout.trim()),
  };
}

function currentCount(cwd) {
  const scan = run(process.execPath, [join(cwd, '.field-test', 'scanner.mjs')], cwd);
  return scan.stdout.split('\n').filter(Boolean).length;
}

function switchToCase(cwd, name) {
  git(cwd, 'switch', '--quiet', 'main');
  run('git', ['branch', '-D', `field/${name}`], cwd, [0, 1]);
  git(cwd, 'switch', '--quiet', '-c', `field/${name}`);
}

function finishCase(cwd, name) {
  git(cwd, 'switch', '--quiet', 'main');
  git(cwd, 'branch', '-D', `field/${name}`);
}

function cloneSnapshot(entry, destination) {
  const source = `${destination}-source`;
  mkdirSync(source, { recursive: true });
  git(source, 'init', '--quiet');
  git(source, 'remote', 'add', 'origin', `https://github.com/${entry.name}.git`);
  git(source, 'fetch', '--quiet', '--depth', '1', 'origin', entry.sha);
  git(source, 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
  cpSync(source, destination, {
    recursive: true,
    filter: (path) => !/(?:^|[\\/])\.git(?:[\\/]|$)/.test(path),
  });
  rmSync(source, { recursive: true, force: true });
}

function prepare(entry, destination) {
  cloneSnapshot(entry, destination);
  git(destination, 'init', '--quiet', '-b', 'main');
  git(destination, 'config', 'user.name', 'debt-gate field test');
  git(destination, 'config', 'user.email', 'field-test@debt-gate.invalid');
  commit(destination, `snapshot ${entry.name}@${entry.sha}`);

  const tools = join(destination, '.field-test');
  mkdirSync(tools, { recursive: true });
  cpSync(join(here, 'scanner.mjs'), join(tools, 'scanner.mjs'));
  cpSync(join(here, 'repair.mjs'), join(tools, 'repair.mjs'));
  writeFileSync(join(tools, 'policy.json'), `${JSON.stringify({ extensions: entry.extensions, rules: [entry.rule] }, null, 2)}\n`);
  commit(destination, 'add field-test policy');

  run(process.execPath, [
    cli,
    'init',
    '--scanner', '.field-test/scanner.mjs',
    '--repair', '.field-test/repair.mjs',
    '--trust', '.field-test/policy.json',
  ], destination);
  commit(destination, 'capture inherited debt');
}

function replaceTarget(cwd, entry) {
  const path = join(cwd, entry.target);
  const before = readFileSync(path, 'utf8');
  if (!before.includes(entry.rule.old)) throw new Error(`${entry.target} no longer contains ${entry.rule.old}`);
  writeFileSync(path, before.replaceAll(entry.rule.old, entry.rule.replacement));
}

function summarize(check) {
  const changes = check.output.changes;
  return {
    exitCode: check.exitCode,
    durationMs: check.durationMs,
    needsAccept: check.output.needsAccept,
    newFindings: changes.newFindings.length,
    unprovenDisappearances: changes.unprovenDisappearances.length,
    provenTightenings: changes.provenTightenings.length,
    reopened: changes.ledgerReintroduced.length,
  };
}

function exercise(entry, cwd) {
  prepare(entry, cwd);
  const baselineCount = currentCount(cwd);
  const scenarios = {};

  scenarios.existingDebt = {
    countOnly: 'allow',
    debtGate: summarize(invoke(cwd, 'check', [0])),
    currentCount: baselineCount,
  };

  switchToCase(cwd, 'new-debt');
  writeFileSync(join(cwd, entry.injectedPath), entry.injectedSource);
  commit(cwd, 'introduce a new policy violation');
  scenarios.newDebt = {
    countOnly: 'block',
    debtGate: summarize(invoke(cwd, 'check', [1])),
    currentCount: currentCount(cwd),
  };
  finishCase(cwd, 'new-debt');

  switchToCase(cwd, 'deleted-file');
  rmSync(join(cwd, entry.target));
  commit(cwd, 'delete a file instead of repairing it');
  scenarios.deletedWithoutRepair = {
    countOnly: 'allow',
    debtGate: summarize(invoke(cwd, 'check', [1])),
    currentCount: currentCount(cwd),
  };
  finishCase(cwd, 'deleted-file');

  switchToCase(cwd, 'same-count-swap');
  replaceTarget(cwd, entry);
  writeFileSync(join(cwd, entry.injectedPath), entry.injectedSource);
  commit(cwd, 'swap one inherited finding for a new one');
  scenarios.sameCountSwap = {
    countOnly: 'allow',
    debtGate: summarize(invoke(cwd, 'check', [1])),
    currentCount: currentCount(cwd),
  };
  finishCase(cwd, 'same-count-swap');

  switchToCase(cwd, 'proved-repair');
  replaceTarget(cwd, entry);
  commit(cwd, 'replace the deprecated API');
  const awaitingAcceptance = invoke(cwd, 'check', [1]);
  const accepted = invoke(cwd, 'accept', [0]);
  commit(cwd, 'accept the proved improvement');
  const afterAcceptance = invoke(cwd, 'check', [0]);
  scenarios.provedRepair = {
    countOnly: 'allow',
    beforeAccept: summarize(awaitingAcceptance),
    acceptExitCode: accepted.exitCode,
    afterAccept: summarize(afterAcceptance),
    currentCount: currentCount(cwd),
  };

  const targetPath = join(cwd, entry.target);
  writeFileSync(targetPath, `${readFileSync(targetPath, 'utf8')}${entry.reintroducedSource}`);
  commit(cwd, 'reintroduce accepted debt');
  scenarios.reintroducedDebt = {
    countOnly: 'block',
    debtGate: summarize(invoke(cwd, 'check', [1])),
    currentCount: currentCount(cwd),
  };
  finishCase(cwd, 'proved-repair');

  return { baselineCount, scenarios };
}

const root = mkdtempSync(join(tmpdir(), 'debt-gate-field-tests-'));
const results = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  checkerVersion: JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version,
  repositories: [],
};

try {
  for (const entry of repositories) {
    const cwd = join(root, entry.name.split('/')[1]);
    const result = exercise(entry, cwd);
    results.repositories.push({
      name: entry.name,
      type: entry.type,
      language: entry.language,
      url: `https://github.com/${entry.name}`,
      sha: entry.sha,
      target: entry.target,
      rule: entry.rule,
      ...result,
    });
    process.stderr.write(`PASS ${entry.name}: ${Object.keys(result.scenarios).length} scenarios\n`);
  }
  const json = `${JSON.stringify(results, null, 2)}\n`;
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, json);
  }
  process.stdout.write(json);
  if (keep) process.stderr.write(`Kept workspaces at ${root}\n`);
} finally {
  if (!keep && existsSync(root)) rmSync(root, { recursive: true, force: true });
}
