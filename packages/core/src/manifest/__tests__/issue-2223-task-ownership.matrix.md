# Issue #2768 test design

| Behavior / invariant | Trigger and executor | Positive / failure evidence | Level / command |
| --- | --- | --- | --- |
| Test-manifest generation does not affect the production build hash | Generate a test manifest in a copied core package under a temporary workspace, then ask Turbo for the copied package's dry build hash | The cold and generated hashes match; the base test invoked `pnpm --dir <live core> run build`, so safely reproducing its mutation in a concurrent run is infeasible | Integration: `pnpm --filter @happyvertical/smrt-core exec vitest run src/manifest/__tests__/issue-2223-task-ownership.test.ts` |
| The real core build emits no test stub | Run the copied package's real `generate:test` and `build` scripts | The copied `dist/manifest/test-manifest-stub.*` files are absent | Same focused integration test |
| The live workspace is not mutated | Snapshot generated test artifacts, `.smrt/manifest.json`, and all live core `dist` file contents before the isolated run | The snapshots match afterward | Same focused integration test |
| Fixture cleanup survives an assertion failure | Throw an assertion inside the isolated-fixture callback | The temporary fixture directory no longer exists | Same focused integration test |

No actor, transaction, dialect, or external-contract edge applies: this is a
local filesystem and build-task ownership regression. The actor is the test
runner, the executor is the local Node filesystem and `pnpm` child process,
and the supported runtime is the repository's Node range (`>=24.18.0`). No
database transaction, SQL dialect, or external contract is involved.
