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
`e2e.test.ts` (real pnpm, nodejs.org, a real start) runs only with
`SMRT_DESKTOP_BUNDLE_E2E=1`. The Node pins are unverified against the release
signature until `scripts/update-node-pins.mjs` is run with `gpg`; each pin's
provenance is recorded in the report and `--require-verified-pins` refuses an
unverified one (a test fails if a pin says `gpg-verified` without evidence).

The release workflow `.github/workflows/desktop-release.yml` and
`wrapper/scripts/release-preflight.mjs` fail closed: pull request builds are
unsigned with no secrets, and the signing path refuses to start without every
secret, a real updater key, a gpg-verified Node pin and a non-placeholder
product identity. Never add a default, fallback or generated value for any of
them; the owner inputs still missing are listed in `wrapper/README.md`.

Keep the package free of runtime dependencies and use Node built-ins only.

From this directory, run `npm run build`, `npm run typecheck`, and
`smrt test src`.
