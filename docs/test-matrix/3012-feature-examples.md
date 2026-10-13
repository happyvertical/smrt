# Feature documentation and constructor compatibility (#3012)

Risk: standard. Examples use the existing class-declared feature API. The
constructor type derives from the public `SmrtObject` signature; resolution,
storage, and authorization behavior are unchanged.

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Executor / transaction | Runtime / dialect | External edge | Test level | Validation command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Quick start calls supported instance APIs and canonical keys | Application copies the README | Sync the decorated Invoice constructor; resolve by constructor and qualified key; tenant override enables the feature | Undeclared feature throws and another tenant retains its default | Application startup and authenticated tenant context | Real isolated test database; existing sync/settings APIs | Node / SQLite; no SQL implementation change | Public package entry and registry | Integration | `pnpm --filter @happyvertical/smrt-features test` |
| Ordinary SmrtObject constructors satisfy the public target type | Strict TypeScript application passes Invoice to syncDefinitions | README fixture compiles without casts | Original unknown[] constructor signature rejects Invoice with TS2322 | Application developer | N/A: compile only | TypeScript; SQL N/A | Public constructor parameter type | Compile regression and packed exports | `pnpm --filter @happyvertical/smrt-features typecheck`; `pnpm --filter @happyvertical/smrt-features verify:pack` |

Worker evidence is captured in
`/home/will/Work/tmp/smrt-3719-evidence/docs-jobs/`: the original constructor
type fails in `features-constructor-base.log`; the corrected typecheck, full
72-test package suite, build, and packed-export checks pass. Combined release
checks are captured by the coordinator before review. Hierarchy and existing
negative authorization cases remain in the full package suite. No migrations,
provider calls, retry mechanism, or transaction boundary change, so new tests
for those surfaces are N/A.
