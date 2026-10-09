# @happyvertical/smrt-bundle-gate

Private (unpublished) consumer bundle reachability and size regression gate
(#1978/#1980). Rebuilds the downstream SvelteKit-consumer viewpoint — SSR
`vite build` with `ssr.noExternal: true` over the **dist** surface of
chat/personas/messages — and fails CI when messaging-provider SDKs become
reachable from provider-neutral imports or when output exceeds the size
budget.

## What it protects

The 0.39.7 regression: `smrt-chat → smrt-personas → smrt-messages` made
googleapis/nodemailer/@slack/web-api (via the `@happyvertical/email`,
`@happyvertical/messages`, and `@happyvertical/files` SDK wrappers) reachable
from ordinary chat consumers, growing a downstream server build from ~18 MB to
~109 MB and exhausting a 4 GB Node heap. Bundlers follow statically-analyzable
dynamic imports, and SvelteKit production server builds bundle every
dependency not listed in `ssr.external` — "lazy at runtime" is not "absent
from the bundle".

## How it works

`src/__tests__/consumer-boundary.spec.ts`:

- **Neutral fixture** (`fixtures/consumer-neutral.ts`) imports the three
  package roots — what app code and the smrtConsumer-generated
  `.smrt/register.js` import. A `resolveId` guard records every attempted
  resolution of a forbidden provider module with its importer, then
  externalizes it, so a regression reports **all** offending edges without
  bundling ~200 MB of SDK code. Assertions: zero forbidden resolutions, zero
  forbidden modules in emitted chunks, output within the size budgets.
- **Explicit fixture** (`fixtures/consumer-with-providers.ts`) imports
  `@happyvertical/smrt-messages/providers/all` and asserts the SDK wrappers
  ARE reachable again — providers stay available to consumers that opt in.

`src/__tests__/registry-identity.spec.ts` bundles and executes a fresh Node
consumer of `smrt-core` and `smrt-fields`. It protects provider ownership,
manifest fields, collection resolution, and storage table identity when Rollup
flattens or renames provider constructors. Keep the behavioral assertions for
qualified same-name coexistence, renamed constructors, fresh-database empty
listing, and provider-manifest non-adoption of consumer classes.

`src/__tests__/consumer-same-name.spec.ts` bundles an app entry that declares
its own `LicenseSale` next to an external smrt-commerce (both load orders) and
asserts neither class adopts the other's registration or table (#3106).

The specs build from **dist** via package export maps (no workspace src
aliases), so run `pnpm build` for chat/personas/messages/commerce first; in CI turbo's
`test` task already depends on `^build`.

## Browser fixture (#3621)

`src/__tests__/browser-boundary.spec.ts` builds each model package root (every
publishable package with `@smrt()` classes, plus core; derived by
`src/browser-gate/boundary.ts`) with Vite browser conditions over `dist`, and
fails when `node:` built-ins, `pg`, `express`, `cosmiconfig`, `jiti`, native
addons, or other `FORBIDDEN_NODE_ONLY_MODULES` are reachable, printing the
importer chain. Failures are attributed to the package that owns the fix.
Known violations are in `src/browser-gate/expected-failures.ts` with issue
numbers; the gate fails on unexpected breakage AND stale entries, so a fix PR
removes its own entry. Never add an entry without a tracking issue. See README.

## Browser capability table (#3709)

`src/browser-gate/capability.ts` derives a per-package capability from the
expected-failures list and each package's `dependencies`: `server-only` when the
package or a workspace package it depends on (transitively; `smrt-core` is the
platform baseline and does not propagate) is listed, else `browser-safe`. It is
generated into `packages/core/src/manifest/browser-capability.generated.ts`,
which every manifest build reads to emit `browser` and each recipe's `demo`
(see core `agents/recipes.md`). `browser-capability.spec.ts` fails when that file
is stale and needs no bundle. After editing `expected-failures.ts` (a fix PR
deleting its entry flips dependents too) or a model package's dependencies:

```bash
UPDATE_BROWSER_CAPABILITY=1 pnpm --filter @happyvertical/smrt-bundle-gate test
```

then rebuild core. Never hand-edit the generated file.

## Ownership and budget updates

The gate belongs to whoever changes chat/personas/messages/core/assets
package boundaries. Budget rules live in the spec header: if the gate fails
on FORBIDDEN modules, fix the import edge (never the budget); if it fails on
size after a legitimate feature, rerun, read the printed `[bundle-gate]`
report line, and set the budget to ~1.5–2× the new measured size in the same
PR with an explanation. Forbidden-module additions (new heavyweight provider
SDKs) go in `FORBIDDEN_PROVIDER_MODULES` with a comment.
