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

The specs build from **dist** via package export maps (no workspace src
aliases), so run `pnpm build` for chat/personas/messages first; in CI turbo's
`test` task already depends on `^build`.

## Ownership and budget updates

The gate belongs to whoever changes chat/personas/messages/core/assets
package boundaries. Budget rules live in the spec header: if the gate fails
on FORBIDDEN modules, fix the import edge (never the budget); if it fails on
size after a legitimate feature, rerun, read the printed `[bundle-gate]`
report line, and set the budget to ~1.5–2× the new measured size in the same
PR with an explanation. Forbidden-module additions (new heavyweight provider
SDKs) go in `FORBIDDEN_PROVIDER_MODULES` with a comment.
