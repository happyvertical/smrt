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
