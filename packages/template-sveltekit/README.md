# @happyvertical/smrt-template-sveltekit

The minimal “learn and build from the ground up” SvelteKit template for
s-m-r-t 0.43.9. The package exports `copyTemplate()`, `getTemplatePath()`, and
`templateInfo` and is the `sveltekit` template used by `smrt gnode create`.

## 1. Install and run

Scaffold through the public CLI:

```bash
node --input-type=module -e "import { copyTemplate } from './packages/template-sveltekit/index.js'; copyTemplate('./my-app', { name: 'my-app' })"
cd my-app
pnpm install
cp .env.example .env
pnpm app:install
```

Run the copy command from the monorepo root. The public 0.43.9 CLI advertises
`gnode create`, but its command dispatcher currently rejects `gnode`; this
package's tested `copyTemplate()` export is the working scaffold path.

Generated projects require Node.js 24.18.0 or newer and pnpm 10.34.4. They pin
all directly used `@happyvertical/smrt-*` packages to 0.43.9.

For programmatic scaffolding:

```js
import { copyTemplate } from '@happyvertical/smrt-template-sveltekit';

copyTemplate('/absolute/path/to/my-app', {
  name: 'my-app',
  overwrite: false,
});
```

`copyTemplate()` turns an unscoped project name such as `my-app` into the
runtime-safe package identity `@smrt-app/my-app`; explicitly scoped package
names are preserved. It also excludes package-internal `.svelte-kit` and test
fixtures.

## 2. Understand the generated files

The checked-in template contains authored objects, hooks, server helpers,
pages, and configuration. Vite generates `.smrt/manifest.json`,
`.smrt/smrt-knowledge.json`, `.smrt/register.js`,
`src/lib/server/smrt-register.ts`, `src/lib/types/smrt-generated/`, and
`src/routes/api/**/+server.ts`. All are ignored and excluded from scaffold
fixtures.

`smrtPlugin()` scans the local object directory and generates local routes and
types. `smrtConsumer()` explicitly consumes the profiles, tenancy, and users
package manifests. `@happyvertical/smrt-cli` is a direct dev dependency because
the generated package scripts and README invoke its `smrt` binary.

## 3. Define the first object

The generated `src/lib/objects/Item.ts` is one optional-tenant object with
title, description, and status fields. Its small explicit `ItemCollection`
constructor keeps generated CLI/MCP runtime commands constructible. Its
`@smrt()` configuration exposes CRUD to REST, MCP, WebMCP definitions, and CLI
while using an API writable allowlist.

Add objects beside Item and export them from `src/lib/objects/index.ts`.
`vite.config.ts` already scans that directory.

## 4. Initialize or migrate the database

Generated local projects use SQLite in the current user's operating-system
application-data directory by default:

```bash
pnpm db:migrate
```

The script builds first to refresh manifests, registrations, types, and API
routes, then runs `smrt db:migrate`. The deprecated `smrt db:setup` command is
not documented or shipped.

## 5. Understand tenant context

The template resolves a URL tenant candidate into separate
`selectedTenantId`/`selectedTenantSlug` locals. It does not establish query
context from that selection. The session hook runs afterward and only its
membership-authorized tenant enters the s-m-r-t tenancy context.

Untrusted tenant headers are ignored. Applications may replace
`src/lib/server/tenancy.ts` with a path, signed-cookie, or trusted-gateway
selector, but selection must remain separate from authorization and session
switches must use `switchSessionTenant()`.

## 6. Understand users, profiles, memberships, roles, and permissions

The generated project consumes the current profiles and users manifests and
wires `createSessionHandler({ enterTenantContext: true })`. A User is the auth
identity, Profile is person-facing metadata, Membership joins a User to a
Tenant and Role, Role maps to Permission records, and Session publishes the
resolved permission snapshot.

The home-page form action calls `assertOperationPermission()` with that exact
snapshot. Provider-specific login and provisioning remain app-owned extension
points.

## 7. Load data into a SvelteKit page

The home page loads Item rows in `+page.server.ts`, returns plain serialized
data, and declares `depends('smrt:items')`. The Svelte 5 page reads hydrated
`$props()` data and calls `invalidate('smrt:items')` after a successful form
mutation. It does not fetch initial data in `onMount` or `$effect`.

## 8. Use generated REST, MCP, WebMCP, and CLI interfaces

REST routes are generated under `src/routes/api`. MCP and WebMCP descriptors
come from the same action metadata. CLI commands are available through the
declared dev dependency:

```bash
pnpm smrt objects
pnpm smrt schema Item
pnpm smrt generate-mcp --no-config --no-readme
```

The root layout wires the generated `webMcpToolDefinitions` into the Provider,
so each browser page exposes only read-effect generated model tools by default.
Write and destructive effects require explicit page-owned opt-in, and all
custom actions execute through their authenticated generated REST routes. For a
smaller page-specific surface, pass a filtered `definitions` array or use the
framework-agnostic `registerWebMcpTools()` API from `@happyvertical/smrt-web`.
The CLI's manifest-only `objects` and `schema` commands work in this
source-first template. Local-object CRUD execution through the generic CLI
additionally requires a compiled JavaScript project entry point.

## 9. Add optional live browser data

`@happyvertical/smrt-web` is included on the synchronized release line because
the root Provider loads the generated WebMCP definitions. No separate install
is needed for WebMCP. Live browser collections remain opt-in per page; import
the collection helpers only on pages that need interactive client data.

The generated-project README shows the current hydration pattern:
`createSmrtCollection(getCollectionDefinition('items'), { initialData,
basePath: '/api' })` followed by `liveCollection()`. The root layout's
read-only WebMCP registration does not materialize live collections.

## 10. Graduate to smrt-saas-starter

Use this template for learning and focused, ground-up applications. Choose
`smrt-saas-starter` when the baseline should already contain production-shaped
onboarding, billing/subscriptions, workers, provider configuration, deployment
infrastructure, and mobile applications. This package intentionally avoids
becoming a second SaaS starter.

The generated project has one canonical `runtime.profile` and deterministic
`app:*` operations. Local state stays outside source. The production baseline
uses adapter-node and includes a container plus separate task/schedule workers;
Compose requires operator-supplied database secrets, and cloud examples
describe provider composition without pretending to provision it.

Every local web entry point (`app:start`, `pnpm dev`, and direct `node build`)
shares one writer lease outside the source checkout. Filesystem backup and
logical import fail closed while a writer is alive; logical export reads every
model table from one transaction snapshot. The production image retains the
generated manifest and operator CLI required by doctor/export/import.
