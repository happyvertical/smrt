# SMRT desktop shell (Tauri 2 supervisor)

Reusable Tauri 2 shell that supervises one stock Node 26 sidecar, an SMRT
`adapter-node` app, and shows it in a window. This is the Rust supervisor slice
of epic #4663 (issue #4784). It is a Cargo crate, not an npm package: the
parent package's `files` whitelist (`CLAUDE.md`, `dist`, `AGENTS.md`,
`examples`) keeps `shell/` out of the published tarball.

The behaviour reference is the Electron `ingestor-desktop` shell in ergot.io.
Its behaviour was reimplemented, not its code, and its habit of passing a
signing secret in a URL query is deliberately not carried over.

## What it does

1. Reads `sidecar-manifest.json` from the bundled resource directory (v1
   contract, see `../README.md`) and parses it strictly (`src/manifest.rs`).
2. Picks a free loopback port and starts the `externalBin` sidecar through
   `tauri-plugin-shell` (`Command::sidecar`) with:
   - working directory = the resource directory (the packaged app root),
     separate from the data directory;
   - a cleared environment rebuilt from the parent environment, then the
     manifest `env`, then the supervisor values, which always win:
     `HOST=127.0.0.1`, `PORT=<port>`, `ORIGIN=http://127.0.0.1:<port>`,
     `SMRT_DATA_DIR=<app_local_data_dir>/<dataDirectory>` (machine-local, never the
     roaming `app_data_dir`; assumed decision D7, see the parent README).
     Inherited names that collide case-insensitively with a reserved or
     manifest name are dropped (`Port`, `host`).
3. Polls `healthRoute` on exactly that origin (`src/health.rs`). Only after a
   2xx, a confirmation window with the child still alive, and a second 2xx
   does the window navigate to the origin and show (see Bind-release race).
4. Keeps the sidecar alive: unexpected exits restart with bounded backoff.
5. Stops it on quit: SIGTERM, bounded wait, SIGKILL, wait for exit.

### Phases

`Starting -> Ready | Restarting(backoff) | Failed(message) -> Stopped`

`Failed` is terminal until the tray's **Restart** item (`Supervisor::retry`)
grants a fresh budget. The tray status line mirrors the phase and shows the
failure text, for example `Unavailable: another process holds the data
directory writer lease or operation lock; gave up after 5 restarts`.

## Behaviour checklist (mapped to ergot `ingestor-desktop/src/main.ts`)

| Ergot behaviour | Here |
| --- | --- |
| `requestSingleInstanceLock`, `second-instance` shows the window | `tauri-plugin-single-instance`, registered first; the second launch focuses the window and exits |
| Tray with Open / Quit and a disabled status line; startup error text in the menu | Status line, **Open**, **Restart** (enabled only in `Failed`), **Quit**; tooltip repeats the status |
| Window created only after the runtime is reachable | Window is created hidden; navigated and shown on the first `Ready` only (restarts never re-raise a hidden window) |
| Close hides, `quitting` flag lets quit through | `CloseRequested` is prevented and hides the window unless quitting |
| `will-quit` stops the runtime before exiting | `RunEvent::ExitRequested{None}` (Cmd+Q) and the tray Quit run the same shutdown, then `exit(0)`; `RunEvent::Exit` is a safety net |
| Child stop: SIGTERM then SIGKILL after 5 s | `shutdown.rs`: graceful 10 s, forced kill, wait for exit; configurable |
| Append-only log, failures never break the tray | `log.rs`, under `<app_local_data_dir>/.desktop-shell/supervisor.log`, 512 KiB cap plus one `.1` file, never panics |
| `uncaughtException` logged | Supervisor thread panics kill the sidecar and surface `Failed`; a main-thread panic hook kills the sidecar |
| Health wait accepted any status below 500 and followed redirects | Only 2xx is healthy; any 3xx fails immediately and is never followed |
| Fixed ports | Ephemeral loopback port per launch, preferring the previous port on restart |
| Signing secret in URL query | Not carried over; owner handoff is a later slice |
| No crash recovery | Bounded exponential backoff with a retry cap |

Also: SIGTERM, SIGINT and SIGHUP (unix) are turned into the same orderly quit
(`signals.rs`), so `kill`, logout or a service stop does not orphan the sidecar.

