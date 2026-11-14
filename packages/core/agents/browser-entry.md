# Browser entry: no Node-only modules (#2838)

`src/browser.ts` is what `package.json#exports["."].browser` resolves to. Its
module graph must build for a browser **and evaluate** in one. Two guards hold
it:

- `packages/bundle-gate` builds it with Vite browser conditions and fails on
  `node:` built-ins, `pg`, `cosmiconfig`, `jiti` and the rest of
  `FORBIDDEN_NODE_ONLY_MODULES` (core is held to zero even while its ratchet
  entry exists for another reason).
- `pnpm test:browser` bundles the built `dist/browser.js`, loads it in
  Chromium, registers a decorated class, and fails on any evaluation error or
  any module Vite externalized "for browser compatibility". Set
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use another Chromium. CI runs it in
  the workbench browser job.

`@noble/hashes`, `import-meta-resolve` and `minimatch` remain external runtime dependencies in the preserve-modules
package build. Bundling it under `dist/node_modules` leaves dangling imports
when npm excludes that directory from tarballs. The packed MCP consumer tests
the installed relative-import closure and real SHA-256 execution with normal and CI prepack paths (#4008).

The browser test also runs a separate Chromium fixture against the SDK's real
PGlite adapter, checking that a model delete clears both tracked and untracked
`SET NULL` references, and advances only the tracked revision. It exercises
both the `memory://` and `idb://` data directories. Its pinned PGlite peer is
installed from an isolated lockfile so the workspace's browser graph guards
keep their original dependency graph. The fixture serves the peer's published
ESM and WASM through an import map, so its Node-only runtime branches are never
executed in Chromium. The regular browser entry bundle check still runs
separately.

`@electric-sql/pglite` is the application's optional peer of
`@happyvertical/sql/pglite`, not core's code. Its Emscripten loader imports
`node:module`, `node:fs`, `zlib` and similar only behind runtime
`ENVIRONMENT_IS_NODE` checks, so the guards treat that one package (and its
subpaths) as an external boundary: `BROWSER_PEER_EXTERNALS` in the bundle-gate
build and `external` in `browser-entry-evaluation.mjs`. Both results therefore
do not depend on whether the workspace installs PGlite; the real package is
evaluated in Chromium by the `--pglite-cascade` run. Do not widen this to other
modules.

CommonJS runtime dependencies are bundled, not external (#4054). Consumers
that exclude smrt-core from Vite dependency pre-bundling (#3843) receive
`dist/*.js` as native browser ESM, where a bare import of a CommonJS package
fails (`does not provide an export named 'default'`). `pluralize` is
therefore not in `vite.config.ts` `external`; its converted module is emitted
under `dist/vendor/` (the `entryFileNames` rule maps any bundled
`node_modules/` module there, since npm never packs `dist/node_modules`), and
it is a devDependency. `pnpm test:browser` also runs
`scripts/browser-unbundled-dev.mjs`, which serves `dist/utils/naming.js`
unbundled from a real Vite dev server (no dependency discovery) and evaluates
it in Chromium. A new CommonJS runtime dependency on a browser-reachable path
follows the same rule.

## How a Node-only dependency stays out

The Node host exports synchronous query helpers from `@happyvertical/sql/query`.
Its existing asynchronous `getDatabase` seam imports the SQL factory on first
use, preserving the SDK's options, results and rejection. Importing the host
alone does not resolve the SQL root or its providers. Opening SQLite still
loads the installed SDK's public root, which statically imports `pg`; removing
that last provider requires an SDK lazy factory or public SQLite-only factory.
Do not reach into hashed SDK chunks to bypass the published boundary.

Never import it statically from a module the browser graph reaches. Pick one:

| Need | Use |
|---|---|
| `getDatabase`, `buildWhere`, `raw`, `NestedTransactionError`, the AI SDK, installed-package discovery | `src/host.ts`. `package.json#browser` maps `./dist/host.js` to `./dist/host.browser.js`; Node and every test resolve `host.ts`. |
| JSON parse/stringify | `src/utils/json.ts`; the browser build is `utils/json.browser.ts` (native `JSON`). |
| `node:fs`/`path`/`module` for manifest discovery | `src/manifest/node-host.ts`, which resolves them with `process.getBuiltinModule()`. No host answers "absent". |
| SHA-256 | `sha256Hex` (`src/utils/sha256.ts`, `@noble/hashes`). Not `node:crypto`. |
| Random ids | `globalThis.crypto.randomUUID()` / `getRandomValues()`. |
| Async-local state | `createAsyncContext()` (`src/utils/async-context.ts`). Check `propagatesAcrossAwait` before relying on the store. |
| A whole Node-only module (registry snapshot) | Keep it out of `system/browser.ts` and the browser entry. |

`browser.ts` and `host.browser.ts` are typed against their Node counterparts, so
the surfaces cannot drift. A new browser variant needs its source pair, an
`entries[...]` line in `vite.config.ts` (nothing imports it, so the build would
not emit it), and a `browser` mapping; `browser-field.test.ts` checks all three.

## Known limits

- The browser uses `getDatabase` from `@happyvertical/sql/pglite` and
  `buildWhere`, `raw`, and `NestedTransactionError` from the browser-safe
  `@happyvertical/sql/query` entry. It rejects non-PGlite engines.
- The AI SDK is unavailable in the browser build.
- The embedded write queue runs unqueued without async-local state; its only
  browser database, PGlite, serializes statements itself.
- `smrt-config`'s browser loader resolves to `{}`; use `setConfig()`.
- With bare-dependency discovery disabled, the whole browser entry still cannot
  evaluate: several modules
  depend on `@happyvertical/utils`, which imports CommonJS `pluralize` itself
  (#4534). Native core modules work with standard Vite dependency discovery;
  the SDK's bare dependencies still require Vite's normal optimization.

The native-dev harness retains its original naming/no-discovery fixture and adds
a separate public-root/registry/manifest fixture with normal Vite dependency
discovery. That fixture asserts there is no `process` global, constructs a public
object, performs optional manifest discovery, and proves strict registry errors
remain enabled. Browser-reachable environment reads use optional
`globalThis.process?.env` access; missing Node debug/test flags stay absent rather
than being simulated. Node flags remain live and retain their existing meanings.
Filesystem-only discovery still uses the existing Node-host capability guard.

Legacy STI discovery uses the same Node-host capability before resolving installed
or workspace package paths (#4766). Without a filesystem, uncached optional
dependencies remain absent; bundled/static/cached manifest entries still supply
the complete available STI field metadata. Required schema/registration lookups
keep their existing explicit errors rather than manufacturing missing metadata.
