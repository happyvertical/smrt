# SMRT desktop wrapper (Tauri 2 supervisor)

Reusable Tauri 2 wrapper that supervises one stock Node 26 sidecar, an SMRT
`adapter-node` app, and shows it in a window. This is the Rust supervisor slice
of epic #4663 (issue #4784). It is a Cargo crate, not an npm package: the
parent package's `files` whitelist (`CLAUDE.md`, `dist`, `AGENTS.md`,
`examples`) keeps `wrapper/` out of the published tarball.

The behaviour reference is the Electron `ingestor-desktop` shell in ergot.io.
Its behaviour was reimplemented, not its code, and its habit of passing a
signing secret in a URL query is deliberately not carried over.

## What it does

1. Reads `sidecar-manifest.json` from the bundled resource directory (v1
   contract, see `../README.md`) and parses it strictly (`src/manifest.rs`).
2. Picks a free loopback port and starts the `externalBin` sidecar through
   `tauri-plugin-shell` (`Command::sidecar`) with:
   - working directory = the resource directory, or its `app` child when
     `workingDirectory: "app"` is declared; separate from the data directory;
   - a cleared environment rebuilt from the parent environment, then the
     manifest `env`, then the supervisor values, which always win:
     `HOST=127.0.0.1`, `PORT=<port>`, `ORIGIN=http://127.0.0.1:<port>`,
     `SMRT_DATA_DIR=<app_local_data_dir>/<dataDirectory>` (machine-local, never the
     roaming `app_data_dir`; decision D7, see the parent README), and
     `SMRT_DESKTOP_OWNER_LINK_SECRET=<launch secret>` (see Owner link) and
     `SMRT_DESKTOP_KEYCHAIN=1` (a marker, no secret: the app runtime then keeps
     vault key material in the OS keychain-wrapped store). The launch secret is
     set on the sidecar command only.
     Inherited names that collide case-insensitively with a reserved or
     manifest name are dropped (`Port`, `host`).
3. Polls `healthRoute` on exactly that origin (`src/health.rs`). Only after a
   2xx, a confirmation window with the child still alive, and a second 2xx
   does the window navigate to the origin plus the manifest's `ownerClaimRoute`
   (the bare origin when none is declared) and show (see Bind-release race and
   Owner link).
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
| Close hides, `quitting` flag lets quit through | Default close hides; explicit `plugins.smrt-desktop.closeBehavior: quit` drains the supervisor and exits |
| `will-quit` stops the runtime before exiting | `RunEvent::ExitRequested{None}` (Cmd+Q) and the tray Quit run the same shutdown, then `exit(0)`; `RunEvent::Exit` is a safety net |
| Child stop: SIGTERM then SIGKILL after 5 s | `shutdown.rs`: graceful 10 s, forced kill, wait for exit; configurable |
| Append-only log, failures never break the tray | `log.rs`, under Tauri's app_log_dir (`~/Library/Logs/<bundle-id>/supervisor.log` on macOS), 512 KiB cap plus one `.1` file, never panics |
| `uncaughtException` logged | Supervisor thread panics kill the sidecar and surface `Failed`; a main-thread panic hook kills the sidecar |
| Health wait accepted any status below 500 and followed redirects | Only 2xx is healthy; any 3xx fails immediately and is never followed |
| Fixed ports | Ephemeral loopback port per launch, preferring the previous port on restart |
| Signing secret in URL query | Not carried over; the owner link is a redirect the webview follows (see Owner link) |
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
  own reclaim mutex), so a crash needs no help from the wrapper.
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
- Raw child output stays in memory for classification. Non-zero exits log the
  last 40 stderr lines, each capped at 400 bytes, so a normal Node uncaught
  stack does not push its error message out of the diagnostic. Secret-bearing environment
  values of at least eight characters, bearer/basic credentials, cookie and
  authorization headers, assignments whose keys end in token/secret/password/
  passwd/key (including camelCase and environment names), and URLs with
  userinfo or credential query parameters are masked as spans **before**
  truncation. Overlapping spans are merged against the original text. All 64+ hex
  secret shapes are masked, including inside paths; ordinary names and short build
  chunk hashes stay readable. Scoped file URLs containing `@happyvertical` are not
  URL userinfo. Error classes, messages and stack paths
  therefore survive redaction. Each launch also records its working and data
  paths through the same redactor, without arguments or environment maps. Stdout stays
  private unless `SMRT_DESKTOP_LOG_SIDECAR_OUTPUT=1` enables the same redacted
  diagnostic tail. The existing capped, rotating supervisor log is unchanged.
  The launch smoke prints its last 8 KiB on failure through the CLI redactor.

