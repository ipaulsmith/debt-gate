# Field trials on external repositories

`debt-gate` 0.1.0 was run against pinned snapshots of three unrelated public repositories written in JavaScript, Go, and Ruby on 2026-09-22. The run executed 18 repository/scenario combinations and produced the expected verdict in all 18.

This is a mechanism test, not an upstream code review. Each repository received a deliberately narrow, deterministic migration policy. The count-only comparison is the rule `current findings <= baseline findings`; it is a reference model, not a run of a competing package.

## Sources and policies

| Repository | Language · type | Pinned source | Baseline findings | Field policy | Proved target |
|---|---|---|---:|---|---|
| [`node-inspector/node-inspector`](https://github.com/node-inspector/node-inspector) | JavaScript · debugger | [`79e01c0`](https://github.com/node-inspector/node-inspector/commit/79e01c049286374f86dd560742a614019c02402f) | 1 | `util.isArray(` → `Array.isArray(` | `lib/config.js` |
| [`codeclysm/extract`](https://github.com/codeclysm/extract) | Go · archive library | [`9d5343d`](https://github.com/codeclysm/extract/commit/9d5343d9116fe95ef462fd00e5837786e4c9d8d5) | 1 | `ioutil.ReadAll(` → `io.ReadAll(` | `extractor.go` |
| [`ddollar/foreman`](https://github.com/ddollar/foreman) | Ruby · process manager | [`5b815c5`](https://github.com/ddollar/foreman/commit/5b815c5d8077511664a712aca90b070229ca6413) | 4 | `File.exists?(` → `File.exist?(` | `lib/foreman/export/base.rb` |

The scanner assigns one stable ID per policy and source path. The independent repair command proves a disappearance only when the original pattern is absent and the declared replacement is present in the same source file. Deleting the file therefore cannot manufacture proof.

## Results

| Scenario | Count-only reference | `debt-gate` expected | node-inspector | extract | Foreman |
|---|---|---|:---:|:---:|:---:|
| Existing debt unchanged | allow | allow | pass | pass | pass |
| New finding added | block | block | pass | pass | pass |
| Affected file deleted | allow | block without proof | pass | pass | pass |
| One old ID replaced by one new ID | allow | block new ID | pass | pass | pass |
| Declared replacement made | allow | require `accept`, then allow | pass | pass | pass |
| Accepted debt reintroduced | block | block returned ID | pass | pass | pass |

The two differentiating cases are deletion and the same-count swap. A numeric ceiling sees `4 → 3` or `4 → 4` and allows both. `debt-gate` remembers which IDs existed and asks why an old one disappeared, so both branches fail.

## Reproduce

The harness performs network clones and is intentionally separate from the offline unit suite:

```sh
node field-tests/run.mjs --output=docs/field-trials.json
```

It creates clean one-commit snapshots in temporary directories, commits the field policy and baseline, runs each scenario on an isolated branch, and deletes the workspaces afterward. Add `--keep` to retain them for inspection.

Raw output: [`docs/field-trials.json`](field-trials.json).
