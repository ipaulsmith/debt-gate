# External repository field tests

This opt-in harness checks `debt-gate` against pinned snapshots of three unrelated public repositories written in JavaScript, Go, and Ruby. It is intentionally separate from `npm test`: it clones from GitHub and is evidence, not a deterministic offline unit test.

```sh
node field-tests/run.mjs --output=docs/field-trials.json
```

Each repository gets a small repository-local scanner and independent repair command. The harness then checks six states:

1. inherited debt remains allowed;
2. a new finding is blocked;
3. deleting a file does not count as a proved repair;
4. swapping one old finding for one new finding is blocked even though the count is unchanged;
5. a real replacement requires explicit acceptance and then passes;
6. accepted debt cannot return.

The imposed policies are deliberately narrow and mechanical. They demonstrate the gate, not a claim that upstream maintainers should adopt a particular migration.
