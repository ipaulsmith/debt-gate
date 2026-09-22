import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorityError, toolError } from './errors.mjs';

const text = (value) => String(value ?? '').trim();

export function git(cwd, args, { allowFailure = false, input } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw toolError(`Could not run git: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    throw authorityError(
      `Git authority could not be established: git ${args.join(' ')} failed.`,
      { stderr: text(result.stderr) },
    );
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function repositoryRoot(cwd) {
  const result = git(cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (result.status !== 0) throw authorityError('Run `npx debt-gate` inside a Git repository.');
  return text(result.stdout);
}

function resolveCommit(root, ref) {
  const result = git(root, ['rev-parse', '--verify', `${ref}^{commit}`], { allowFailure: true });
  return result.status === 0 ? text(result.stdout) : null;
}

export function isAncestor(root, older, newer) {
  return git(root, ['merge-base', '--is-ancestor', older, newer], { allowFailure: true }).status === 0;
}

export function resolveBase(root, requested) {
  if (requested) {
    const commit = resolveCommit(root, requested);
    if (!commit) throw authorityError(`Trusted base ref ${JSON.stringify(requested)} does not resolve to a commit.`);
    return { ref: requested, commit, selection: 'explicit' };
  }

  const candidates = [];
  const symbolic = git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFailure: true });
  if (symbolic.status === 0) candidates.push(text(symbolic.stdout));
  candidates.push('origin/main', 'main');

  const resolved = [];
  for (const ref of [...new Set(candidates)]) {
    const commit = resolveCommit(root, ref);
    if (commit && !resolved.some((entry) => entry.commit === commit)) resolved.push({ ref, commit });
  }
  if (resolved.length === 0) {
    throw authorityError('No trusted base ref was found. Pass --base <ref> explicitly.');
  }

  let chosen = resolved[0];
  for (const candidate of resolved.slice(1)) {
    if (isAncestor(root, chosen.commit, candidate.commit)) {
      chosen = candidate;
      continue;
    }
    if (!isAncestor(root, candidate.commit, chosen.commit)) {
      throw authorityError(
        `Default base refs diverge (${chosen.ref} and ${candidate.ref}). Pass --base <ref> explicitly.`,
      );
    }
  }
  return { ...chosen, selection: 'automatic' };
}

export function establishAuthority(root, requestedBase) {
  const shallow = text(git(root, ['rev-parse', '--is-shallow-repository']).stdout) === 'true';
  if (shallow) {
    throw authorityError('Shallow history cannot prove the ledger history. Fetch full history before checking.');
  }
  const head = text(git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).stdout);
  const base = resolveBase(root, requestedBase);
  const merge = git(root, ['merge-base', head, base.commit], { allowFailure: true });
  if (merge.status !== 0 || !text(merge.stdout)) {
    throw authorityError(`HEAD has no merge-base with trusted base ${base.ref}.`);
  }
  return { head, baseRef: base.ref, baseCommit: base.commit, mergeBase: text(merge.stdout), selection: base.selection };
}

export function showFile(root, revision, path, { required = true } = {}) {
  const result = git(root, ['show', `${revision}:${path}`], { allowFailure: true });
  if (result.status !== 0) {
    if (!required) return null;
    throw authorityError(`${path} does not exist at trusted revision ${revision.slice(0, 12)}.`);
  }
  return result.stdout;
}

function showFileBuffer(root, revision, path) {
  const result = spawnSync('git', ['show', `${revision}:${path}`], {
    cwd: root,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw toolError(`Could not run git: ${result.error.message}`);
  if (result.status !== 0) {
    throw authorityError(`${path} does not exist at trusted revision ${revision.slice(0, 12)}.`);
  }
  return result.stdout;
}

export function fileHistory(root, from, to, path) {
  const result = git(root, ['rev-list', '--full-history', '--topo-order', '--reverse', `${from}..${to}`, '--', path]);
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function collectFiles(root, path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return [];
  if (!lstatSync(absolute).isDirectory()) return [path];
  const out = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name);
      if (lstatSync(full).isDirectory()) visit(full);
      else out.push(relative(root, full).split(sep).join('/'));
    }
  };
  visit(absolute);
  return out.sort();
}

export function baseFiles(root, revision, path) {
  const result = git(root, ['ls-tree', '-rz', '--name-only', revision, '--', path], { allowFailure: true });
  if (result.status !== 0) return [];
  return result.stdout.split('\0').filter(Boolean).sort();
}

function baseEntry(root, revision, path) {
  const result = git(root, ['ls-tree', '-z', revision, '--', path], { allowFailure: true });
  if (result.status !== 0 || result.stdout.length === 0) return null;
  const match = result.stdout.match(/^(\d+)\s+(\S+)\s+([0-9a-f]+)\t/);
  return match ? { mode: match[1], type: match[2], object: match[3] } : null;
}

function currentMode(stat) {
  if (stat.isSymbolicLink()) return '120000';
  if (!stat.isFile()) return null;
  return stat.mode & 0o111 ? '100755' : '100644';
}

export function verifyTrustedPaths(root, evaluationRoot, revision, paths) {
  const changed = [];
  for (const path of paths) {
    const expected = baseFiles(root, revision, path);
    const actual = collectFiles(evaluationRoot, path);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      changed.push(`${path}: file set differs from trusted base`);
      continue;
    }
    for (const file of expected) {
      const entry = baseEntry(root, revision, file);
      const stat = lstatSync(resolve(evaluationRoot, file));
      if (!entry || entry.type !== 'blob' || currentMode(stat) !== entry.mode) {
        changed.push(`${file}: file type or executable mode differs from trusted base`);
        continue;
      }
      const atBase = showFileBuffer(root, revision, file);
      const onDisk = stat.isSymbolicLink()
        ? Buffer.from(readlinkSync(resolve(evaluationRoot, file)))
        : readFileSync(resolve(evaluationRoot, file));
      if (!atBase.equals(onDisk)) changed.push(`${file}: content differs from trusted base`);
    }
  }
  return changed;
}

export function createIndexSnapshot(root) {
  const directory = mkdtempSync(join(tmpdir(), 'debt-gate-index-'));
  mkdirSync(directory, { recursive: true });
  const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  const result = git(root, ['checkout-index', '--all', '--force', `--prefix=${prefix}`], { allowFailure: true });
  if (result.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw toolError('Could not materialize the staged Git index.', { stderr: text(result.stderr) });
  }
  return { root: directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
