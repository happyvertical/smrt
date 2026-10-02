# `smrt app` — application operator commands (#3371)

`smrt app <operation>` is the CLI home of the operations a generated SMRT app
used to ship as copied `scripts/*.mjs`. It is a port, not a redesign: state
files, JSON output, exit codes, environment variables, and messages match the
template's scripts so an app's `package.json` scripts become one-liners.

| Template script | Command |
|---|---|
| `scripts/smrt-app.mjs <op>` | `smrt app install\|setup\|recover\|start\|stop\|doctor\|open\|backup\|export\|import` |
| `scripts/smrt-prepare-migration.mjs` | `smrt app migrate` |
| `scripts/smrt-worker.mjs [task\|schedule]` | `smrt app worker [task\|schedule]` |
| `node --env-file-if-exists=.env scripts/smrt-vite.mjs <args>` | `smrt app vite <args>` (`smrt app dev …` = `vite dev …`) |
| `smrt-mcp-apps.mjs validate-if-present && …smrt-vite.mjs build` | `smrt app build [vite args]` |
| `scripts/smrt-web.mjs` | `bin/smrt-web.mjs` (spawned by `start`) |
| helper modules | `@happyvertical/smrt-cli/app` (side-effect-free subpath) |

## Source

`src/app/`: `cli.ts` (dispatch, help, error envelope), `operations.ts`,
`launchers.ts` (migrate/worker/vite), `identity.ts`, `operation-lock.ts`,
`writer-lease.ts`, `process-record.ts`, `provider-readiness.ts`,
`portability.ts`, `portability-assets.ts`, `runtime.ts` (context, runners,
profile-aware child environment). `main()` dispatches `app` before manifest or
config loading; `bin/smrt.js` imports `dist/` in-process so SIGTERM reaches
`smrt app worker`.

## Contracts that must not drift

- **State root** `<XDG_STATE_HOME|~/.local/state|~/Library/Application Support|%LOCALAPPDATA%>/.<appId>-<sha256(dataRoot)[:12]>-state`,
  mode 0700, every ancestor user/root-owned and not group/world-writable,
  app-bound empty 0600 marker `.smrt-state-<appId>`. Shared with the running
  web server (`writer.lease`), so record formats are byte-compatible.
- **Locks**: `operation.lock` (one operator op; dead owner reclaimed;
  unparsable fails closed; never unlinks a replaced lock) and `writer.lease`
  (one writer; a live op blocks a writer unless it presents that op's
  `instance`, which `start` passes as `SMRT_OPERATION_INSTANCE`). Stale
  records are removed only under an exclusive SQLite transaction on
  `<state>/.smrt-lock-reclaim.sqlite` (kernel lock, released on death), after
  re-reading that the file still holds the exact dead record
  (`stale-reclaim.ts`); a contender waits up to 2 s, then fails. Acquisition
  is still a plain `O_EXCL` create, so formats are unchanged.
- **Storage custody** belongs to `@happyvertical/smrt-app-runtime`: `setup`
  goes through `initializeLocalApplicationRuntime` with an explicit
  `prepareDatabase` that runs `smrt db:migrate`; `migrate` calls
  `prepareLocalDatabaseStorage`; `doctor`/`backup`/`export`/`import` call
  `validateLocalDatabaseStorage`, which never creates or repairs storage.
- **No runtime schema**: migrations run only through `smrt db:migrate`.
- **Output**: success JSON on stdout; failure is one stderr line
  `{schemaVersion:1,status:'error',code:'operation-failed',message,recovery,secretValuesIncluded:false}`
  plus `runtimeCode` when a `LocalRuntimeError` carries one
  (`migration_failed` + `MIGRATION_FAILED_MESSAGE`). Messages pass through
  `redactSecrets()` (secret-named env values, URL userinfo, `token=`, Bearer).
  The bootstrap token is written only to mode-0600 `onboarding.json` /
  `onboarding-launch.html`; `open` passes the launch file URL, never the token.
- **Artifacts**: backup/export/import paths go through
  `assertExternalArtifactPath` (real path of nearest existing ancestor, never
  in or over the checkout). Backup refuses an existing destination; export
  publishes via `link()` (never replaces); import requires a 0600 regular
  bundle for the same app, an exactly matching manifest schema, and an empty
  target; deployed import requires `SMRT_MAINTENANCE_MODE=true`.
- **Process identity**: `app.pid` is trusted only when the live command
  line's last two tokens are a path with basename `smrt-web.mjs` and exactly
  `--smrt-instance=<record instance>` (the template's `scripts/smrt-web.mjs`
  still matches); `stop` re-reads it immediately before SIGTERM
  (`checkOwnedProcess`: only `gone`/`mismatched` drop `app.pid`; an
  `unverifiable` query keeps it, sends nothing, and fails naming the pid). A `start`
  whose launcher never proves readiness is sent SIGTERM, then SIGKILL; only a
  confirmed exit removes `app.pid`, otherwise the record stays and the error
  names the pid.
- **Application resolution**: Vite and bare readiness-module specifiers
  resolve from the app's own `node_modules` chain (never `NODE_PATH`).
  Readiness specifiers go through Node's own ESM resolver re-parented to the
  app root (a temporary `module.registerHooks` resolve hook, because the
  `import.meta.resolve` parent argument is still flagged), so `exports`
  precedence, condition order, `null` targets, and invalid targets follow
  Node exactly; the result must stay inside the installed package. Relative
  readiness specifiers resolve against the app root.
- **Import recovery**: after the database commit the asset journal gains an
  additive `committedAt`. A leftover journal with matching table counts is
  accepted as complete only with that marker for the same bundle digest, or
  when every table's rows equal the bundle's; otherwise recovery refuses
  (`asset-recovery-target-mismatch`) and keeps the journal.
- `scripts/smrt-portability.mjs`, when an app provides it, still overrides
  the built-in export/import adapter (the documented extension point).

Tests: `src/app/__tests__/` (primitives, operations in-process, real CLI
process, and the template's portability-asset suite ported verbatim).
