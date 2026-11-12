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

The coordinator snapshots **all entry names** in the real account's macOS,
Linux and Windows state bases and any original XDG_STATE_HOME/LOCALAPPDATA.
Teardown fails if any new entry remains, including writes from children that
replace their environment. `SMRT_TEST_REAL_STATE_BASES` carries those original
bases through nested runners; never set it to hide a real base. The guard reads
user storage but never removes anything from it. Existing files and transient
writes that are removed before teardown are outside this snapshot guard.

Coverage is shared across app-runtime, CLI, app-cli, desktop, local MCP,
MCP conformance/iolaus, template runtime-profile fixtures and e2e harnesses, as
well as ordinary plugin consumers. Non-plugin repository Vitest configs opt in
explicitly. A new runner must install the lifecycle too. Optional PostgreSQL
and browser suites retain their normal prerequisites.

Regression: `src/__tests__/test-home.test.ts` runs a real nested Vitest worker,
production-mode children, cleanup and Node preload failure propagation. Escape
fixtures use disposable mock state bases; they never deliberately pollute the
owner's real directories.
