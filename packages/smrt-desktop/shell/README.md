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

## Release pipeline

`.github/workflows/desktop-release.yml` (epic #4663 item 5, issue #4836) holds
two paths that share a file and nothing else. `desktop-shell.yml` keeps the fast
Rust checks (fmt, clippy, tests on Ubuntu); this workflow builds.

| | PR and verification builds | Release |
| --- | --- | --- |
| Trigger | pull request or push to main that changes `packages/smrt-desktop/**` or the workflow; manual dispatch | manual dispatch from main with `release` set; nothing else reaches it |
| Signing | none, unsigned | Apple Developer ID signing and notarization, Tauri updater signature |
| Token and secrets | `contents: read`, no secrets | secrets come from the `desktop-release` environment and reach only the preflight step and the build step; `contents: write` only in the final publish job |
| Matrix | macOS arm64 (`macos-14`), macOS x64 (`macos-15-intel`), Windows, Linux | the same four targets |
| Product | none: the shell is compiled and linked with `tauri build --no-bundle` | a bundle made by `smrt desktop bundle` for each target |
| Output | pull requests upload nothing; main and dispatch keep the unsigned shell binary for 3 days | one publish step, after every target is built and verified, to the rolling `desktop-latest` prerelease plus `latest.json` (the updater feed) |

Pull request builds are a compile and link smoke, not a product build. There is
no product in this repository, so no `externalBin`, resources or installer are
produced and nothing is faked. The policy (path filter, uploads only from main
or dispatch, short retention) follows ergot's `capture-desktop-artifacts.yml`.
`tauri-action` and the other actions are pinned by commit SHA; the Tauri CLI is
pinned to an exact version (`TAURI_CLI_VERSION`).

### Fail-closed preflight

The release path starts with `scripts/release-preflight.mjs` (tested by
`scripts/release-preflight.test.mjs`, run by the verification build on Linux).
It refuses, names what is missing and never prints a value, unless all of these
exist:

1. The run is on main.
2. The Apple secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
   `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID`.
3. `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. A real updater public key in `tauri.conf.json` (`plugins.updater.pubkey`).
   The committed value is an obviously invalid placeholder; the check requires
   the base64 minisign public key format Tauri generates.
5. The `product_dir` and `bridge_path` dispatch inputs, as safe repo-relative
   paths.

Each target then checks its bundle again after the artifact hop, before any
signing, and the checks are made in the job that holds the signing key against
the trusted checkout (main), not against what the bundle says about itself:

- `tauri.bundle.json` must be exactly `bundle.externalBin` (one entry, the
  product-scoped `binaries/<productId>-node`) and `bundle.resources`
  (`{"resources/": "./"}`) and nothing else, at any level. The overlay handed
  to the signing build is built from an allowlist (that sidecar, that resource
  directory, `createUpdaterArtifacts: true`), so a `signCommand`, an NSIS
  template, extra `files`, entitlements or any other key in the bundle cannot
  reach it. The overlay's product name and version are also validated (safe
  characters, semantic version).
- The bundle never travels as an archive. The bundle job uploads the bundle
  directory itself (`upload-artifact` stores file contents, follows a symlink
  and stores the target's bytes as a regular file, and drops permissions); the
  signing job downloads it into an empty directory under `$RUNNER_TEMP`, never
  the checkout. There is no `tar` member that could be written through an
  earlier symlink member over trusted files (`tauri.conf.json`, the preflight
  script, the pin table, `~/.cargo/config.toml`). Because permissions do not
  survive, staging marks every file under `binaries/` executable.
- The bundle root is listed with `lstat` before anything in it is read. It may
  hold only `binaries/` and `resources/` (real directories) and
  `tauri.bundle.json`, `bundle-report.json` and `bundle-files.sha256` (regular
  files); a symlink, an unexpected entry or a root that is itself a symlink
  fails.
- `binaries/` and `resources/` are walked with `lstat`. Any symlink or other
  non-regular file fails; so does any file the digest list
  (`bundle-files.sha256`) does not name and any listed file that is missing or
  has a different digest. Only the files that passed are copied next to
  `tauri.conf.json` (each is read once, hashed again and written without
  overwrite); there is no recursive copy of the downloaded tree.
- The Node pin is compared with the committed table,
  `packages/smrt-desktop/src/bundler/node-pins.ts`, read from the trusted
  checkout with a small strict parser. That record, not the report, must say
  the release is `gpg-verified` (with signer fingerprints), the report's Node
  version and dist file must exist in the table for this target, and the
  report's archive digest must equal the committed digest. The sidecar file's
  digest must equal the `binarySha256` the report records.
- The target matches and the product identity is not empty or a placeholder.

What the Node check does and does not prove. For **Windows** the committed pin
is the digest of `node.exe` itself, so the sidecar is proved byte-for-byte to
be the pinned, gpg-verified binary. For **macOS and Linux** the table pins the
`.tar.gz` archive; the sidecar is the `bin/node` member the untrusted bundle
job extracted from it, and the signing job does not re-extract anything. There
the check proves that the report claims the committed archive and that the
sidecar matches the report's own `binarySha256`, but **not** that the sidecar
is the binary inside that archive; a bundle job that swapped the binary and
kept the genuine archive digest would pass. (The unit test
`does not prove an extracted tar.gz binary` records this limit.) Closing it
needs the extracted binary's digest pinned too (a change to
`update-node-pins.mjs` and the table) or the signing job fetching and
extracting the pinned archive itself. The bundle job's own
`--require-verified-pins` run is not a defence against a compromised bundle
job, only a fast failure.

The committed `productName` and `identifier` are placeholders on purpose: the
release identity comes only from the bundle (`bundleId`, `displayName`,
`productVersion` in `bundle-report.json`), written into the allowlisted
`tauri.release.json` overlay. A build with any of this missing stops before it
holds a signing key.

The product code (the app, its dependencies, `pnpm install`, `smrt app build`
and the bundler) runs only in the secretless bundle job on a GitHub-hosted
runner. That job has no environment, installs with no pnpm cache and no Turbo
cache shim (it saves nothing a trusted run could restore), and the signing job
restores no cargo cache either: it builds cold with the pinned Tauri toolchain.

macOS signing runs on the runner named by the repository (or organization)
variable `DESKTOP_MACOS_SIGNING_RUNNER` (a runner label, or a JSON array of
labels for a self-hosted runner), default `macos-14`. It is a repository-level
variable because the runner is chosen before the `desktop-release` environment
applies; see Owner setup, step 5. Both macOS targets build there; the x64
target is cross-compiled. Nothing assumes a self-hosted runner may be used.

### All or nothing publishing

The four signing legs publish nothing. Each builds, signs, and (macOS) runs
`codesign --verify --deep --strict` and `xcrun stapler validate` on its `.app`,
then stages its installer, updater archive and signature under safe names
(`scripts/release-feed.mjs leg`) and uploads them as a one-day workflow
artifact. `fail-fast` stops the other legs when one fails. The
`release-publish` job `needs` every leg, so it runs only when all four
succeeded; it assembles one `latest.json` and the asset set
(`release-feed.mjs feed`: refuses a missing leg, a version mismatch, a symlink
or a missing signature), uploads the new assets to `desktop-latest` first and
`latest.json` last, so the feed never names an asset that is not there yet.
Linux ships a `.deb` only; the Tauri updater cannot update a `.deb`, so the
feed has no Linux entry (AppImage is not built in v1). Assets are named
`<product>_<version>_<target>.<ext>` so a rebuild of the same version replaces
the same names and a new version never overwrites the previous feed's
targets.

### Owner setup (once, before the first release)

The release path trusts its location. A workflow file lives on whatever branch
a person with write access dispatches it from, and a same-repository pull
request that edits it receives repository secrets, so the main-only check
inside the file is not a control on its own. The gate is a GitHub environment.
Do these in order:

1. **Create the `desktop-release` environment first**, before storing any
   secret (Settings, Environments). A workflow that names an environment that
   does not exist creates it silently and **unprotected**; the preflight then
   fails closed on the missing secrets, which is the backstop, not the
   control.
2. Under **Deployment branches and tags**, restrict it to the `main` branch
   only. A dispatch from any other branch, or a pull request, then cannot read
   anything in it.
3. Add **required reviewers** (and, if wanted, prevent self-review). Expect an
   approval prompt for the preflight, one for the signing legs and one for the
   publish job.
4. Store **all eight secrets in the environment, not as repository secrets**:
   `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
   `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `TAURI_SIGNING_PRIVATE_KEY`
   and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. If any of them also exists as a
   repository or organization secret, delete that copy.
5. If the macOS runner is not the default, set **`DESKTOP_MACOS_SIGNING_RUNNER`
   as a repository (or organization) variable, not in the environment.** The
   workflow reads it in `strategy.matrix` and `runs-on`, which GitHub evaluates
   *before* the job's environment is bound, so an environment-level variable of
   that name is invisible there and the legs would silently run on `macos-14`.
   The variable selects the runner label for the two macOS signing legs before
   any environment protection applies, so anyone who can edit repository
   variables can choose where the signing key lands. A self-hosted runner
   therefore needs these protections before it is named: it must be ephemeral
   (or wipe the keychain and the workspace after every job), and its runner
   group must be restricted to this repository and to this workflow. Without
   the variable the signing legs use the GitHub-hosted `macos-14`.
6. Commit the updater public key as `plugins.updater.pubkey` in
   `tauri.conf.json` (see Owner inputs below).
7. Have a maintainer run `scripts/update-node-pins.mjs` with `gpg` so the
   committed record for the Node version is `gpg-verified`.

The environment is deliberately not created or populated by this repository.

### Owner inputs still missing

None of these is generated, defaulted or stored by this repository. Until they
exist the release path stops at its preflight. Item 4 (#4835, packaging
matrix) and the signing half of #4836 are `status: blocked` on them.

1. **Apple Developer ID certificate and notarization credentials**, as the six
   Apple secrets above, stored in the `desktop-release` environment (the
   certificate is a base64 `.p12`; the password is an app-specific password).
2. **Permission to generate the Tauri updater signing key** and a decision on
   where its private half lives. The private key and its password become
   `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (also
   in the environment); the
   public half is committed as `plugins.updater.pubkey` in `tauri.conf.json`.
   Losing the private key strands every installed copy.
3. **macOS arm64 runner confirmation**: either keep GitHub-hosted `macos-14` or
   state that the self-hosted runner used for ergot may be reused for signing
   and set the repository variable `DESKTOP_MACOS_SIGNING_RUNNER` to it (a
   repository or organization variable; see Owner setup, step 5, for the
   runner protections it needs).
4. **Product identity strings** (bundle identifier, display name) in the
   product's `smrt-desktop.json`, plus real product icons: the icons in
   `icons/` are placeholders and no product icons are supplied by the bundle.
5. **A gpg-verified Node pin.** The only pin, Node 26.8.1, is `unverified` (see
   `../README.md`, Node pin provenance); a maintainer with `gpg` must run
   `scripts/update-node-pins.mjs`. The signing job reads this committed record,
   so a release cannot be signed until it says `gpg-verified`.
6. **The product itself** for the `product_dir` and `bridge_path` inputs: a
   standalone app with `smrt-desktop.json`, its lockfile and a pre-bundled MCP
   bridge.

### Not verified

A workflow cannot be run locally. `actionlint`, `yamllint`, the preflight and
feed unit tests and a local `tauri build --no-bundle` of the shell were run; the
hosted runners, the `desktop-release` environment (its branch rule, reviewers
and secret scoping), `tauri-action` building without a release, notarization,
the `codesign` and `stapler` checks, the artifact hand-off between jobs, the
`gh release` upload and Tauri's updater signature have not run. Known gaps for
the first real run:

- The Node sidecar needs a JIT entitlement under the hardened runtime
  (`com.apple.security.cs.allow-jit`); no entitlements file is committed
  because it cannot be tested without the certificate.
- Publishing is all or nothing across the four legs, but the final step is two
  `gh release upload` calls (assets, then `latest.json`), not a transaction: a
  failure between them leaves new assets next to the previous feed, which still
  points at the previous, still present, assets. The rolling release keeps
  every version's assets until pruned.
- The updater signature is produced by Tauri in the signing leg and copied into
  `latest.json`; nothing in the publish job verifies it against the public key.
- The macOS and Linux sidecar binary is not proved to be the one in the pinned
  archive (see above).
- Tar extraction of the downloaded bundle uses the runner's `tar`; the
  `lstat` walk afterwards is what refuses symlinks and extra files.
- Windows installers and Linux packages carry the updater signature but no
  platform code-signing certificate; none was requested. AppImage is not built
  (the launcher does not support it in v1).

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
  and is not a required check. The build and release workflow is described
  under Release pipeline.
- `node --test scripts/release-preflight.test.mjs scripts/release-feed.test.mjs`
  covers the release preflight (closed Tauri fragment, tree walk, committed
  Node pin) and the release asset and feed assembly.

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
- **Bundling the Node binary** is done by `smrt desktop bundle`. Signing,
  notarisation and releases are described under Release pipeline and are
  blocked on owner inputs.
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
