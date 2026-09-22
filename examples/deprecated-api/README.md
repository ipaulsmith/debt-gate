# Deprecated API example

Copy this directory to a temporary Git repository, then run:

```sh
npx debt-gate init \
  --scanner scanner.mjs \
  --repair repair.mjs \
  --trust migration-rules.json \
  --trust js-tokens.mjs
git add . && git commit -m "Record existing migration debt"
git switch -c migrate-session
```

The initial `identity.randomSessionId()` call is grandfathered. Replace it with
`identity.stableAccountId(account)`, then:

```sh
npx debt-gate check --base main
# Fails safely: the improvement has proof but is not accepted yet.

npx debt-gate accept --base main
git add src/session.js .debt-gate/baseline.json
git commit -m "Use stable session identity"
```

The scanner recognizes executable legacy calls, including calls inside template
expressions, while ignoring comments and strings. It also executes this bounded example
with opaque inputs and spies to check its contract. The separate repair predicate runs
two deterministic trials and emits proof only when `stableAccountId` is invoked exactly
once with the supplied account, `randomSessionId` is never invoked, and the returned
object contains exactly the expected stable ID and account. Dead text, misleading
syntax, deleting the function, or preserving the old behavior cannot retire the debt.

Putting `identity.randomSessionId()` back now fails because `session:random-id` is no
longer inside the branch's effective ceiling.
