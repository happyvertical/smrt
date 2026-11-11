# Packaging a normal built app

The wrapper's `scripts/build-desktop-app.mjs` accepts `--app <directory>` beside
its unchanged `generic` and `tricia` examples. Build the application's normal
adapter-node output with `smrt app build` first (run its normal prebuild, if any).
`--build-dir <directory>` selects output kept outside the checkout. Staging copies
compiled output and declared runtime files only, never application source,
node_modules, pnpm hooks, scripts, environment files or development dependencies.

The script uses the existing temporary loopback registry to serve this checkout's
packed framework versions. Root workspace dependency ranges become those exact
versions. Other dependency ranges remain the app's ranges; the stage generates a
standalone production lockfile, then the existing bundler consumes it frozen.
This is a local-checkout packaging workflow, not proof of equality to the source
app's development lockfile. The registry stops in finally and its publishing
credential is removed. Dependency validation follows feature segmentation: a missing required dependency
of a retained package still refuses the bundle, while a removed package cannot
make its unused dependency mandatory. The regression keeps both controls.
Production packages still pass the bundler's install,
feature, import, native, secret-content and digest gates without bypasses.

For a normal app, product configuration adds:

```json
{
  "sidecar": {
    "workingDirectory": "app",
    "args": ["build/index.js"]
  },
  "runtimeFiles": ["smrt.cookbook.json"],
  "features": { "default": ["images", "ai-providers"] }
}
```

These fields supplement the existing identity, bridge, owner-link and health
configuration. `workingDirectory` is optional v1 data and accepts only `app`:
the resource directory's app child. Omission retains the existing resource-root
cwd and `app/build/index.js` arguments. Both parsers reject unknown directories,
escapes and repeated keys. The bundle retains production dependency metadata for
normal-app manifest discovery. Only explicit regular runtime files are copied,
with the existing secret filters and content scanner; missing, secret or reserved
output files refuse publication. No database is bundled. First start activates
and migrates only what the host's lazy coordinator enables.

`browser`, `documents` and `local-ml` join the existing disabled-by-default feature
catalog. They remove crawler/browser SDKs, document extractors, transformer and
ONNX runtimes respectively, including their exclusive dependencies. `images`
keeps sharp and its platform prebuilds. Opting into a document workflow may also
require its `ocr`, `pdf` and `browser` features. Exclusion is explicit packaging
policy; there is no automatic capability installer. A static import of removed
code still fails; lazy paths require the existing acknowledgements.

## Native local build and lifecycle

On the matching macOS host, add `--native`. The script stages the existing Rust
wrapper below the output, verifies each resource against the bundle digest list,
and runs Tauri `build --no-sign --bundles app -- --locked`. Tauri CLI must be on
PATH (use the version pinned by desktop-release.yml). The archive step reuses the
release pipeline's macOS `ditto` zip tool. The output includes a local `.app` and
`*-unsigned.zip`; no signing/updater credentials are supplied or generated.
`--close-behavior quit` sets the wrapper's `plugins.smrt-desktop.closeBehavior`;
its default remains `hide` for existing tray apps. Quit drains the same supervisor
as Cmd+Q. Single instance, free loopback port, launch-secret handoff and process
group shutdown reuse the existing wrapper. Data remains in app_local_data_dir;
logs now use Tauri app_log_dir (macOS `~/Library/Logs/<bundle-id>/supervisor.log`).

Signing is still the separate existing release-preflight/release workflow.
The owner must supply APPLE_CERTIFICATE (base64 Developer ID .p12),
APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD
(app-specific), APPLE_TEAM_ID, updater private key/password and its committed
public key, product icons, the protected signing runner/environment and a
GPG-verified Node pin. The Node JIT entitlement under hardened runtime also needs
certificate-backed validation (existing release gap). Local unsigned packaging
does not establish notarization, distribution signing or updater readiness.

## Smoke and measurement

`launch-smoke.mjs --sidecar-only --bundle <dir> --triple <host-triple>
--list-route <REST-list> --data-parent <private-output-dir> [--record-route <route>
--record-json <JSON>] [--report <file>]` uses the exact bundled executable,
manifest args, cwd and supervisor environment. It starts twice on free loopback
ports above 4900, checks health, rejects a missing owner secret, obtains an owner
session, lists REST records, optionally creates and re-reads a record after a
clean shutdown, and checks that the old listener is gone. Disposable data is
outside the bundle and removed after shutdown. Child output and credentials
never enter the report. The existing measurement process-group cleanup is reused;
its child now optionally exposes pid for RSS measurement and stopMeasuredProcess
is exported from the Node-only bundler entry. firstWindowMs is null in headless
mode; that value must not be described as a measured GUI/window paint.

## Validation and reuse

Use the desktop package's full build/test/typecheck, Node wrapper script suite,
Cargo fmt/test/clippy, and the repository gates. In-process bundle fixtures prove
app cwd, explicit runtime files, discovery metadata, missing/secret refusal and
atomic output. The Rust real-supervisor fixture proves cwd and clean shutdown.
Existing generic/Tricia tests remain unchanged except catalog expectations grow
with the optional features. The actual product smoke is the runtime evidence.

Reuse discovery used smrt-dev-mcp review-smrt-project on desktop and the product,
build-context's architecture lookup for built SvelteKit packaging/pruning and
owner-session persistence, the intent index, and name/purpose rg searches across
smrt-ui, smrt-svelte, chat, core, CLI, runtime and desktop. The server has no
separate component/recipe/intent search tools. Extended existing build-desktop-app,
launch-smoke, bundler config/measurement and Rust supervisor modules. No new
production component, model, route, helper file or tool implementation was added.
Product orchestration delegates to these existing framework scripts.
