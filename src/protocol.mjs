import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { toolError, usageError } from './errors.mjs';

const MAX_OUTPUT = 16 * 1024 * 1024;

function parseRecords(stdout, format, label) {
  try {
    if (format === 'json') {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed.findings)) return parsed.findings;
      if (Array.isArray(parsed.repairs)) return parsed.repairs;
      throw new Error('expected an array, {findings: []}, or {repairs: []}');
    }
    if (format === 'jsonl') {
      return stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    }
    throw new Error(`unsupported format ${JSON.stringify(format)}`);
  } catch (error) {
    throw toolError(`${label} returned invalid ${format.toUpperCase()}: ${error.message}`);
  }
}

function commandDisplay(command) {
  return command.map((part) => (/^[A-Za-z0-9_./:-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}

function runCommand(spec, cwd, label, input, extraEnv = {}) {
  const [executable, ...args] = spec.command;
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    input,
    env: { ...process.env, DEBT_GATE_ROOT: cwd, ...extraEnv },
    maxBuffer: MAX_OUTPUT,
  });
  if (result.error) throw toolError(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw toolError(`${label} failed with exit code ${result.status}: ${commandDisplay(spec.command)}`, {
      stderr: String(result.stderr ?? '').trim().slice(0, 8000),
    });
  }
  return parseRecords(result.stdout ?? '', spec.format, label);
}

function validateId(id, label) {
  if (typeof id !== 'string' || id.trim() === '' || id.length > 512 || /[\r\n\0]/.test(id)) {
    throw toolError(`${label} contains an invalid stable finding id.`);
  }
  return id;
}

export function runScanner(config, cwd, mode) {
  const records = runCommand(config.scanner, cwd, 'Scanner', undefined, { DEBT_GATE_SOURCE: mode });
  const findings = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw toolError('Scanner records must be JSON objects.');
    }
    const id = validateId(record.id, 'Scanner output');
    if (findings.has(id)) throw toolError(`Scanner returned duplicate finding id ${JSON.stringify(id)}.`);
    for (const field of ['message', 'path']) {
      if (record[field] !== undefined && typeof record[field] !== 'string') {
        throw toolError(`Scanner field ${field} for ${JSON.stringify(id)} must be a string.`);
      }
    }
    findings.set(id, {
      id,
      ...(record.message ? { message: record.message } : {}),
      ...(record.path ? { path: record.path } : {}),
    });
  }
  return findings;
}

export function runRepairPredicate(config, cwd, ids, mode) {
  if (ids.length === 0) return new Map();
  const records = runCommand(
    config.repair,
    cwd,
    'Repair predicate',
    `${JSON.stringify({ ids })}\n`,
    { DEBT_GATE_SOURCE: mode },
  );
  const requested = new Set(ids);
  const repairs = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw toolError('Repair predicate records must be JSON objects.');
    }
    const id = validateId(record.id, 'Repair predicate output');
    if (!requested.has(id)) throw toolError(`Repair predicate returned unrequested id ${JSON.stringify(id)}.`);
    if (repairs.has(id)) throw toolError(`Repair predicate returned duplicate id ${JSON.stringify(id)}.`);
    if (record.repaired !== true) throw toolError(`Repair predicate record ${JSON.stringify(id)} must set repaired to true.`);
    if (typeof record.evidence !== 'string' || record.evidence.trim() === '') {
      throw toolError(`Repair predicate record ${JSON.stringify(id)} must include non-empty evidence.`);
    }
    repairs.set(id, { id, evidence: record.evidence });
  }
  return repairs;
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw usageError('Config must be a JSON object.');
  if (config.schemaVersion !== 1) throw usageError('Config schemaVersion must be 1.');
  for (const key of ['scanner', 'repair']) {
    const spec = config[key];
    if (!spec || !Array.isArray(spec.command) || spec.command.length === 0 || !spec.command.every((x) => typeof x === 'string' && x)) {
      throw usageError(`Config ${key}.command must be a non-empty string array.`);
    }
    if (!['json', 'jsonl'].includes(spec.format)) throw usageError(`Config ${key}.format must be "json" or "jsonl".`);
  }
  if (config.scanner.command.join('\0') === config.repair.command.join('\0')) {
    throw usageError('Scanner and repair predicate must be different commands.');
  }
  if (!Array.isArray(config.trustedPaths) || !config.trustedPaths.every((x) => typeof x === 'string' && x && !x.startsWith('/') && !x.includes('..'))) {
    throw usageError('Config trustedPaths must contain repository-relative paths without "..".');
  }
  return config;
}

export function obviousLocalCommandPaths(config, root) {
  const found = new Set();
  for (const spec of [config.scanner, config.repair]) {
    for (const token of spec.command) {
      if (token.startsWith('-') || token.startsWith('/') || token === 'node') continue;
      const candidate = resolve(root, token);
      if (candidate.startsWith(`${resolve(root)}/`)) found.add(token.replace(/^\.\//, ''));
    }
  }
  return [...found];
}
