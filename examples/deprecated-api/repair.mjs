import { readFileSync } from 'node:fs';
import { executableTokens, hasCall } from './js-tokens.mjs';

const rules = new Map(
  JSON.parse(readFileSync('migration-rules.json', 'utf8')).map((rule) => [rule.id, rule]),
);
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

function provesRuntimePostcondition(rule, module) {
  if (typeof module.createSession !== 'function') return false;
  const legacyMethod = rule.legacyCallee.split('.').at(-1);
  const replacementMethod = rule.replacementCallee.split('.').at(-1);
  for (const label of ['first', 'second']) {
    const account = Object.freeze({ proof: Symbol(label) });
    const expectedId = Symbol(`expected-${label}`);
    let oldApiCalls = 0;
    const replacementArguments = [];
    let returned;
    try {
      returned = module.createSession(account, Object.freeze({
        [legacyMethod]() {
          oldApiCalls += 1;
          return Symbol(`old-${label}`);
        },
        [replacementMethod](value) {
          replacementArguments.push(value);
          return expectedId;
        },
      }));
    } catch {
      return false;
    }
    const exactShape = returned !== null &&
      typeof returned === 'object' &&
      Object.getPrototypeOf(returned) === Object.prototype &&
      Object.keys(returned).sort().join(',') === 'account,id';
    if (
      oldApiCalls !== 0 ||
      replacementArguments.length !== 1 ||
      replacementArguments[0] !== account ||
      !exactShape ||
      returned.id !== expectedId ||
      returned.account !== account
    ) return false;
  }
  return true;
}

for (const id of JSON.parse(input).ids) {
  const rule = rules.get(id);
  if (!rule) continue;
  const source = readFileSync(rule.path, 'utf8');
  if (hasCall(executableTokens(source), rule.legacyCallee)) continue;
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  if (provesRuntimePostcondition(rule, module)) {
    process.stdout.write(`${JSON.stringify({
      id,
      repaired: true,
      evidence: `createSession returns an id from ${rule.replacementCallee}(account)`,
    })}\n`);
  }
}
