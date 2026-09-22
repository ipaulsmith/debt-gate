import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import { authorityError, EXIT, DebtGateError, usageError } from './errors.mjs';
import {
  createIndexSnapshot,
  establishAuthority,
  fileHistory,
  isAncestor,
  repositoryRoot,
  showFile,
  verifyTrustedPaths,
} from './git.mjs';
import { obviousLocalCommandPaths, runRepairPredicate, runScanner, validateConfig } from './protocol.mjs';

export const CONFIG_PATH = '.debt-gate/config.json';
export const BASELINE_PATH = '.debt-gate/baseline.json';

function parseJson(text, label, errorFactory = usageError) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw errorFactory(`${label} is not valid JSON: ${error.message}`);
  }
}

function safePathParts(root, path, label, errorFactory) {
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || resolve(root, fromRoot) !== absolute) {
    throw errorFactory(`${label} must stay inside the repository.`);
  }
  return { absolute, parts: fromRoot.split(sep) };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function withPinnedParent(root, path, label, errorFactory, { create = false } = {}, action) {
  const { parts } = safePathParts(root, path, label, errorFactory);
  const originalDirectory = process.cwd();
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw errorFactory(`${label} repository root is unavailable.`);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw errorFactory(`${label} repository root must be a real directory.`);
  }

  const enter = (directory, expected) => {
    try {
      process.chdir(directory);
    } catch {
      throw errorFactory(`${label} path changed while it was being opened.`);
    }
    const actual = statSync('.');
    if (!actual.isDirectory() || !sameIdentity(actual, expected)) {
      throw errorFactory(`${label} path changed while it was being opened.`);
    }
  };

  try {
    enter(root, rootStat);
    for (const part of parts.slice(0, -1)) {
      let stat;
      try {
        stat = lstatSync(part);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        if (!create) throw errorFactory(`${label} is missing at ${path}.`);
        try {
          mkdirSync(part);
        } catch (mkdirError) {
          if (mkdirError?.code !== 'EEXIST') throw mkdirError;
        }
        stat = lstatSync(part);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw errorFactory(`${label} must not pass through a symbolic link or non-directory path component.`);
      }
      enter(part, stat);
    }
    return action(parts.at(-1));
  } finally {
    process.chdir(originalDirectory);
  }
}

function pinnedTargetStat(target, path, label, errorFactory, { required = true } = {}) {
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (required) throw errorFactory(`${label} is missing at ${path}.`);
    return null;
  }
  if (stat.isSymbolicLink()) {
    throw errorFactory(`${label} must not be a symbolic link, and neither may its repository path.`);
  }
  if (!stat.isFile()) throw errorFactory(`${label} must be a regular file.`);
  return stat;
}

function writeEvaluationFile(root, path, contents, label, errorFactory = usageError) {
  return withPinnedParent(root, path, label, errorFactory, { create: true }, (target) => {
    pinnedTargetStat(target, path, label, errorFactory, { required: false });
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    let descriptor;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o644,
      );
      writeFileSync(descriptor, contents, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      pinnedTargetStat(target, path, label, errorFactory, { required: false });
      renameSync(temporary, target);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  });
}

function readEvaluationFile(root, path, label, errorFactory = usageError) {
  return withPinnedParent(root, path, label, errorFactory, {}, (target) => {
    const expected = pinnedTargetStat(target, path, label, errorFactory);
    let descriptor;
    try {
      descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const actual = fstatSync(descriptor);
      if (!actual.isFile() || !sameIdentity(actual, expected)) {
        throw errorFactory(`${label} changed while it was being opened.`);
      }
      return readFileSync(descriptor, 'utf8');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  });
}

function removeEvaluationFile(root, path, label, errorFactory = usageError) {
  return withPinnedParent(root, path, label, errorFactory, {}, (target) => {
    pinnedTargetStat(target, path, label, errorFactory, { required: false });
    try {
      unlinkSync(target);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  });
}

export function parseBaseline(text, label = 'Baseline') {
  const document = parseJson(text, label, authorityError);
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.items)) {
    throw authorityError(`${label} must have schemaVersion 1 and an items array.`);
  }
  const items = new Map();
  for (const item of document.items) {
    if (!item || typeof item.id !== 'string' || !item.id || items.has(item.id)) {
      throw authorityError(`${label} contains an invalid or duplicate finding id.`);
    }
    items.set(item.id, item);
  }
  return { document, items };
}

function serializedBaseline(findings) {
  return `${JSON.stringify({
    schemaVersion: 1,
    items: [...findings.values()].sort((a, b) => a.id.localeCompare(b.id)),
  }, null, 2)}\n`;
}

