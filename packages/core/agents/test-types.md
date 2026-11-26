# Test typechecking

Core's normal `typecheck` command runs its strict production project followed
by `tsconfig.test.json`; the existing required CI typecheck task runs that same
command. The test project includes every `*.test.ts` and `*.spec.ts` under
`src/`, including optional and integration suites. These globs include future
tests automatically. Do not exclude individual failing tests.

All sibling packages in epic #2726 should extend the root
`tsconfig.package-test.json` from a package-local `tsconfig.test.json`, override
`include` and `exclude` explicitly, and add the test project to their normal
`typecheck` command after source validation. The shared project emits nothing,
loads Node and Vitest globals, and relaxes implicit-any, property-initialization,
exact-optional-property, and unchecked-index checks for fixtures. Production
projects keep their strict settings. Module resolution, missing-member, and
argument compatibility diagnostics remain enabled.

Null checks remain enabled: turning them off also changes narrowing in imported
production source, breaking discriminated unions and guards for unknown values.
Use existing fixture assertions to justify non-null assertions or narrow values
at the test boundary. Deliberately invalid inputs and intentional protected
lifecycle access require a narrowly scoped escape with its reason documented.
Use public registry APIs when they provide the same behavior.

Verify membership with `tsc -p tsconfig.test.json --listFiles`, and measure the
test project separately from the source project when reporting compiler cost.
Before claiming that drift is caught, add a temporary included test referencing
a deleted type-only import, a missing member, and an invalid argument; confirm
the normal package `typecheck` command fails, then remove the probe and rerun it.

## Core coverage in CI

The Coverage Gate does not re-run this suite (#5648). The three core shards
write `--coverage --reporter=blob` blobs, and `scripts/core-coverage-merge.mjs`
merges them, failing unless exactly n/n blobs exist and their test files equal
`vitest list --filesOnly`. Anything that changes which files that command lists
(`include`, `exclude`, a new test directory) changes what the gate requires;
the coverage `include`/`exclude` in `vitest.config.ts` stays the single source
for both the shards and the merge. See `.github/CI.md` (Coverage Gate).