## Bind-release race

The wrapper must tell the sidecar its port, so it binds `127.0.0.1:0`, reads the
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

## Owner link

The window does not open on the bare origin when the manifest declares
`ownerClaimRoute`: it opens on `<origin><ownerClaimRoute>?launch=<secret>`
(`window_url` in `env.rs`; the route is only ever appended to the origin the
supervisor selected, never an absolute URL, and a value that is not a plain
absolute path is ignored; the `launch` query is added only with a claim route).
The launch secret is 32 bytes from the OS random source (`getrandom`), hex
encoded to 64 lowercase characters, drawn fresh on every sidecar start. It
is passed only in the sidecar child's environment as
`SMRT_DESKTOP_OWNER_LINK_SECRET` (a reserved name a manifest cannot set) and in
that URL; its `Debug` output is redacted and it is never logged. The route
compares it in constant time and answers `403` without it, so another process
or OS user on the machine cannot fetch the owner link. A generic s-m-r-t app declares `/api/_runtime/owner-link`, which
app-runtime serves (`createOwnerLinkHandler`). The secret already proves the
local person, so an app that opts in with `autoClaim` (the shell and the generic
app do) shows no form: with a valid secret the route creates the local owner on
the first launch (named after the OS account, no email; app-runtime's single
`claimOwner()` transaction), signs the sole owner in again when the session
cookie is gone, sets the session cookie and redirects to `/`. The user goes from
starting the app to being signed in as the owner. Without `autoClaim` the route
instead answers a loopback-only `302` to the one-time `/setup?token=...` page
while the owner is unclaimed, and to `/` afterwards. The wrapper never requests
that route itself: the webview follows the redirect, so no token or session is
ever in the wrapper's memory, argv, environment or log. The log line is
`window origin=<origin> route=<route>` (`window_log_line`; never the query or
the full URL); the `Location` header and `Set-Cookie` are never read. The
wrapper holds no credential. After a sidecar restart the window is navigated to
the same route again, which signs the owner back in. If a signed-out page is
ever shown, it says to quit and reopen the app (the desktop pages never name
terminal commands).

## Modules

