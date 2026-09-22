import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, relative, resolve } from 'node:path';

const root = process.cwd();
const policy = JSON.parse(readFileSync(join(root, '.field-test', 'policy.json'), 'utf8'));
const request = JSON.parse(readFileSync(0, 'utf8'));

for (const id of request.ids) {
  const rule = policy.rules.find((candidate) => id.startsWith(`deprecated-${candidate.id}:`));
  if (!rule) continue;
  const repoPath = normalize(id.slice(`deprecated-${rule.id}:`.length));
  const path = resolve(root, repoPath);
  if (relative(root, path).startsWith('..') || !existsSync(path)) continue;
  const contents = readFileSync(path, 'utf8');
  if (contents.includes(rule.old) || !contents.includes(rule.replacement)) continue;
  process.stdout.write(`${JSON.stringify({
    id,
    repaired: true,
    evidence: `${rule.replacement} is present and ${rule.old} is absent in ${repoPath}`,
  })}\n`);
}
