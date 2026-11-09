# Generic SMRT App (desktop example)

The first app packaged with `smrt-desktop` (smrt#4835): a generic s-m-r-t app
built from this repository's own SvelteKit template
(`packages/template-sveltekit`), with a placeholder product identity and the
wrapper's placeholder icons. It exists to prove the desktop path inside this
repository, not to be shipped: the bundle id `invalid.example.generic-smrt-app`
is a placeholder, so the signing path (`wrapper/scripts/release-preflight.mjs`)
refuses it, as it must.

What is here (the rest is the template):

| File | Role |
| --- | --- |
| `smrt-desktop.json` | Product configuration: `Generic SMRT App`, the placeholder bundle id, the health route and `sidecar.ownerClaimRoute` (`/api/_runtime/owner-link`) |
| `overlay/src/routes/api/_runtime/owner-link/+server.ts` | Mounts app-runtime's `createOwnerLinkHandler`: the route the wrapper opens its window on |

## Build and bundle

The bundler installs production dependencies from the app's lockfile and takes
only registry packages, but this commit's workspace packages are not published.
`wrapper/scripts/build-generic-app.mjs` therefore serves them from a throwaway
Verdaccio on a loopback port, copies the template (`copyTemplate`), applies the
overlay, resolves and builds the app (`smrt app build`, adapter-node) and runs
`smrt desktop bundle` per target:

```sh
pnpm turbo run build --filter='@happyvertical/smrt-template-sveltekit...'
node packages/smrt-desktop/wrapper/scripts/build-generic-app.mjs \
  --out "$(mktemp -d)" --targets aarch64-apple-darwin --measure
```

`--out` must be outside the checkout; the app, its lockfile and the bundles are
written under it (`app/`, `bundle/<target>/`). Nothing is added to this
repository's workspace or lockfile and nothing is published anywhere else.
`--measure` starts the bundle on an empty data directory (the host target
only), which is the first-run check.

## Launch

`wrapper/scripts/launch-smoke.mjs` runs the unsigned wrapper against a bundle
from an empty data directory and checks the health route, the owner link
(`302` to `/setup?token=...`, never logged), the created data directory and a
clean quit with no sidecar left. CI runs it as `Launch generic app (<os>)`
(`.github/workflows/desktop-launch.yml`).
