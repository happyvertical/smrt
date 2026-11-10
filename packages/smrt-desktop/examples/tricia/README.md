# Tricia (desktop product)

The desktop MVP product: the s-m-r-t app shell
([`packages/app-shell`](../../../app-shell/README.md), the in-shell assistant
included) packaged with `smrt-desktop` the same way as the
[generic example app](../generic-app/README.md). Tricia builds and runs a
person's own s-m-r-t app from definitions, for one person: the owner.

| | |
| --- | --- |
| Display name | `Tricia` |
| Bundle identifier | `com.happyvertical.tricia` |
| Product id | `tricia` |
| Release and update home | GitHub Releases of the public repository `happyvertical/tricia`: the updater feed `latest.json` is served from a release there (smrt#4836) |

## Where it lives

Only `smrt-desktop.json` is here. There is no overlay: the shell mounts the two
routes the wrapper needs itself (`/api/_runtime/health` and
`/api/_runtime/owner-link`, both app-runtime handlers), and the product
identity is not part of the app shell, which is a published, product-neutral
package. The build script copies the shell's source, adds this configuration and
bundles the result (`wrapper/scripts/build-desktop-app.mjs --app tricia`).

The release and update home is recorded here and not in the configuration:
`smrt-desktop.json` has no update or signing settings (its grammar is closed),
and the wrapper has no updater client or endpoint yet. Nothing in this
repository holds a signing secret, an updater key or a fallback for one; the
release preflight (`wrapper/scripts/release-preflight.mjs`) still fails closed
without them. Signing is deferred (see "Owner inputs still missing" in
`wrapper/README.md`).

## Features

`features.default` is `["ai-providers"]`: the assistant picks its provider at
run time from the configured key (Anthropic, OpenAI or Gemini), so the three
SDKs ship (about 9 MiB). The generic app leaves them out.

## Build and bundle

The bundler installs only registry packages. The script serves this commit's
workspace packages from a throwaway loopback Verdaccio (as for the generic app),
and turns a copy of the shell into an application tree: `workspace:*` and
`catalog:` ranges become registry ranges, the test tooling is dropped, and
`@happyvertical/smrt-app-shell` itself is added as a dependency, because the
shell's server build marks that package external and loads its engine worker
from it at run time. The tree is built with adapter-node and bundled per target:

```sh
pnpm turbo run build \
  --filter='@happyvertical/smrt-app-shell...' \
  --filter='@happyvertical/smrt-cli...' \
  --filter='@happyvertical/smrt-app-cli...'
node packages/smrt-desktop/wrapper/scripts/build-desktop-app.mjs --app tricia \
  --out /path/outside/the/checkout/tricia --targets aarch64-apple-darwin --measure
```

`--measure` starts the bundle on an empty data directory (the app creates its
own schema, the health route must answer 2xx).

## Run it

```sh
cd packages/smrt-desktop/wrapper && cargo build --locked
node scripts/launch-smoke.mjs --wrapper target/debug/smrt-desktop-wrapper \
  --bundle /path/outside/the/checkout/tricia/bundle/aarch64-apple-darwin \
  --triple aarch64-apple-darwin
```

The smoke test checks ready, health, the data directory, the owner link (`403`
without the launch secret) and a clean quit. It needs an empty data directory
for the wrapper's identifier, and a second debug wrapper with the same
identifier cannot run next to the first (Tauri's single-instance socket is
`/tmp/<identifier>_si.sock`; the second launch forwards to the first and
exits). To run next to another debug wrapper, such as a QA app, build the
wrapper with its own identifier and tell the smoke:

```sh
TAURI_CONFIG='{"identifier":"com.happyvertical.tricia.debug"}' \
  CARGO_TARGET_DIR=/path/outside/the/checkout/wrapper-target cargo build --locked
node scripts/launch-smoke.mjs --wrapper /path/outside/the/checkout/wrapper-target/debug/smrt-desktop-wrapper \
  --bundle <bundle dir> --triple aarch64-apple-darwin \
  --identifier com.happyvertical.tricia.debug
```

To use the app, run the staged debug wrapper (`launch-smoke.mjs --keep` leaves
the layout) and the window opens on the owner setup page.

## The assistant needs an API key

The assistant answers only with an API key (never a subscription login). The
key comes from the `ai` block of `smrt.config.ts`, `SMRT_AI_*` or the provider's
own variable (`ANTHROPIC_API_KEY`), read from the sidecar's environment. The
wrapper's sidecar inherits the wrapper process's environment, so today a key
reaches it only when Tricia is started from a terminal that has the variable
set (the app's executable, or the debug wrapper, run directly).
An app opened from Finder or the Dock does not see shell variables, and there is
no settings screen yet (bring-your-own key is smrt#4666), so an ordinary desktop
user cannot supply a key today. Without a key the dock shows its "not
configured" state; the rest of the shell works.