## Crash recovery and the writer lease

The runtime inside the sidecar owns the single-writer lease (`writer.lease`)
and the operation lock (`operation.lock`) described in
`packages/app-runtime/README.md`. The supervisor does **not** implement,
inspect, repair or delete either file. Specifically:

- A restarted sidecar acquires the lease itself. The runtime reclaims a lease
  whose recorded owner process no longer exists (it checks the PID, under its
  own reclaim mutex), so a crash needs no help from the shell.
- Recovery never launches a replacement until the previous child has exited.
  The supervisor is one sequential thread, and if the stop escalation cannot
  confirm an exit it goes to `Failed` and refuses to launch anything
  (`Retry` is ignored in that state). With the single-instance plugin this is
  the guarantee that at most one sidecar writes a data directory (smrt#3379:
  two SQLite writers do not see each other's writes).
- If a new child exits because a **live** process still holds the lease or lock
  (an old sidecar still winding down, an operator command), the startup
  output contains the runtime's `Another application writer is active`,
  `Another application operation is active` or `reclaiming a stale
  application lock` message. That is classified `LeaseHeld`: a retryable
  startup failure that follows the normal backoff and says so in the tray.
  Matching is on those documented runtime phrases; keep
  `LEASE_PHRASES` in `src/supervisor.rs` aligned if they change.
- The child's output is used for classification only. It stays in memory and
  is not written to the log (a runtime may print one-time secrets). Set
  `SMRT_DESKTOP_LOG_SIDECAR_OUTPUT=1` to log a truncated tail of it when a start
  fails while debugging.

## Bind-release race

The shell must tell the sidecar its port, so it binds `127.0.0.1:0`, reads the
port and releases the socket before launching (`src/port.rs`). Another process
can take the port in that window. This is handled, not prevented:

- A child that dies with `EADDRINUSE` / `address already in use` before it is
  healthy triggers an immediate relaunch on a **new** port (up to 5 times per
  streak). This does not consume the crash-restart budget.
- A process that grabbed the port can answer the first health probe while the
  child is still starting and about to die of `EADDRINUSE`. So a 2xx alone is
  not trusted: the sidecar is ready only after the first 2xx, a confirmation
  window (`SupervisorConfig::confirm_window`, 1s by default) during which the
  child must stay alive, a second 2xx, and a final liveness check. A child that
  exits inside the window is classified like any other failed start (address
  in use relaunches on a **new** port without spending the crash budget).
  `Ready` is not published, and the window does not navigate or show, before
  confirmation passes.
- Residual limits: the window is a time bound, not a proof. A child that takes
  longer than the window to fail its bind, a squatter that takes the port after
  confirmation, or a child that keeps running without listening while a
  squatter answers are not detected. A stock Node server fails `listen()`
  within milliseconds, so the default leaves a wide margin. Startup becomes
  ready roughly one window later than the first 2xx.
- On a restart after a crash the previous port is reused when it is still
  free, which keeps the origin (and origin-scoped web storage) stable.

## Modules

| File | Role |
| --- | --- |
| `manifest.rs` | Strict v1 parser: closed schema, duplicate keys rejected (custom serde visitors), portable-path / route / env grammars. Values are never echoed in errors. |
| `env.rs` | Child environment and reserved-value precedence; data directory resolution. |
| `port.rs` | Port reservation, restart preference, address-in-use detection. |
| `health.rs` | Loopback-only HTTP probe. `ureq` 3 with default features off: blocking, plain HTTP, no TLS stack, no async runtime. Redirects, environment proxies and compression are disabled; the target is a loopback `SocketAddr`, never a hostname. |
| `shutdown.rs` | Graceful -> forced stop with confirmation. Windows has no portable SIGTERM for a console-less child: the graceful step is a best-effort `taskkill` close request, then `taskkill /T /F`. |
| `process.rs` | `ManagedChild` / `Launcher` seam, exit latch, bounded output tail, signal helpers, and a `std::process` launcher used by the tests. |
| `log.rs` | Size-capped append-only file log; infallible API. |
| `supervisor.rs` | State machine, restart budget, failure classification, panic-path kill switch. |
| `signals.rs` | Unix termination signals as a quit request. |
| `app.rs` | Thin Tauri glue (tray, window, plugins, shell-plugin launcher). |

## Building a bundle

The crate builds and tests without a Node binary. The base `tauri.conf.json`
therefore declares no `externalBin` (tauri-build refuses to build when a
declared binary for the target triple is missing) and no resources. The
consuming app's packaging step supplies them through a config overlay.
`smrt desktop bundle` (`@happyvertical/smrt-desktop/bundler`) writes the
sidecar binary, the resources and a `tauri.bundle.json` fragment for exactly
this; merge it with the product identity and icons:

```json
{
  "productName": "My App",
  "identifier": "com.example.my-app",
  "bundle": {
    "icon": ["icons/icon.icns", "icons/icon.ico", "icons/icon.png"],
    "externalBin": ["binaries/my-app-node"],
    "resources": { "resources/": "./" }
  }
}
```

used as `tauri build --config overlay.json --target <triple>`, where the
bundle was made for the same `<triple>` (tauri-build wants
`binaries/my-app-node-<triple>[.exe]`). The manifest `executable` is the
product-scoped logical basename (`my-app-node`, never a bare `node`: Tauri
installs sidecars next to the main binary, `/usr/bin` for `.deb` and `.rpm`);
Tauri resolves it next to the app binary with the target suffix. `args` are
relative to the resource directory, which is the child's working directory
(for example `["app/build/index.js"]`). The icons in `icons/` are placeholders.

## Tests

From this directory:

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

- Unit tests live beside the modules and cover most of the weight.
- `tests/supervisor.rs` drives the real supervisor against a fake sidecar
  (`tests/fixtures/fake-sidecar.mjs`, plain `node:http`). It proves env
  precedence and cwd, probe-on-origin-only, redirecting health routes, the
  SIGTERM-ignoring child being SIGKILLed after the bound, address-in-use and
  lease-held recovery, crash restarts with the same origin and no overlapping
  sidecars, the restart cap, shutdown during backoff, and an unwritable log
  directory.
- `tests/emergency.rs` covers the panic-path kill switch in its own process
  because that switch is process-global.
- Node-dependent tests print `skipping: node is not on PATH` and pass when
  `node` is absent. No test starts containers or leaves loopback.
- `.github/workflows/desktop-shell.yml` runs the same three commands on Ubuntu
  for changes under `packages/smrt-desktop/shell/` only. It is path filtered
  and is not a required check.

Manual smoke run: in a debug build the resource directory is the executable directory, so put a
`sidecar-manifest.json`, the sidecar script and a symlink named like the
manifest's `executable` (pointing at a `node` binary) in
`target/debug/` and run `target/debug/smrt-desktop-shell`. The log is at
`<app_local_data_dir>/.desktop-shell/supervisor.log`.

## Deferred to later slices (clean seams only)

- **Owner claim and signed-in webview.** `ownerClaimRoute` is parsed and
  validated but unused. The seam is `publish()` in `app.rs`: the URL passed to
  `window.navigate` is the only place the claim handoff would change, and it
  must not put secrets in the URL query.
- **Native credential custody.** Nothing here stores or reads credentials.
- **Rendezvous / discovery interface.** The origin is private to the process.
- **Bundling the Node binary**, signing, notarisation and releases.
- Runtime health monitoring after `Ready` (a hung but alive sidecar is not
  detected; only exits are), an in-window status page for `Restarting` /
  `Failed` (the tray carries the state; the webview shows the browser's error
  page for the dead origin until the next `Ready`), and hiding the macOS Dock
  icon.

## Known risks

- If the shell is killed with SIGKILL (or crashes without unwinding) the
  sidecar is orphaned and keeps the lease. The next launch then sees
  `LeaseHeld`, backs off, and ends in `Failed` rather than running two writers;
  quit the orphan to recover. A Linux `PR_SET_PDEATHSIG` or sidecar-side
  parent watch would close this and needs sidecar cooperation.
- The graceful stop timeout (10 s) must cover the runtime's own shutdown; the
  force-kill after it can interrupt a long SQLite checkpoint.
- CI covers Linux only. The Windows code paths (`taskkill` stop, job-object
  kill via the shell plugin) were not compiled or run, and the GUI paths were
  only exercised on macOS (tray, window and quit were not inspected visually).
