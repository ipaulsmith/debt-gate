import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const policy = JSON.parse(readFileSync(join(root, '.field-test', 'policy.json'), 'utf8'));
const ignored = new Set(['.debt-gate', '.field-test', '.git', 'node_modules']);
const extensions = new Set(policy.extensions);

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.isFile() && [...extensions].some((extension) => entry.name.endsWith(extension))) yield path;
  }
}

for (const path of sourceFiles(root)) {
  const contents = readFileSync(path, 'utf8');
  const repoPath = relative(root, path).replaceAll('\\', '/');
  for (const rule of policy.rules) {
    if (!contents.includes(rule.old)) continue;
    process.stdout.write(`${JSON.stringify({
      id: `deprecated-${rule.id}:${repoPath}`,
      path: repoPath,
      message: rule.message,
    })}\n`);
  }
}
