import { readFileSync } from 'node:fs';
import { accept, CONFIG_PATH, evaluate, initialize, DebtGateError, verdict } from './index.mjs';
import { usageError } from './errors.mjs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `debt-gate ${packageJson.version}

Usage:
  npx debt-gate init --scanner <path> --repair <path> [--trust <path> ...]
  npx debt-gate check [--base <ref>] [--staged] [--json]
  npx debt-gate accept [--base <ref>] [--json]

Commands:
  init      Capture today's findings as inherited debt.
  check     Reject new debt, reopened debt, and unproved removals.
  accept    Remove independently proved repairs from the ledger.

Options:
  --base <ref>       Trusted comparison ref. Otherwise choose origin/HEAD,
                     origin/main, or main conservatively.
  --staged           Check the Git index instead of the working tree.
  --json             Emit one machine-readable JSON document.
  --scanner <path>   init only: executable or Node script that finds debt.
  --repair <path>    init only: independent executable or Node script.
  --trust <path>     init only: additional policy path pinned to merge-base.
  --format <format>  init only: json or jsonl (default: jsonl).
  -h, --help         Show help.
  -v, --version      Show version.

Exit codes: 0 accepted, 1 debt-gate violation, 2 usage, 3 authority, 4 tool protocol.
`;

function parseArgs(argv) {
  const out = {
    command: null,
    base: null,
    staged: false,
    json: false,
    scanner: null,
    repair: null,
    trust: [],
    format: 'jsonl',
    formatSpecified: false,
    help: false,
    version: false,
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) out.command = args.shift();
  const take = (flag) => {
    const value = args.shift();
    if (!value || value.startsWith('--')) throw usageError(`${flag} requires a value.`);
    return value;
  };
  while (args.length) {
    const flag = args.shift();
    if (flag === '-h' || flag === '--help') out.help = true;
    else if (flag === '-v' || flag === '--version') out.version = true;
    else if (flag === '--json') out.json = true;
    else if (flag === '--staged') out.staged = true;
    else if (flag === '--base') out.base = take(flag);
    else if (flag === '--scanner') out.scanner = take(flag);
    else if (flag === '--repair') out.repair = take(flag);
    else if (flag === '--trust') out.trust.push(take(flag));
    else if (flag === '--format') {
      out.format = take(flag);
      out.formatSpecified = true;
    }
    else throw usageError(`Unknown option: ${flag}`);
  }
  return out;
}

function resultJson(result, decision, command) {
  const repairProofs = [...result.repairs.values()];
  const finding = (id) => result.findings.get(id) ?? { id };
  return {
    ok: decision.ok,
    command,
    exitCode: decision.exitCode,
    source: result.evaluationMode,
    authority: result.authority,
    counts: {
      inherited: result.analysis.baseCount,
      effectiveCeiling: result.analysis.ceilingCount,
      findings: result.analysis.findingCount,
    },
    changes: {
      newFindings: result.analysis.newFindings.map(finding),
      ledgerGrowth: result.analysis.ledgerGrowth,
      ledgerReintroduced: result.analysis.ledgerReintroduced,
      unprovenDisappearances: result.analysis.unprovenDisappearances,
      invalidRetirements: result.analysis.invalidRetirements,
      provenTightenings: result.analysis.provenTightenings,
      repairProofs,
    },
    needsAccept: decision.needsAccept,
  };
}

function printIds(io, label, values) {
  if (!values.length) return;
  io.error(`${label} (${values.length}):`);
  for (const value of values) {
    if (typeof value === 'string') io.error(`  - ${value}`);
    else {
      const location = value.path ? ` (${value.path})` : '';
      const message = value.message ? ` — ${value.message}` : '';
      io.error(`  - ${value.id}${location}${message}`);
    }
  }
}

function printCheck(io, result, decision) {
  io.log(`${decision.ok ? 'PASS' : 'FAIL'}: ${decision.ok ? 'debt-gate holds' : 'debt-gate rejected this state'}`);
  io.log(`Authority: ${result.authority.baseRef} @ ${result.authority.mergeBase.slice(0, 12)}; source=${result.evaluationMode}`);
  io.log(`Debt: inherited=${result.analysis.baseCount}, ceiling=${result.analysis.ceilingCount}, findings=${result.analysis.findingCount}`);
  printIds(io, 'New findings', result.analysis.newFindings.map((id) => result.findings.get(id)));
  printIds(io, 'Ledger growth', result.analysis.ledgerGrowth);
  printIds(io, 'Reopened debt', result.analysis.ledgerReintroduced);
  printIds(io, 'Missing repair proof', result.analysis.unprovenDisappearances);
  printIds(io, 'Invalid ledger removal', result.analysis.invalidRetirements);
  printIds(io, 'Proved improvements awaiting acceptance', result.analysis.provenTightenings);
  for (const id of result.analysis.provenTightenings) {
    io.error(`    proof: ${result.repairs.get(id).evidence}`);
  }
  if (result.analysis.newFindings.length) io.error('Next: fix the new findings; adding them to the branch ledger is not allowed.');
  if (result.analysis.ledgerGrowth.length || result.analysis.ledgerReintroduced.length) {
    io.error('Next: restore the ledger to its tightest earlier state; removed debt capacity cannot be reopened.');
  }
  if (result.analysis.unprovenDisappearances.length || result.analysis.invalidRetirements.length) {
    io.error('Next: restore the ledger entries, or complete the migration so the trusted repair predicate emits proof.');
  }
  if (decision.needsAccept) io.error('Next: run `npx debt-gate accept` with the same --base, then commit .debt-gate/baseline.json.');
}

function failure(error) {
  const known = error instanceof DebtGateError;
  return {
    ok: false,
    exitCode: known ? error.exitCode : 4,
    error: {
      kind: known ? error.kind : 'internal',
      message: error instanceof Error ? error.message : String(error),
      ...(known && Object.keys(error.details).length ? { details: error.details } : {}),
    },
  };
}

export function runCli(argv, options = {}) {
  const io = options.io ?? {
    log: (value) => console.log(value),
    error: (value) => console.error(value),
  };
  const cwd = options.cwd ?? process.cwd();
  let parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.version) {
      io.log(packageJson.version);
      return 0;
    }
    if (parsed.help || parsed.command === null) {
      io.log(HELP);
      return 0;
    }
    if (!['init', 'check', 'accept'].includes(parsed.command)) throw usageError(`Unknown command: ${parsed.command}`);

    if (parsed.command === 'init') {
      if (parsed.staged || parsed.base) throw usageError('--staged and --base do not apply to init.');
      const result = initialize({ cwd, scanner: parsed.scanner, repair: parsed.repair, trust: parsed.trust, format: parsed.format });
      const output = { ok: true, command: 'init', exitCode: 0, ...result };
      if (parsed.json) io.log(JSON.stringify(output));
      else {
        io.log(`Initialized ${result.findings} inherited finding(s).`);
        io.log(`Wrote ${result.configPath} and ${result.baselinePath}.`);
        io.log('Review both files, then commit them to the trusted base branch.');
      }
      return 0;
    }

    if (parsed.scanner || parsed.repair || parsed.trust.length || parsed.formatSpecified) {
      throw usageError('--scanner, --repair, --trust, and --format are init-only options.');
    }
    if (parsed.command === 'accept' && parsed.staged) throw usageError('accept cannot be combined with --staged.');

    if (parsed.command === 'check') {
      const result = evaluate({ cwd, base: parsed.base, staged: parsed.staged });
      const decision = verdict(result);
      if (parsed.json) io.log(JSON.stringify(resultJson(result, decision, 'check')));
      else printCheck(io, result, decision);
      return decision.exitCode;
    }

    const result = accept({ cwd, base: parsed.base });
    if (!result.written) {
      if (parsed.json) io.log(JSON.stringify(resultJson(result, result.decision, 'accept')));
      else printCheck(io, result, result.decision);
      return result.decision.exitCode;
    }
    const output = { ...resultJson(result, { ok: true, exitCode: 0, needsAccept: false }, 'accept'), accepted: result.accepted, baselinePath: '.debt-gate/baseline.json' };
    if (parsed.json) io.log(JSON.stringify(output));
    else {
      io.log(`Accepted ${result.accepted.length} proved improvement(s).`);
      io.log('Updated .debt-gate/baseline.json. Commit this tightening with the repair.');
    }
    return 0;
  } catch (error) {
    const output = failure(error);
    if (parsed?.json || argv.includes('--json')) io.log(JSON.stringify(output));
    else {
      io.error(`${output.error.kind.toUpperCase()}: ${output.error.message}`);
      const authority = output.error.details?.authority;
      if (authority) io.error(`Authority: ${authority.baseRef} @ ${authority.mergeBase.slice(0, 12)}`);
      if (output.error.kind === 'tool') io.error('Next: fix the trusted command or its JSON/JSONL protocol output, then rerun the check.');
      if (output.error.kind === 'usage') io.error('Next: run `npx debt-gate --help` and correct the command or configuration.');
    }
    return output.exitCode;
  }
}
