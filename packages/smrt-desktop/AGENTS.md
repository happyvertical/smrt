# @happyvertical/smrt-desktop

The sidecar manifest is shared by the desktop runtime bundler and supervisor.
Its v1 wire format (including optional `env` and `ownerClaimRoute`, reserved
supervisor env names, the `buildSidecarEnv` helper, duplicate-key rejection,
the basename `executable`, and the executable/app-root/data-root split),
portable path rules, and trusted package boundary are documented in
[README.md](README.md). Keep the Node 26 example and test cases aligned with
the parser.

`examples/*.json` are fixtures shared with the Rust wrapper's tests: change them
only together with the parser, the tests and the README. Shared helpers (strict
JSON, grammars, absolute paths) live in `src/internal`; `src/testing` is
test-only. The root export is an explicit list (no `export *`;
`exports.test.ts` lists it).

Owner sign-in and local MCP credentials are app-runtime's (`claimOwner()`, the
loopback onboarding URL, `openLocalMcpTokenStore`); do not rebuild them in this
package or in the Rust wrapper.

The runtime bundler lives in `src/bundler` behind the Node-only
`./bundler` entry (the root entry must never import it; a test
enforces it). `runBundle(plan, seams)` in `run.ts` is the pipeline; every
external effect (filesystem, pnpm, Node download, measurement, environment) is
a seam so tests run offline with a fake installer (`testing/run-fixtures.ts`).
Errors are `BundleError` with the one closed exit-code table in `errors.ts`
(`bundleExitCode`); messages are fixed text and never carry a path, package
name or child output. The report (`report.ts`) is closed and canonical with no
timestamps; keep `smrt desktop bundle`, the README bundler section and the
`B1`-`B14` threat table in step: a test checks that every closing-test title
exists. The feature catalog is in `product-config.ts`; a package a compiled
model imports at run time (such as `@oxc-project/runtime`) must never be in it.
The CLI command (`packages/cli/src/commands/desktop.ts`) stays a thin wrapper.
`--measure` starts the sidecar on an EMPTY data directory (smrt#4835: the app
creates its own schema on first start); never reintroduce a pre-migrated
template. `e2e.test.ts` (real pnpm, nodejs.org, a real start) runs only with
`SMRT_DESKTOP_BUNDLE_E2E=1`. The Node pins are unverified against the release
signature until `scripts/update-node-pins.mjs` is run with `gpg`; each pin's
provenance is recorded in the report and `--require-verified-pins` refuses an
unverified one (a test fails if a pin says `gpg-verified` without evidence).

`smrt desktop build` is `src/builder` behind the Node-only `./builder` entry
(never imported by the root; `exports.test.ts` checks); the CLI command stays
thin. Every effect is a seam (`BuildSeams`), tests never run tauri or cargo,
errors are `BuildError` with fixed text, and the result is always unsigned.
The wrapper ships in the tarball: the file list is `WRAPPER_*` in
`src/builder/constants.ts` and `package.json` `files`, kept equal by
`package-contents.test.ts`; nothing from `target/`, tests or `signing-tools/`
may be added. `launch-smoke.mjs` may import only `node:` modules and
`smoke-support.mjs` (a copy of the CLI redactor, parity-tested). The wrapper
crate version equals the package version (`scripts/sync-desktop-wrapper-version.mjs`
at the repo root runs after `changeset version`; `version-sync.test.ts` and the
build refuse drift). `smrt-desktop.json` `icons` and `updaterPublicKey` are
owner inputs: no default, no generated value. The reusable consumer workflow is
`.github/workflows/desktop-consumer-build.yml`: it must name no path of this
repository, expose secrets only to the release preflight step, and keep its
`TAURI_CLI_VERSION` equal to `src/builder/constants.ts`.

The release workflow `.github/workflows/desktop-release.yml` and
`wrapper/scripts/release-preflight.mjs` fail closed: pull request builds are
unsigned with no secrets, and the signing path refuses to start without every
secret, a real updater key, a gpg-verified Node pin and a non-placeholder
product identity. Never add a default, fallback or generated value for any of
them; the owner inputs still missing are listed in `wrapper/README.md`.

`examples/tricia/smrt-desktop.json` is the Tricia product (the app shell,
`packages/app-shell`); `wrapper/scripts/build-desktop-app.mjs --app tricia`
copies the shell's source into an app tree and installs the packed shell as a
dependency (the shell build marks it external). The shell itself carries no
product identity. Do not add signing or updater values to the example.

The plugin launcher lives in `src/launcher` behind the Node-only `./launcher`
entry (the root must never import it; `exports.test.ts` enforces that). It is a
thin client of app-runtime: the `origin.json` reader (`readOriginFile`) and
`openLocalMcpTokenStore(...).issue({ holder })`; do not add a provider
interface, control channel, credential store or helper around either. Failure
classes and exit codes (`LAUNCHER_FAILURES`) are fixed text that never carries
a path, origin, token or provider message; the probe is `node:http` to literal
127.0.0.1 and must never become `fetch`. The README "Plugin launcher" section
lists the codes: keep it in step with the table.

Keep the root and bundler free of runtime dependencies (Node built-ins only);
`@happyvertical/smrt-app-runtime` is a regular dependency (never a peer: the
repo forbids inter-smrt peers) used only by `./launcher`.

From this directory, run `npm run build`, `npm run typecheck`, and
`smrt test src`.

Normal built-app packaging: [agents/built-apps.md](agents/built-apps.md).