| File | Role |
| --- | --- |
| `manifest.rs` | Strict v1 parser: closed schema, duplicate keys rejected (custom serde visitors), portable-path / route / env grammars. Values are never echoed in errors. |
| `env.rs` | Child environment and reserved-value precedence; data directory resolution; the window URL (origin plus owner route). |
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
A consuming app does not copy this directory: the wrapper ships in the
published package and `smrt desktop build` materialises it (see "Building an
installer" in the package README). Everything below describes the same step
done by hand, and what the in-repository release path does.

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

`.github/workflows/desktop-consumer-build.yml` is the reusable, unsigned build
for apps in other repositories (smrt#4965); it never reads this repository's
paths. The signing legs below exist only for this repository's own products:
a consumer's release stops after its preflight until those legs are made
reusable too.

`.github/workflows/desktop-release.yml` (epic #4663 item 5, issue #4836) holds
two paths that share a file and nothing else. `desktop-wrapper.yml` keeps the fast
Rust checks (fmt, clippy, tests on Ubuntu); this workflow builds.

| | PR and verification builds | Release |
| --- | --- | --- |
| Trigger | pull request or push to main that changes `packages/smrt-desktop/**` or the workflow; manual dispatch | manual dispatch from main with `release` set; nothing else reaches it |
| Signing | none, unsigned | Apple Developer ID signing and notarization, Tauri updater signature, in a job that compiles nothing |
| Token and secrets | `contents: read`, no secrets | secrets come from the `desktop-release` environment and reach only the preflight presence check and three named signing steps; the compile job has none; `contents: write` only in the final publish job |
| Matrix | macOS arm64 (`macos-15`), macOS x64 (`macos-15-intel`), Windows, Linux | the same four targets |
| Product | none: the wrapper is compiled and linked with `tauri build --no-bundle` | a bundle made by `smrt desktop bundle` for each target |
| Output | pull requests upload nothing; main and dispatch keep the unsigned wrapper binary for 3 days | one publish step, after every target is built, signed and verified, to the rolling `desktop-latest` prerelease plus `latest.json` (the updater feed) |

Pull request builds are a compile and link smoke, not a product build. There is
no product in this repository, so no `externalBin`, resources or installer are
produced and nothing is faked. The policy (path filter, uploads only from main
or dispatch, short retention) follows ergot's `capture-desktop-artifacts.yml`.
The other actions are pinned by commit SHA; the Tauri CLI (`TAURI_CLI_VERSION`),
the Rust toolchain (`RUST_TOOLCHAIN`) and Node (`NODE_VERSION`) are pinned to
exact versions, and every `cargo` and `tauri build` runs with `--locked`
(`tauri build ... -- --locked`). `tauri-action` is no longer used: the wrapper is
built by an explicit `tauri build`, so no third-party action ever sits in a
step next to a secret.

### Jobs and who holds which secret

Compiling and signing are separate **jobs**, not only separate steps. A crate
build script or proc macro in the wrapper's `Cargo.lock` runs arbitrary code and
can write anywhere on its runner (a PATH shim, the global npm directory,
`~/.cargo`); a later step on the same runner would then run it with the key.

| Job | Runs | Secrets |
| --- | --- | --- |
| `release-preflight` | environment check (token: `contents: read` and `actions: read`, nothing else), then a presence check | the eight secrets, for presence only, in one step |
| `release-bundle` | product `pnpm install`, `smrt app build`, `smrt desktop bundle` | none; no environment |
| `release-build` | re-verifies the bundle, then `tauri build --no-sign --locked` on a fresh hosted runner, every crate build script | none; no environment |
| `release` | re-verifies the bundle, then signs: `codesign`, `xcrun notarytool`, `stapler`, `hdiutil`, `tauri signer sign`; no cargo, rustup, pnpm or build | only in three steps, each only its own: certificate import (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`); sign and notarize (`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`); updater signature (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) |
| `release-publish` | verifies every updater signature, then `gh release` | none (`contents: write` only) |

The Tauri CLI of the signing job is installed in a step that has no secrets,
with `npm ci --ignore-scripts --prefix packages/smrt-desktop/wrapper/signing-tools`
from the committed `signing-tools/package.json` and `package-lock.json`. The
lockfile pins `@tauri-apps/cli` and every platform-specific optional package it
has by version and sha512 integrity, all resolved from `registry.npmjs.org`;
`npm ci` refuses a lockfile that disagrees with `package.json`, and the step
cannot fetch anything the lockfile does not name. The signing step runs the
binary by absolute path (`$GITHUB_WORKSPACE/$WRAPPER_DIR/signing-tools/node_modules/.bin/tauri
signer sign`), never from `PATH`. Nothing is installed or downloaded after that.
`signing-tools` is not a pnpm workspace package (the workspace globs do not reach
it). To change the CLI version, edit `TAURI_CLI_VERSION` in the workflow and
`signing-tools/package.json` to the same exact version, then run
`npm install --package-lock-only --ignore-scripts` in `signing-tools` and review
the lockfile diff; the workflow test fails if the three disagree, if any locked
package lacks an integrity hash or comes from another host, or if a platform
package is missing. The last step of the signing job is `if: always()`: it
deletes the temporary keychain (and with it the imported certificate), removes
the downloaded and staged files and the installed CLI. No key file is ever
written: `tauri signer sign` reads the key from the environment of its one step.

The separation is enforced by structure and review, not by a workflow lint
(the textual lint and its signing-command allow-list were removed: they could
be bypassed by spellings they did not model, and the environment protection and
review are the real control). The structure is: secrets are referenced only as
the `env` of the named signing steps of the `release` job, which runs no
compiler or package manager; builds happen in `release-build`, which holds no
secret; the signing CLI is the one locked `npm ci` install; every `cargo` and
`tauri build` has `--locked`; and `.github/**`, `wrapper/**` and the Node pins
have CODEOWNERS (`.github/CODEOWNERS`), so a change to any of them needs the
owner's review. The preflight job has exactly `contents: read` and
`actions: read`. The signing-tools lockfile names `@tauri-apps/cli` at the
workflow's version, with a sha512 integrity for every entry.

`scripts/ci-runner-inventory.test.mjs` (root) reads every workflow's `runs-on`
from the parsed document (a job header the old line reader did not match could
hide one), requires `desktop-release.yml` to have exactly its six jobs with the
expected `runs-on` each, reads the three matrix jobs the same way and fails on any runner that is not on the explicit list, any matrix
axis or `exclude` besides `include`, any flow-style entry, extra key, anchor or
alias.

What this does not stop: a malicious crate that runs in `release-build` can
still produce a malicious app, and the signing job would sign it. Separation
keeps the key from being read, not from being used on tampered output; the
committed `Cargo.lock`, `--locked` and review bound that. The Tauri CLI of the
two build jobs (`verify-build`, `release-build`) is still installed with
`npm install --global --ignore-scripts` at an exact version, so it has the
registry's integrity check only; those jobs hold no secret, and a CLI tainted
there would be a tainted build, which is the case the previous paragraph
describes. Only the signing job, which holds the key, uses the lockfile.

### Fail-closed preflight

The release path starts with `scripts/release-environment.mjs` and
`scripts/release-preflight.mjs` (tested by `scripts/release-environment.test.mjs`
and `scripts/release-preflight.test.mjs`, run by the verification build on
Linux). They refuse, name what is missing and never print a value, unless all of
these hold:

1. The run is on main.
2. **The `desktop-release` environment is protected.** The job reads
   `GET /repos/{repo}/environments/desktop-release` and its
   `deployment-branch-policies` with the job's own token and refuses unless:
   the environment exists; admins cannot bypass its rules
   (`can_admins_bypass: false`); a `required_reviewers` rule has at least one
   reviewer and `prevent_self_review: true`; deployment branches are "selected
   branches" (`custom_branch_policies: true`, `protected_branches: false`) and
   the rule list is exactly one entry, the branch `main` (no tag, no pattern, no
   second branch). GitHub's permission table for fine-grained tokens lists
   these two endpoints under "Actions: read", and a workflow token with only
   `contents: read` has `actions: none`, so the `release-preflight` job declares
   `permissions: { contents: read, actions: read }` and nothing broader (the
   workflow test pins exactly that). **This has not been proven by a real run:**
   the permission is taken from the documentation, not observed. If GitHub
   answers 401, 403 or 404 (it answers 404 both for a missing environment and
   for a token that cannot read it) the check fails closed, and the message
   names `actions: read`. The check never skips. **What it is worth:** a workflow that names an
   environment that does not exist creates it silently and unprotected, and a
   presence-only secrets check cannot tell. This check catches the *owner's*
   mistake. It is not a defence against an attacker: whoever can change this
   workflow can remove the step. **The environment's own deployment branch rule,
   which GitHub enforces before any job can read a secret, is the real
   control.**
3. The Apple secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
   `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID`.
4. `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
5. A real updater public key in `tauri.conf.json` (`plugins.updater.pubkey`).
   The committed value is an obviously invalid placeholder; the check requires
   the base64 minisign public key format Tauri generates.
6. The `product_dir` and `bridge_path` dispatch inputs, as safe repo-relative
   paths.

Each target's bundle is checked in `release-build` and again in `release`, the
job that holds the key, before any signing, against the trusted checkout
(main), not against what the bundle says about itself:

- `tauri.bundle.json` must be exactly `bundle.externalBin` (one entry, the
  product-scoped `binaries/<productId>-node`) and `bundle.resources`
  (`{"resources/": "./"}`) and nothing else, at any level. The overlay handed
  to the build is built from an allowlist (that sidecar, that resource
  directory, `createUpdaterArtifacts: false`: the compile job has no key, and
  the updater archives are made and signed afterwards), so a `signCommand`, an
  NSIS template, extra `files`, entitlements or any other key in the bundle
  cannot reach it. The overlay's product name and version are also validated
  (safe characters, semantic version). The signing job derives the product name
  and version from its own verified copy of the bundle, never from the unsigned
  build.
- The bundle never travels as an archive. The bundle job uploads the bundle
  directory itself (`upload-artifact` stores file contents, follows a symlink
  and stores the target's bytes as a regular file, and drops permissions); the
  build and signing jobs download it into an empty directory under
  `$RUNNER_TEMP`, never the checkout. There is no `tar` member that could be
  written through an earlier symlink member over trusted files
  (`tauri.conf.json`, the preflight script, the pin table,
  `~/.cargo/config.toml`). The unsigned build output crosses the same way, as a
  directory of files. Because permissions do not survive, staging marks every
  file under `binaries/` executable and the signing job marks the app's
  executables.
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
cache shim (it saves nothing a trusted run could restore). The compile and
signing jobs restore no cargo cache either: they build cold with the pinned
toolchain.

### The macOS signing runner

By default macOS signing runs on the GitHub-hosted `macos-15`, a fresh VM per
job, and nothing more is needed. The compile job always runs on a hosted
runner; only the signing job's two macOS legs read the repository (or
organization) variable `DESKTOP_MACOS_SIGNING_RUNNER`.

If that variable is set it may name **only a dedicated, ephemeral runner**: one
that takes a single job and is destroyed, registered in **its own runner group
that is limited to this repository and to this workflow**. It must **never** be
a shared runner: not a self-hosted runner that also runs other repositories'
(or this repository's) pull request builds, and not a persistent workstation.
Whatever a job leaves in `~/.cargo`, the global npm directory, a rustup default
or a LaunchAgent would otherwise run in a later job that holds the signing
secrets. The signing job also removes what it writes in an `always()` step, but
that is a second line, not a substitute for an ephemeral runner.
`scripts/ci-runner-inventory.test.mjs` parses the matrix of the verification,
compile and signing jobs and fails on any runner outside `macos-15`,
`macos-15-intel`, `windows-latest` and `ubuntu-latest`, on a self-hosted label
anywhere in the workflow, and on the variable being used anywhere but the signing
job's macOS legs; the verification build, which runs on pull requests, can never
reach it.

### All or nothing publishing

The four signing legs publish nothing. Each signs, and (macOS) runs
`codesign --verify --deep --strict` and `xcrun stapler validate` on its `.app`
and `.dmg`, then stages its installer, updater archive and signature under safe
names (`scripts/release-feed.mjs leg`) and uploads them as a one-day workflow
artifact. `fail-fast` stops the other legs when one fails. The
`release-publish` job `needs` every leg, so it runs only when all four
succeeded; it assembles one `latest.json` and the asset set
(`release-feed.mjs feed`: refuses a missing leg, a version or product-name
mismatch, a symlink, a missing signature or a signature that does not verify),
uploads the new assets to `desktop-latest` first and `latest.json` last, so the
feed never names an asset that is not there yet. Linux ships a `.deb` only; the
Tauri updater cannot update a `.deb`, so the feed has no Linux entry (AppImage
is not built in v1). Assets are named `<product>_<version>_<target>.<ext>` so a
rebuild of the same version replaces the same names and a new version never
overwrites the previous feed's targets.

### Updater signatures are verified against the committed key

`scripts/minisign.mjs` verifies the `.sig` files Tauri's `tauri signer sign`
writes (a base64-wrapped minisign signature: both the prehashed `ED` variant the
Tauri CLI emits and the legacy `Ed` variant, with the trusted-comment signature)
against `plugins.updater.pubkey` in `tauri.conf.json`, using Node's Ed25519.
It rejects an unknown key id, a wrong key, a changed payload or trusted comment,
truncation, extra lines or bytes and non-canonical base64. The check runs twice:
when each signing leg stages its output (a bad key stops the leg before upload)
and again in `release-publish`, before anything is uploaded. Because the public
key is committed and the private key is a secret, a passing check also proves
that `TAURI_SIGNING_PRIVATE_KEY` is the **private half of the committed public
key**; a mismatched pair (a wrong or rotated key, a key from another product)
fails the release instead of shipping an update no client can verify. The test
vectors in `scripts/minisign.test.mjs` are generated in the test; no key
material is committed.

### Owner setup (once, before the first release)

The release path trusts its location. A workflow file lives on whatever branch
a person with write access dispatches it from, and a same-repository pull
request that edits it receives repository secrets, so the main-only check
inside the file is not a control on its own. The gate is a GitHub environment,
and the controls around it. Do these **in this order**:

1. **Create the `desktop-release` environment by hand** (Settings,
   Environments), before storing any secret. A workflow that names an
   environment that does not exist creates it silently and **unprotected**; the
   preflight's environment check then fails closed, which is the backstop, not
   the control.
2. **Deployment branches and tags: selected branches, `main` only, no tags.**
   Add exactly one rule, the branch `main`. A dispatch from any other branch,
   or a pull request, then cannot read anything in the environment.
3. **Required reviewers**, with **prevent self-review** on and **no admin
   bypass** ("Allow administrators to bypass configured protection rules" off).
   Expect an approval prompt for the preflight, one for the signing legs and one
   for the publish job.
4. **Protect `main` with a ruleset that requires review.** `.github/CODEOWNERS`
   already names the owner for `.github/`, `packages/smrt-desktop/wrapper/` and
   `packages/smrt-desktop/src/bundler/node-pins.ts` (the files that decide what
   runs with the secrets and what is trusted as a pin); turn on "require review
   from code owners" in the ruleset so it applies.
5. **Actions settings:** read-only default token permissions; Actions may not
   create or approve pull requests; approval required for workflows from fork
   pull requests; no secrets sent to workflows from fork pull requests.
6. **Confirm none of the eight secret names exists at repository or
   organization level** (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
   `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`,
   `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). Delete any
   copy found there.
7. **Leave `DESKTOP_MACOS_SIGNING_RUNNER` unset, or point it at a dedicated
   ephemeral runner** (see the macOS signing runner section). It is a
   *repository or organization variable, not an environment variable*: the
   workflow reads it in `strategy.matrix` and `runs-on`, which GitHub evaluates
   *before* the job's environment is bound, so an environment-level variable of
   that name is invisible there. Anyone who can edit repository variables can
   choose where the signing key lands, so restrict who can.
8. **Restrict who can move the `desktop-latest` tag and edit releases**
   (tag protection or a tag ruleset, and the permission to edit releases). The
   publish job moves nothing by itself, but the rolling release is what clients
   will read.
9. **Generate the updater key pair offline** (`tauri signer generate`), keep
   the private half out of the repository and the machine that runs CI, and
   **commit the public half** as `plugins.updater.pubkey` in `tauri.conf.json`.
10. **Run `scripts/update-node-pins.mjs` with `gpg`** so the committed record for
    the Node version is `gpg-verified`.
11. **Only then add the eight secrets**, in the environment.

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
   in the environment); the public half is committed as
   `plugins.updater.pubkey` in `tauri.conf.json`. Losing the private key
   strands every installed copy.
3. **macOS signing runner decision:** hosted `macos-15` (the default, and the
   recommendation), or a **dedicated ephemeral runner in its own runner group
   limited to this repository and this workflow**, named by the repository
   variable `DESKTOP_MACOS_SIGNING_RUNNER`. A shared runner, including any
   self-hosted runner that runs other pull request builds, is not an option.
4. **Product identity strings** (bundle identifier, display name) in the
   product's `smrt-desktop.json`, plus real product icons: the icons in
   `icons/` are placeholders and no product icons are supplied by the bundle.
   Tricia's identity is decided and committed
   (`../examples/tricia/smrt-desktop.json`: `Tricia`, `com.happyvertical.tricia`,
   `tricia`); its icons are still the placeholders. Its release and update home
   is GitHub Releases of the public repository `happyvertical/tricia`, where the
   `latest.json` feed (smrt#4836) will be served. This workflow still publishes
   to this repository's `desktop-latest` release, so pointing the publish step at
   that repository is open, and so are the signing secrets and the updater key.
5. **A gpg-verified Node pin.** The only pin, Node 26.8.1, is `unverified` (see
   `../README.md`, Node pin provenance); a maintainer with `gpg` must run
   `scripts/update-node-pins.mjs`. The signing job reads this committed record,
   so a release cannot be signed until it says `gpg-verified`.
6. **The product itself** for the `product_dir` and `bridge_path` inputs: a
   standalone app with `smrt-desktop.json`, its lockfile and a pre-bundled MCP
   bridge.

### Not verified

A workflow cannot be run locally. `actionlint`, the preflight, environment,
minisign, feed and workflow-structure unit tests and a local `tauri build
--no-bundle` of the wrapper were run; the Tauri CLI's `signer sign` output was
checked against the minisign verifier with a throwaway key. The hosted runners,
the `desktop-release` environment (its rules, reviewers and secret scoping, and
what the API returns for a token on a real run), the split compile and signing
jobs, `tauri build --no-sign` with the release overlay, the artifact hand-off
between jobs (including the unsigned `.app` surviving it), the `codesign`,
notarization, `stapler` and `hdiutil` steps and the `gh release` upload have not
run. Known gaps for the first real run:

- The Node sidecar needs a JIT entitlement under the hardened runtime
  (`com.apple.security.cs.allow-jit`); no entitlements file is committed
  because it cannot be tested without the certificate, so the signing step
  passes none.
- The dmg is built with `hdiutil create` from the stapled app and is plain (no
  background or icon layout); Tauri's own dmg bundler is not used because it
  would need the signing identity in the compile job.
- Publishing is all or nothing across the four legs, but the final step is two
  `gh release upload` calls (assets, then `latest.json`), not a transaction: a
  failure between them leaves new assets next to the previous feed, which still
  points at the previous, still present, assets. The rolling release keeps
  every version's assets until pruned.
- The macOS and Linux sidecar binary is not proved to be the one in the pinned
  archive (see above).
- Windows installers and Linux packages carry the updater signature (Windows)
  but no platform code-signing certificate: the Windows NSIS installer has no
  Authenticode signature. None was requested. AppImage is not built (the
  launcher does not support it in v1).
- **There is no updater client and no endpoint in the wrapper yet.** The wrapper
  has no `tauri-plugin-updater` and `tauri.conf.json` declares no `endpoints`;
  `latest.json` and the signatures are produced and verified, but nothing reads
  them. The feed does not compare against the live feed either: nothing checks
  that the new version is greater than the one `latest.json` currently
  advertises.
- The `desktop-latest` tag is created on the first commit that publishes and
  stays there, so the release carries no build provenance (commit, run).

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
- `.github/workflows/desktop-wrapper.yml` runs the same three commands on Ubuntu
  for changes under `packages/smrt-desktop/wrapper/` only. It is path filtered
  and is not a required check. The build and release workflow is described
  under Release pipeline.
- `.github/workflows/desktop-launch.yml` (path filtered, not required, not part
  of the `Verify build` legs) is the launch smoke for the generic example app
  (`../examples/generic-app`, smrt#4835) and for Tricia
  (`../examples/tricia`, the app shell; macOS arm64 only, triggered by
  `packages/app-shell/**` too). Job `Bundle <app> app` builds the app (the
  generic one from the repository's template, Tricia from a copy of
  `packages/app-shell`) and bundles it for its targets
  (`scripts/build-desktop-app.mjs --app generic|tricia`); `Launch <app> app (macos |
  windows | linux)` compiles the wrapper without a product (`cargo build
  --locked`) and runs `scripts/launch-smoke.mjs` against that bundle from an
  empty data directory: ready origin in the log, window opened on origin plus
  `ownerClaimRoute`, health 200, data directory created, the owner link
  answering `403` without the launch secret (and for a wrong secret and a
  foreign `Host`), no secret or token in the wrapper log, an orderly quit and no sidecar left. The local runtime now
  opens its database on Windows through `@happyvertical/sql`'s
  `windowsCustody.verify` (smrt#4837), so the Windows leg can pass, but no green
  `windows-latest` run is recorded yet; the Windows and Linux legs stay
  `continue-on-error` until one is. The unsigned wrapper is
  the cargo build, not an installer: signed installers are the release path.
- The published tarball carries only what `smrt desktop build` needs: the crate
  sources, `Cargo.lock`, `scripts/launch-smoke.mjs`, `scripts/smoke-support.mjs`
  and `scripts/release-preflight.mjs` (`package.json` `files`; no `target/`, no
  tests, no `signing-tools/`). `launch-smoke.mjs` imports only Node built-ins
  and `smoke-support.mjs`, whose redactor is a copy of the CLI's with a test
  that compares them. The crate version equals the package version
  (`scripts/sync-desktop-wrapper-version.mjs`; `version-sync.test.ts`).
- `node --test scripts/*.test.mjs` covers the release preflight (closed Tauri
  fragment, tree walk, committed Node pin), the environment guard (offline
  fixtures of the GitHub API), the minisign verification (keys generated in the
  test), the release asset and feed assembly, and the workflow-structure test
  that keeps the signing secrets out of every build step, plus the pure parts of
  the launch smoke and the desktop app build (generic and Tricia).

Manual smoke run: in a debug build the resource directory is the executable directory, so put a
`sidecar-manifest.json`, the sidecar script and a symlink named like the
manifest's `executable` (pointing at a `node` binary) in
`target/debug/` and run `target/debug/smrt-desktop-wrapper`. The log is at
Tauri's app_log_dir (`~/Library/Logs/<bundle-id>/supervisor.log` on macOS).

## Deferred to later slices (clean seams only)

- **Owner sign-in** is done (see Owner link): the window opens on
  `ownerClaimRoute`, and sign-in is app-runtime's launch-secret-gated
  `autoClaim` owner link (no form); the wrapper carries no credential (#4835).
- **Bundling the Node binary** is done by `smrt desktop bundle`. Signing,
  notarisation and releases are described under Release pipeline and are
  blocked on owner inputs.
- Runtime health monitoring after `Ready` (a hung but alive sidecar is not
  detected; only exits are), an in-window status page for `Restarting` /
  `Failed` (the tray carries the state; the webview shows the browser's error
  page for the dead origin until the next `Ready`), and hiding the macOS Dock
  icon.

## Known risks

- If the wrapper is killed with SIGKILL (or crashes without unwinding) the
  sidecar is orphaned and keeps the lease. The next launch then sees
  `LeaseHeld`, backs off, and ends in `Failed` rather than running two writers;
  quit the orphan to recover. A Linux `PR_SET_PDEATHSIG` or sidecar-side
  parent watch would close this and needs sidecar cooperation.
- The graceful stop timeout (10 s) must cover the runtime's own shutdown; the
  force-kill after it can interrupt a long SQLite checkpoint.
- CI covers Linux only. The Windows code paths (`taskkill` stop, job-object
  kill via the shell plugin) were not compiled or run, and the GUI paths were
  only exercised on macOS (tray, window and quit were not inspected visually).

For normal built apps, app-root cwd, optional quit-on-close, unsigned macOS
archives and headless persistence smoke, see [built apps](../agents/built-apps.md).
