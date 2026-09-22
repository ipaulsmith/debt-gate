import { readFileSync } from 'node:fs';
import { executableTokens, hasCall } from './js-tokens.mjs';

const rules = JSON.parse(readFileSync('migration-rules.json', 'utf8'));

async function satisfiesMigration(rule, module) {
  if (typeof module.createSession !== 'function') return false;
  const legacyMethod = rule.legacyCallee.split('.').at(-1);
  const replacementMethod = rule.replacementCallee.split('.').at(-1);
  for (let trial = 0; trial < 2; trial += 1) {
    const account = Object.freeze({ marker: Symbol(`account-${trial}`) });
    const stableId = Symbol(`stable-${trial}`);
    let legacyCalls = 0;
    let replacementCalls = 0;
    let replacementArgumentIsAccount = true;
    let result;
    try {
      result = module.createSession(account, Object.freeze({
        [legacyMethod]() {
          legacyCalls += 1;
          return Symbol(`legacy-${trial}`);
        },
        [replacementMethod](value) {
          replacementCalls += 1;
          replacementArgumentIsAccount &&= value === account;
          return stableId;
        },
      }));
    } catch {
      return false;
    }
    const exactShape = result !== null &&
      typeof result === 'object' &&
      Object.getPrototypeOf(result) === Object.prototype &&
      Object.keys(result).sort().join(',') === 'account,id';
    if (
      legacyCalls !== 0 ||
      replacementCalls !== 1 ||
      !replacementArgumentIsAccount ||
      !exactShape ||
      result.id !== stableId ||
      result.account !== account
    ) return false;
  }
  return true;
}

for (const rule of rules) {
  const source = readFileSync(rule.path, 'utf8');
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const legacyCallRemains = hasCall(executableTokens(source), rule.legacyCallee);
  if (legacyCallRemains || !(await satisfiesMigration(rule, module))) {
    process.stdout.write(`${JSON.stringify({
      id: rule.id,
      path: rule.path,
      message: `Does not satisfy the migration away from ${rule.legacyCallee}`,
    })}\n`);
  }
}
