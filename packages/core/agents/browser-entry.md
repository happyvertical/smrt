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
- The whole browser entry does not yet evaluate unbundled: several modules
  read `process.env` at module scope, and `@happyvertical/utils` imports
  CommonJS `pluralize` itself (#4534).
