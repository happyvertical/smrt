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
| `node --env-file-if-exists=.env scripts/smrt-vite.mjs <args>` | `smrt app vite <args>` (`smrt app dev …` = `vite dev …` plus `--host 127.0.0.1` / `--port $PORT` unless given: `devServerArguments`) |
| `smrt-mcp-apps.mjs validate-if-present && …smrt-vite.mjs build` | `smrt app build [vite args]` |
| `scripts/smrt-web.mjs` | `bin/smrt-web.mjs` (spawned by `start`) |
| — (new, #3413) | `smrt app token [create] --scopes … [--expires 30d] [--label …]`, `token list`, `token revoke <id>` |
| — (new, #4804) | `smrt app backup --encrypted --target <name>`, `backups targets [add\|remove]`, `backups list`, `backups prune` |
| — (new, #4704) | `smrt app installation [status]`, `restore --origin-retired`, `reseed --confirm-destroy-seed`, `recover-seed <file> [--unverified]`, `retire` |
| — (new, #4805) | `smrt app restore-latest [--discard-local] [--replace-installation] [--origin-retired] [--recover]` |
| helper modules | `@happyvertical/smrt-cli/app` (side-effect-free subpath) |

## Source

`src/app/`: `cli.ts` (dispatch, help, error envelope), `operations.ts`,
`launchers.ts` (migrate/worker/vite), `identity.ts` (artifact-path custody;
re-exports identity and state root), `process-record.ts`, `portability.ts`,
`portability-assets.ts`, `runtime.ts` (context, runners, profile-aware child
environment). Application ID, configuration fingerprint, state root,
operation lock, writer lease, stale reclaim, and provider readiness are
`@happyvertical/smrt-app-runtime`'s (the web process takes the same lease
without depending on the CLI); `./app` re-exports them unchanged. `main()` dispatches `app` before manifest or
config loading; `bin/smrt.js` imports `dist/` in-process so SIGTERM reaches
`smrt app worker`.

## Contracts that must not drift

- **Profile**: `resolveConfiguredRuntime` and app-runtime's SvelteKit entry
  both call smrt-config's `resolveEffectiveApplicationRuntime(loaded)` (#3446),
  so operator and web process agree: no `runtime` block (or no config) is
  `local`; any present value other than `undefined` (including
  `null`/`false`/`0`/`''`) is validated and fails closed when it is not a
  valid block.
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
  (app-runtime `stale-reclaim.ts`); a contender waits up to 2 s, then fails. Acquisition
  is still a plain `O_EXCL` create, so formats are unchanged.
- **Storage custody** belongs to `@happyvertical/smrt-app-runtime`: `setup`
  goes through `initializeLocalApplicationRuntime` with an explicit
  `prepareDatabase` that runs `smrt db:migrate`; `migrate` calls
  `prepareLocalDatabaseStorage`; `doctor`/`backup`/`export`/`import` call
  `validateLocalDatabaseStorage`, which never creates or repairs storage.
- **Windows local profile** (smrt#4837): `refuseWindowsLocalProfile`
  (`runtime.ts`, the `deps.platform` seam) runs first in `install`, `setup`,
  `recover`, `start`, `stop`, `open` (`runApplicationOperation`), `migrate`
  (`prepareMigration`, after usage validation) and `token`
  (`runTokenOperation`, after argument validation), and
  `refuseWindowsOperatorCopy` first in `backup`/`export`/`import`. Both resolve
  the runtime (config only) and refuse for the local profile before any state
  root, lock, lease, build or data-root access; deployed profiles pass through.
  `doctor` stays read-only and, instead of running `db:status`, reports
  `windows-local-profile-unsupported`. A new command that creates a state root
  or touches the data root must add itself to the gate and to
  `WINDOWS_LOCAL_REFUSED_OPERATIONS`.
- **No runtime schema**: migrations run only through `smrt db:migrate`.
- **Output**: success JSON on stdout; failure is one stderr line
  `{schemaVersion:1,status:'error',code:'operation-failed',message,recovery,secretValuesIncluded:false}`
  plus `runtimeCode` when a `LocalRuntimeError` carries one
  (`migration_failed` + `MIGRATION_FAILED_MESSAGE`). Messages pass through
  `redactSecrets()` (secret-named env values, URL userinfo, `token=`, Bearer;
  every span is found on the raw text and the union masked at once, so a
  literal value never splits a structural match; existing `[redacted]`
  markers are opaque, so a second pass neither corrupts nor grows text).
  `start` sends the detached web process's stdout/stderr to a fresh 0600
  `<state>/app.log` per start (removed, then created `wx`; a pipe would EPIPE
  once the CLI exits); a start that never proves readiness adds `output` (the
  last ≤ 8 KiB, redacted against the child env before the cut with
  `{ strict: true }`: no 8-character floor for env values or Bearer tokens) and `logFile`
  (`ApplicationStartError`).
  The bootstrap token is written only to mode-0600 `onboarding.json` /
  `onboarding-launch.html`; `open` passes the launch file URL, never the token. `setup`/`recover` print the one-time
  `/setup?token=` URL only to an interactive terminal (`io.operatorTerminal`,
  stderr when both stdio are TTYs), never to stdout/stderr logs or pipes. The
  web runtime deletes the files after a successful owner claim.
- **`open` port resolution** (#3857): `open` probes `/api/_runtime/health` from
  the configured `PORT` (default 5173) through the next ten ports (Vite's
  fallback range) and takes the first whose `application` equals this app's id,
  so a busy port held by another app is skipped. The printed `url` and the
  retained onboarding launch file follow that port. Output carries
  `serverRunning`: `false` when nothing answered (the configured port is kept).
  `setup`/`recover` run before a server exists, so their retained invitation
  keeps the configured port until `open` rewrites it. `smrt app <op> --help`
  prints usage for every operation except `dev`/`build`/`vite` (Vite's help)
  and `token` (its own).
- **`installation`** (`installation.ts`, local only): declares a restored move,
  an independent copy, or a recovered seed (#4704; decision in the app-runtime
  README). `status` is read-only; the rest take the operation lock and refuse
  while a writer is active. Output is secret-free JSON with explicit identity
  and token effects.
- **`restore-latest`** (`restore-latest.ts`, local only, #4805): under
  `operation.lock` and the writer lease (so no web process or second SQLite
  connection is open, smrt#3379) it settles an interrupted swap and removes
  plaintext restore leftovers, refuses pending local writes (or a live root
  with no recorded vault position) without `--discard-local` and any latest
  sequence below the location's highest seen, always keeps the replaced root
  as a `previous` sibling (the app does not yet mark writes made after the
  last publish, #4810; it is never deleted), takes the
  relay lease at the target, decrypts into a sibling candidate, checks SQLite
  integrity and the carried installation (`--replace-installation` for a
  different one), swaps under the app-runtime journal and records the new
  vault position. A location whose installation was retired (moved away, or
  migrated to the cloud, #4806) is refused before the relay is contacted, even
  with `--origin-retired`: reverse it first with `installation restore
  --origin-retired`. An unreadable custody record is refused too. Custody moves (`restoreInstallation`) only with
  `--origin-retired`; otherwise it stays pending and the app refuses to start
  until declared. `--recover` only settles a swap. Collaborators
  come from `deps.vaultRestore` (account, lease client, snapshot source from
  the relay client, and `accountTrust()`) and `deps.snapshotKeys`; without them
  it fails closed. The relay is untrusted, so the snapshot's producer and key
  generation are judged by the adopted signed head (`accountTrust()`,
  `snapshotAccountTrustFromLifecycle`): a snapshot from a revoked device, or
  sealed below the highest effective generation of a revocation, is refused
  (`revoked_device`, `generation_too_old`), and while a revocation still waits
  for its rotation (`rotation_pending`: the revoked device still holds the
  current key, so only the rotation separates it from real devices);
  snapshots published before the
  rotation that revoked a device must be re-published by a remaining device to
  be restorable. The relay lease is renewed on a timer through the download and
  decrypt (a lost lease aborts the download), and the key provider's sealing
  sequence is moved past the relay head (`advanceSealingSequence`, also on
  `up-to-date`) so the next backup is not refused as behind it; the report's
  `sealingFloor` is that sequence, `null` when the host owns no counter.
- **`token`** (`tokens.ts`, local only): parses every argument before touching
  state, opens `openLocalMcpTokenStore` (validated custody, uncached
  connection, no writer lease, so it runs beside `app:start`), and serializes
  create/revoke under `operation.lock`. Only the `issued` document carries
  the token (`secretValuesIncluded: true`); list/revoke/error output never
  does.
- **Artifacts**: backup/export/import paths go through
  `assertExternalArtifactPath` (real path of nearest existing ancestor, never
  in or over the checkout). Backup refuses an existing destination; export
  publishes via `link()` (never replaces); import requires a 0600 regular
  bundle for the same app, an exactly matching manifest schema, and an empty
  target; deployed import requires `SMRT_MAINTENANCE_MODE=true`.
  Local relative asset locators resolve against the approved asset root during
  export and stay relative after import. Legacy file URLs import as file URLs.
- **Encrypted snapshots** (#4797): `backup --encrypted` streams the data root
  and `export --encrypted` the logical bundle into one HVSF v1 file (0600,
  published with `link()`, only ciphertext on disk). Keys come only from the
  injected `deps.snapshotKeys` provider; without one the flag fails closed.
  Plaintext stays the default, so `backup`, `export` and `import` refuse every
  other argument that starts with `-` (`--encrypt` is not `--encrypted`), before
  any lock or write; `--` makes a dash-leading path expressible. Format, limits
  and restore primitives: [encrypted-snapshots.md](encrypted-snapshots.md).
- **Backup targets** (#4804, `backup-command.ts`, `backup-target-*.ts`):
  `backup --encrypted --target <name>` stores the snapshot on a configured
  local directory, the user's Google Drive, or the vault relay; `backups
  targets|list|prune` manage them. Config holds no secrets; credentials, the
  device signer and the entitlement arrive through
  `AppCommandDependencies.backup` and fail closed. Contract, scope rules and
  threat table: [backup-targets.md](backup-targets.md).
- **Cloud migration** (#4806, `cloud-migration.ts`, library only; hosted
  routes and `smrt app cloud` commands are follow-ups): built on a
  `smrt-cloud-link-v1` link (app-runtime README). `planCloudMigration`
  checks and remaps a local bundle before anything is written. The per-user
  target (planned with `perUser` identities, linked after import) is a
  byte-preserving `importApplication` into an empty database; the shared
  target goes through hosted `sync/apply` (`runSharedCloudMigration`) and
  refuses foreign-tenant, global, tenantless, colliding, embedded-identity and
  `file:`/`asset-local:` values anywhere, and stops on any
  `conflict`/`rejected`. The journal is bound to bundle digest, origin, link,
  tenant and batch contents (resume with the same batch size).
  `beginCloudMigration` checks custody and the link, then retires the
  location before export (recording the custody epoch). The per-user link is
  made after the import, when the location is already retired, so it is
  opened with `openMigrationCloudLinkIdentity`, which signs only the per-user
  challenge of the recorded migration. `completeCloudMigration` (async)
  verifies a fresh target export itself and needs the location still retired
  for that installation at the same custody epoch (restoring it, even before
  re-retiring, abandons the migration), a bundle exported after retirement,
  an `applied` journal (shared), acknowledged changed columns (never
  `id`/`tenant_id`) and `acknowledgedOmittedTables` naming every table the
  plan withheld for credential-like columns (`plan.skipped.omittedTables`). A
  `salt` column alone migrates; a table with a `salt` and any hash-like column
  (`hash`, `*_hash`, `digest`) is withheld, as are `pin_hash`/`key_hash`/
  `code_hash` columns. Both are assumed defaults pending the owner.
  `exportTenantBundle` selects by ID only global rows (`cloudIdentityRows`);
  `downgradeCloudBundle` refuses foreign-tenant rows and reverse-maps into a
  `local` bundle `app import` accepts.
  Composition with `restore-latest` (`restore-cloud-composition.test.ts`):
  a restored location is not in custody until the operator declares the move,
  so a migration refuses to start there; a location the migration retired is
  refused by `restore-latest` (even with `--origin-retired`) until `installation
  restore --origin-retired` reverses the retirement.
- **Process identity**: `app.pid` is trusted only when the live command
  line's last two tokens are a path with basename `smrt-web.mjs` and exactly
  `--smrt-instance=<record instance>` (an app started by the template's former
  `scripts/smrt-web.mjs` still matches); `stop` re-reads it immediately before SIGTERM
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
process, and the template's portability-asset suite ported verbatim); lock,
lease, state-custody, and readiness cases (including review findings R1, R3,
T2) live in app-runtime's `src/operator-primitives.test.ts`.

`smrt app migrate --relax-columns` explicitly forwards constraint relaxation to
`db:migrate` under the same operation lock and writer-lease refusal. Without the
flag, live constraints remain protected. SQLite ordinary inline NOT NULL
relaxation uses the tracker-owned atomic rebuild; see the core schema-paths
contract for unsupported shapes and FK validation. Unknown migrate options fail
before touching local custody or starting the child command.
