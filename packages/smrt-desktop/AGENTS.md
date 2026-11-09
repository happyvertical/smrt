# @happyvertical/smrt-desktop

The sidecar manifest is shared by the desktop runtime bundler and supervisor.
Its v1 wire format (including optional `env` and `ownerClaimRoute`, reserved
supervisor env names, the `buildSidecarEnv` helper, duplicate-key rejection,
the basename `executable`, and the executable/app-root/data-root split),
portable path rules, and trusted package boundary are documented in
[README.md](README.md). Keep the Node 26 example and test cases aligned with
the parser.

The package also publishes the installed-product contracts: the bundle
manifest (`smrt-bundle.json`), the installation record (`installation.json`),
`locateInstallation`, `DesktopContractError` (fixed value-free messages keyed
by a closed code) and `SecretString`. `examples/*.json` are fixtures shared
with the Rust shell's tests: change them only together with the parsers, the
tests and the README. Shared helpers (strict JSON, grammars, absolute paths,
private files) live in `src/internal`; `src/testing` is test-only.

The supervisor rendezvous lives in `src/rendezvous`: the instance record
(`instance.json`), the control-protocol codec, the node:net transport, the
typed failure codes and `createFileRendezvous`, plus a reference server
(`startReferenceShell`, `serveControlChannelForTests`) that is a test double:
it lives in `src/reference` and ships only as the Node-only
`@happyvertical/smrt-desktop/testing` subpath, never from the root (an explicit
export list, no `export *`; `exports.test.ts` lists both sets). On Windows it
refuses to start without `insecureForTests: true`.
Clients are read-only: never write, rename or delete a record, socket, lease or
lock, and never retry `failed(lease_held)`. A connection that was accepted and
then dropped or left unanswered is `unresponsive`, never a stale endpoint: do
not spawn. The credential flow takes only the vetted `endpoint` handle of a
`ready` result (none on Windows without a shell-supplied `vetPipe`), and the
`acquire-credential` reply must echo the `instanceNonce`. Node cannot verify the control
channel's peer, so the real check lives in the Rust shell; keep that stated.
Control ops are extensible (`ControlOpSpec`, `createControlCodec`, handler
registry); the credential contract adds its `acquire-credential` op there
(`credentialControlCodec`, `credentialControlOp`), and `coreControlCodec` must
stay credential-free. Rendezvous result types never carry a secret.

The native credential handoff lives in `src/credentials` (slot record,
mint-response validator, custody over an injected `SecretItemStore`, the
`acquire-credential` reference handler, the provider, the fd 3 frame codec and
the bridge spawn helper) and `src/webview` (the browser-safe `./webview` entry:
no Node built-ins, no storage, console, URL or location, no command returns a
token to JS). Tokens are `SecretString`s; `reveal()` is allowed only in
`custody.ts`, `control-handler.ts` and `handoff-frame.ts` (a test enforces it).
Every threat in the README table must keep a test with the named title.

The runtime bundler lives in `src/bundler` behind the Node-only
`./bundler` entry (the root entry and `./webview` must never import it; a test
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
signature until `scripts/update-node-pins.mjs` is run with `gpg`.

Keep the package free of runtime dependencies and use Node built-ins only.

From this directory, run `npm run build`, `npm run typecheck`, and
`smrt test src`.
