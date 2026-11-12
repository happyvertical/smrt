# Test home and state isolation

`smrtVitestPlugin()` prepends `test-home.global-setup` to root and inline-project
`globalSetup`. It installs HOME, USERPROFILE, XDG state/data/config/cache homes,
LOCALAPPDATA and APPDATA
before test modules and workers start. Production-mode children inherit them,
including operator CLIs, launchers and sidecars. Do not drop these variables
when constructing a child environment. Do not use `userInfo().homedir` for
writable fixtures; `homedir()` reads the isolated HOME.

The home is a unique directory in this package's `node_modules/.cache/test-homes`,
outside `/tmp` so custody tests that distrust `/tmp` still exercise their original
ancestry checks. Teardown restores the caller's environment and recursively
removes only that owned directory. An exit hook is a fallback for normal process
exit; SIGKILL cannot run JavaScript cleanup.

`@happyvertical/smrt-vitest/test-home/global-setup` works in Vitest configs that
cannot use the manifest plugin, and in Playwright. `installTestHome()` from
`./test-home` provides the same lifecycle for another runner; call its returned
teardown after all children stop. The repository's Node script tests preload
`src/test-home-register.ts` under Node 26, so they work before building packages.

The coordinator records the replaced account/home platform bases and original
XDG_STATE_HOME, XDG_DATA_HOME and LOCALAPPDATA in `SMRT_FORBIDDEN_STATE_BASES`, a
JSON array of paths inherited unchanged by nested runners. The app-runtime state
resolver and default local-data custody refuse a matching base before creating
storage. Comparison uses existing platform path identity rules (case folding on
macOS/Windows and normalized separators). This opt-in refusal is inert when the
variable is absent; malformed configuration fails closed. Explicit resolver
`environment` options cannot hide the process-tree guard.

Use `testHomeEnvironment()` from `./test-home` to copy only the isolation settings
into a clean child environment, including official SDK stdio transports (whose
default inheritance is restricted). Keep test-owned HOME overrides within their
own lifecycle and supply the matching XDG/Windows homes. Native inference's
credential allow-list intentionally strips SMRT_*; the cookbook's fake CLI
restores the guard in its fixture prelude before spawning MCP; allowed home
settings already pass through the service.

There is no real-directory snapshot or cross-process filesystem comparison.
Other sessions' writes cannot fail this run. The guard covers runtime path
resolution, including production-mode descendants; arbitrary filesystem writes
that bypass these APIs are outside its scope. Never remove the guard from a
child that can resolve local application paths.

Coverage is shared across app-runtime, CLI, app-cli, desktop, local MCP,
MCP conformance/iolaus, template runtime-profile fixtures and e2e harnesses, as
well as ordinary plugin consumers. Non-plugin repository Vitest configs opt in
explicitly. A new runner must install the lifecycle too. Optional PostgreSQL
and browser suites retain their normal prerequisites.

Regression: `src/__tests__/test-home.test.ts` runs a real nested Vitest worker,
production-mode children and cleanup. Runtime operator regressions cover refusal,
platform rules, inherited children and unset behavior. Escape
fixtures use disposable mock state bases; they never deliberately pollute the
owner's real directories.
