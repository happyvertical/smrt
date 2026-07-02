# template-sveltekit

Base SvelteKit project template used by `smrt init`. Scaffolds a full-stack, multi-tenant app with SMRT integration.

## Exports

- `getTemplatePath()` — returns path to template directory
- `copyTemplate(destination, options)` — copies template files with project name substitution. Skips internal-only directories (e.g. `.svelte-kit/` tsconfig stub).
- `templateInfo` — metadata (SvelteKit 2.x, Svelte 5, REST API, SMRT CLI, SQLite, multi-tenant)

## Template Contents

- `template/src/hooks.server.ts` — pre-wires `enableTenancy()`, `createSessionHandler({ enterTenantContext: true })`, and a subdomain → tenantId handle, sequenced in that order
- `template/src/lib/server/tenancy.ts` — pluggable tenant resolver (`subdomainStrategy`, `pathPrefixStrategy`, `headerStrategy`, `createTenantResolver`)
- `template/src/lib/server/smrt.ts` — centralized SmrtClassOptions / collection factory
- `template/src/lib/objects/Item.ts` — example `@smrt()` object
- `template/src/routes/+page.server.ts` + `+page.svelte` — reference SSR data loading: server load queries collections directly (opt-in read cache via `cache: { ttl }`), declares `depends('smrt:items')`, and a form action + `invalidate('smrt:items')` demonstrates post-mutation refresh
- `template/src/app.d.ts` — `App.Locals` extends `SessionLocals` from `@happyvertical/smrt-users/sveltekit`

## Test Infrastructure

- Tests live in `__tests__/` at the package root — **not** inside `template/` — because `cpSync` would otherwise scaffold them into consumer projects.
- The template's `template/tsconfig.json` extends `./.svelte-kit/tsconfig.json` (per SvelteKit convention). To let the package run its tests without first running `svelte-kit sync`, a vitest `globalSetup` hook at `__tests__/setup/svelte-kit-stub.ts` writes a minimal stub at test startup and removes it at teardown. The stub directory is gitignored AND `copyTemplate()` filters it out as defense-in-depth.

## Key Patterns

- **SSR data loading convention**: reference pages load collection data in `+page.server.ts` (serialized into the HTML, hydrated without a duplicate client fetch). Loads declare `depends('smrt:<collection>')` (REST route segment naming: `/api/items` → `smrt:items`); mutations call `invalidate('smrt:<collection>')` to re-run them.
- **Pluggable tenant resolver**: `tenancy.ts` exports strategy functions + a `createTenantResolver()` factory. Consumers swap strategies by editing one line.
- **File copying with placeholder substitution**: project name is replaced in template files during generation.
- **No template-internal test pollution**: `__tests__/` and the `.svelte-kit/` stub are package-level and excluded from `copyTemplate` output.