function withinTrustedPath(file, trustedPaths) {
  const normalized = file.replace(/^\.\//, '');
  return trustedPaths.some((path) => normalized === path || normalized.startsWith(`${path.replace(/\/$/, '')}/`));
}

function validateLocalPolicyCoverage(config, evaluationRoot) {
  const uncovered = obviousLocalCommandPaths(config, evaluationRoot)
    .filter((path) => existsSync(resolve(evaluationRoot, path)))
    .filter((path) => !withinTrustedPath(path, config.trustedPaths));
  if (uncovered.length) {
    throw usageError(`Repository-local command paths must be listed in trustedPaths: ${uncovered.join(', ')}`);
  }
}

function ids(map) {
  return new Set(map.keys());
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

function intersection(left, right) {
  return new Set([...left].filter((value) => right.has(value)));
}

function analyze({ snapshots, findings, repairs, snapshotIsAncestor }) {
  const baseSet = ids(snapshots[0].items);
  let ceiling = new Set(baseSet);
  const ledgerGrowth = new Map();
  const ledgerReintroduced = new Map();

  for (const [index, snapshot] of snapshots.slice(1).entries()) {
    const current = ids(snapshot.items);
    for (const id of difference(current, baseSet)) {
      if (!ledgerGrowth.has(id)) ledgerGrowth.set(id, { id, at: snapshot.label });
    }
    for (const id of current) {
      const reopened = snapshots.slice(0, index + 1)
        .some((prior) => !prior.items.has(id) && snapshotIsAncestor(prior, snapshot));
      if (reopened && !ledgerReintroduced.has(id)) {
        ledgerReintroduced.set(id, { id, at: snapshot.label });
      }
    }
    ceiling = intersection(ceiling, current);
  }

  const currentLedger = ids(snapshots.at(-1).items);
  const currentFindings = ids(findings);
  const newFindings = difference(currentFindings, ceiling);
  const disappeared = difference(currentLedger, currentFindings);
  const retired = difference(baseSet, currentLedger);
  const unprovenDisappearances = disappeared.filter((id) => !repairs.has(id));
  const provenTightenings = disappeared.filter((id) => repairs.has(id));
  const invalidRetirements = retired.filter((id) => currentFindings.has(id) || !repairs.has(id));

  return {
    baseCount: baseSet.size,
    ceilingCount: ceiling.size,
    findingCount: currentFindings.size,
    ledgerGrowth: [...ledgerGrowth.values()],
    ledgerReintroduced: [...ledgerReintroduced.values()],
    newFindings,
    disappeared,
    retired,
    unprovenDisappearances,
    provenTightenings,
    invalidRetirements,
  };
}

function candidateRepairIds(snapshots, findings) {
  const base = ids(snapshots[0].items);
  const currentLedger = ids(snapshots.at(-1).items);
  const currentFindings = ids(findings);
  return [...new Set([
    ...difference(base, currentLedger),
    ...difference(currentLedger, currentFindings),
  ])].sort();
}

function makeEvaluation(root, staged) {
  if (!staged) return { root, mode: 'worktree', cleanup: () => {} };
  const snapshot = createIndexSnapshot(root);
  return { ...snapshot, mode: 'staged-index' };
}

export function initialize({ cwd = process.cwd(), scanner, repair, trust = [], format = 'jsonl' } = {}) {
  const root = repositoryRoot(cwd);
  const configFile = resolve(root, CONFIG_PATH);
  const baselineFile = resolve(root, BASELINE_PATH);
  if (existsSync(baselineFile)) throw usageError(`${BASELINE_PATH} already exists; init never overwrites an established ledger.`);

  let config;
  let wroteConfig = false;
  if (existsSync(configFile)) {
    if (scanner || repair || trust.length || format !== 'jsonl') {
      throw usageError(`${CONFIG_PATH} already exists; edit it directly instead of passing init command options.`);
    }
    config = validateConfig(parseJson(readFileSync(configFile, 'utf8'), 'Config'));
  } else {
    if (!scanner || !repair) {
      throw usageError(`Create ${CONFIG_PATH}, or pass both --scanner <path> and --repair <path>.`);
    }
    const commandOf = (path) => /\.(?:c|m)?js$/.test(path) ? ['node', path] : [path];
    const autoTrust = [scanner, repair].filter((path) => !path.startsWith('/'));
    config = validateConfig({
      schemaVersion: 1,
      scanner: { command: commandOf(scanner), format },
      repair: { command: commandOf(repair), format },
      trustedPaths: [...new Set([...autoTrust, ...trust])].sort(),
    });
    writeEvaluationFile(root, CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'Config');
    wroteConfig = true;
  }
  let findings;
  try {
    validateLocalPolicyCoverage(config, root);
    findings = runScanner(config, root, 'worktree');
  } catch (error) {
    if (wroteConfig) {
      try {
        removeEvaluationFile(root, CONFIG_PATH, 'Config');
      } catch {
        // Cleanup must never follow a path that changed while init was running.
      }
    }
    throw error;
  }
  writeEvaluationFile(root, BASELINE_PATH, serializedBaseline(findings), 'Baseline');
  return { root, wroteConfig, findings: findings.size, configPath: CONFIG_PATH, baselinePath: BASELINE_PATH };
}

export function evaluate({ cwd = process.cwd(), base, staged = false } = {}) {
  const root = repositoryRoot(cwd);
  const authority = establishAuthority(root, base);
  const evaluation = makeEvaluation(root, staged);
  try {
    const trustedConfigText = showFile(root, authority.mergeBase, CONFIG_PATH);
    const currentConfigText = readEvaluationFile(evaluation.root, CONFIG_PATH, 'Config', authorityError);
    if (currentConfigText !== trustedConfigText) {
      throw authorityError(`${CONFIG_PATH} differs from trusted merge-base; feature branches may not change enforcement policy.`);
    }
    const config = validateConfig(parseJson(trustedConfigText, 'Trusted config', authorityError));
    validateLocalPolicyCoverage(config, evaluation.root);
    const changedPolicy = verifyTrustedPaths(root, evaluation.root, authority.mergeBase, config.trustedPaths);
    if (changedPolicy.length) {
      throw authorityError('Trusted scanner/config/repair policy differs from the merge-base.', { changedPolicy });
    }

    const baseBaselineText = showFile(root, authority.mergeBase, BASELINE_PATH);
    const snapshots = [{
      label: `merge-base ${authority.mergeBase.slice(0, 12)}`,
      revision: authority.mergeBase,
      ...parseBaseline(baseBaselineText, 'Trusted baseline'),
    }];
    for (const revision of fileHistory(root, authority.mergeBase, authority.head, BASELINE_PATH)) {
      const contents = showFile(root, revision, BASELINE_PATH, { required: false });
      if (contents === null) {
        snapshots.push({
          label: `commit ${revision.slice(0, 12)} (ledger deleted)`,
          revision,
          document: { schemaVersion: 1, items: [] },
          items: new Map(),
        });
      } else {
        snapshots.push({
          label: `commit ${revision.slice(0, 12)}`,
          revision,
          ...parseBaseline(contents, `Baseline at ${revision.slice(0, 12)}`),
        });
      }
    }
    const currentBaselineText = readEvaluationFile(evaluation.root, BASELINE_PATH, 'Current baseline', authorityError);
    snapshots.push({ label: evaluation.mode, revision: null, ...parseBaseline(currentBaselineText, 'Current baseline') });

    const findings = runScanner(config, evaluation.root, evaluation.mode);
    const repairIds = candidateRepairIds(snapshots, findings);
    const repairs = runRepairPredicate(config, evaluation.root, repairIds, evaluation.mode);
    const ancestry = new Map();
    const snapshotIsAncestor = (older, newer) => {
      if (!older.revision) return false;
      const newerRevision = newer.revision ?? authority.head;
      if (older.revision === newerRevision) return newer.revision === null;
      const key = `${older.revision}:${newerRevision}`;
      if (!ancestry.has(key)) ancestry.set(key, isAncestor(root, older.revision, newerRevision));
      return ancestry.get(key);
    };
    const analysis = analyze({ snapshots, findings, repairs, snapshotIsAncestor });
    return { root, evaluationMode: evaluation.mode, authority, config, snapshots, findings, repairs, analysis };
  } catch (error) {
    if (error instanceof DebtGateError) {
      error.details = { ...error.details, authority };
    }
    throw error;
  } finally {
    evaluation.cleanup();
  }
}

export function verdict(result, { accepting = false } = {}) {
  const { analysis } = result;
  const hard = analysis.ledgerGrowth.length || analysis.ledgerReintroduced.length || analysis.newFindings.length ||
    analysis.unprovenDisappearances.length || analysis.invalidRetirements.length;
  if (hard) return { ok: false, exitCode: EXIT.VIOLATION, needsAccept: false };
  if (analysis.provenTightenings.length && !accepting) {
    return { ok: false, exitCode: EXIT.VIOLATION, needsAccept: true };
  }
  return { ok: true, exitCode: EXIT.OK, needsAccept: false };
}

export function accept(options = {}) {
  if (options.staged) throw usageError('accept writes the working-tree ledger and cannot be combined with --staged.');
  const result = evaluate(options);
  const decision = verdict(result, { accepting: true });
  if (!decision.ok) return { ...result, decision, written: false };
  const currentLedger = result.snapshots.at(-1).items;
  const next = new Map();
  for (const [id, finding] of result.findings) {
    if (currentLedger.has(id)) next.set(id, finding);
  }
  writeEvaluationFile(result.root, BASELINE_PATH, serializedBaseline(next), 'Current baseline', authorityError);
  return { ...result, decision, written: true, accepted: result.analysis.provenTightenings };
}

export { EXIT, DebtGateError };
