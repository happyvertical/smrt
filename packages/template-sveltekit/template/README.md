# s-m-r-t SvelteKit starter

This is the small, ground-up starting point for s-m-r-t 0.43.10. It contains
one object and a profile-aware operational surface for local, self-hosted, and
managed-cloud environments. It does not provision external providers.

## 1. Install and run

Requirements: Node.js 24.18.0 or newer and pnpm 10.34.4. The exact pnpm version
is declared in `packageManager`.

```bash
pnpm install
cp .env.example .env
pnpm app:install
```

`app:install` validates the canonical profile, builds, migrates, initializes
the secure local owner invitation, starts the production Node build on
loopback, and opens that single-use invitation. Stop a running local app before
re-running install, setup, or recovery; each operation is repeatable from that
stopped state. `pnpm app:doctor`
prints secret-free JSON diagnostics and recovery steps. Individual
setup/start/doctor/open/stop/backup/export/import operations are available as
`pnpm app:<operation>`.

`app:install`, `app:start`, `app:stop`, and `app:recover` are local-profile
operations. Self-hosted and cloud web processes run the production Node build
or container directly; workers use the separate worker commands below.

If installation is interrupted after the invitation is created, rerun
`pnpm app:start` and `pnpm app:open`; the private state directory retains the
loopback handoff without printing its token. If that invitation expired or was
lost, run `pnpm app:stop`, then `pnpm app:recover`, start, and open again.
Recovery rotates only an
unclaimed invitation and cannot replace an existing owner.

`pnpm db:migrate` first runs the Vite build so the manifest, runtime
registration, generated routes, and types match the current objects; it then
holds the shared application-operation lock while it applies the
manifest-derived schema to SQLite. Re-run it after object changes.

## 2. Understand the generated files

The source of truth is `src/lib/objects`. Running `pnpm dev`, `pnpm build`, or
`pnpm db:migrate` regenerates these artifacts:

| Path | Purpose | Commit it? |
| --- | --- | --- |
| `.smrt/manifest.json` | Merged local and dependency runtime manifest | No |
| `.smrt/smrt-knowledge.json` | Agent/developer knowledge graph | No |
| `.smrt/register.js` | External package registration used by the CLI | No |
| `src/lib/server/smrt-register.ts` | Local runtime class registration | No |
| `src/lib/types/smrt-generated/` | Virtual-module and consumer declarations | No |
| `src/routes/api/**/+server.ts` | Generated SvelteKit REST routes | No |

Do not edit generated files. `smrtPlugin()` owns local scanning, manifests,
types, and routes. `smrtConsumer()` explicitly consumes the profiles, tenancy,
and users manifests so those models are available to setup and tooling.

## 3. Define the first object

`src/lib/objects/Item.ts` is the only example. It exposes the same CRUD action
set to REST, MCP, WebMCP definitions, and the CLI, while limiting writable REST
fields and opting into tenant scoping:

```ts
import {
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'delete'],
    writable: ['title', 'description', 'status'],
  },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
@TenantScoped({ mode: 'optional' })
export class Item extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  title: string = '';
  description: string = '';
  status: string = 'draft';
}

export class ItemCollection extends SmrtCollection<Item> {
  static readonly _itemClass = Item;
}

ObjectRegistry.registerCollection('Item', ItemCollection);
```

Add another class beside it and export the class from
`src/lib/objects/index.ts`. Keep relationship decorators next to `@smrt()`.
Use `@foreignKey(Target)` for same-package relationships and
`@crossPackageRef()` for relationships to another package. Keep the explicit
collection constructor/registration when the generated CLI or MCP runtime must
construct the collection outside a SvelteKit request.

## 4. Initialize or migrate the database

The canonical `runtime.profile` in `smrt.config.ts` defaults to `local`. Local
SQLite, assets, secrets, backups, exports, and PID state live in the current
user's operating-system data/state directories, outside this checkout.
`SMRT_DATA_DIR` is rejected when it overlaps source.

```bash
pnpm db:migrate
```

The current command is `smrt db:migrate`; deprecated `smrt db:setup` is
intentionally not used. Migrations are manifest-driven: change
the TypeScript object, regenerate the manifest, and run the migration again.
There are no hand-written migration files in this workflow.

Runtime schema creation is disabled. A missing table should be fixed by the
migration command, not by adding schema creation to a request handler.

## 5. Understand tenant context

`src/hooks.server.ts` keeps tenant selection separate from authorization:

1. `src/lib/server/tenancy.ts` reads a subdomain slug and looks up an active
   Tenant UUID. It stores the candidate in `locals.selectedTenantId` and
   `locals.selectedTenantSlug`.
2. That candidate does not enter AsyncLocalStorage and cannot scope queries.
3. `createSessionHandler({ enterTenantContext: true })` loads the signed session,
   resolves its membership and permissions, and establishes the authorized
   `locals.tenantId` context.
4. `enableTenancy()` makes `@TenantScoped` collections honor that context.

The default resolver ignores `x-tenant-id`. If a gateway supplies a tenant
header, validate the gateway identity/signature before mapping it to a tenant,
and still use `switchSessionTenant()` for browser session changes. That helper
checks active membership and rotates the session ID; never copy an untrusted
header directly into `locals.tenantId` or `enterTenantContext()`.

Set `TENANT_BASE_DOMAIN` for deployed subdomain routing. The fallback parser is
only for local shapes such as `acme.demo.local`.

## 6. Understand users, profiles, memberships, roles, and permissions

These are separate records with separate responsibilities:

- User is the authentication identity.
- Profile is person-facing identity and metadata; a User may reference one.
- Tenant is an organization/security boundary.
- Membership connects one User to one Tenant and one Role.
- Role receives Permission records through RolePermission.
- Session binds the authenticated user to an active tenant and publishes the
  resolved permission set for the request.

CRUD permissions are manifest-derived: `items.read`, `items.create`,
`items.update`, and `items.delete`. Provisioning code should sync the catalog
and seed roles after the database migration:

```ts
import {
  RoleCollection,
  syncPermissionCatalog,
} from '@happyvertical/smrt-users';
import { getSmrtConfig } from '$lib/server/smrt';

await syncPermissionCatalog(getSmrtConfig('Permission'));
const roles = await RoleCollection.create(getSmrtConfig('Role'));
await roles.seedSystemRoles({ seedPermissions: true });
```

The home-page form action demonstrates the hand-written server boundary: it
passes the session's exact `locals.permissions` snapshot to
`assertOperationPermission()`. Keep that pattern for custom SvelteKit actions,
endpoints, jobs running as a principal, and other in-process writes.

Generated REST routes are authentication-gated and tenant-scoped. On SQLite,
authentication is not a substitute for your app's operation policy. Put
permission-checked mutations behind app-owned handlers, or use the framework's
Postgres RLS setup when moving to a production database.

## 7. Load data into a SvelteKit page

Initial data belongs in `+page.server.ts`, where it can use the database and
session context directly. Return plain serializable rows:

```ts
export const load: PageServerLoad = async ({ depends, locals }) => {
  depends('smrt:items');

  if (!locals.permissions.includes('items.read')) {
    return { items: [] };
  }

  const items = await getCollection<Item>('Item');
  const rows = await items.list({ limit: 50 });
  return {
    items: rows.flatMap((item) =>
      item.id ? [{ id: item.id, title: item.title, status: item.status }] : [],
    ),
  };
};
```

The page receives that data through `$props()`. Do not fetch initial page data
from `onMount` or `$effect`; SvelteKit already serialized it into the response.
After a mutation, call `invalidate('smrt:items')`. Only loads that declared
`depends('smrt:items')` re-run.

## 8. Use generated REST, MCP, WebMCP, and CLI interfaces

The Item configuration generates:

- REST: `GET`/`POST /api/items` and
  `GET`/`PUT`/`DELETE /api/items/[id]`.
- MCP descriptors and tools for Item CRUD.
- Web collection definitions in the virtual
  `@happyvertical/smrt-virt-web` module.
- CLI commands for Item CRUD.

Inspect the registered objects and use the example CLI:

```bash
pnpm smrt objects
pnpm smrt schema Item
```

The CLI's manifest-only `objects` and `schema` commands work directly in this
source-first template. Executing local-object CRUD through the generic
CLI additionally requires a compiled JavaScript project entry point; REST and
the page action are the runnable CRUD examples here.

Generate a standalone MCP server when you are ready to configure a transport:

```bash
pnpm smrt generate-mcp --no-config --no-readme
```

The output is `.smrt/mcp-server/index.js`. It is generated and ignored. Run it
with:

```bash
node .smrt/mcp-server/index.js
```

The generated entry resolves its imports from this project, not from the CLI,
so every module it imports must be a dependency here.
`@modelcontextprotocol/server`, `@happyvertical/smrt-core`,
`@happyvertical/smrt-config`, `@happyvertical/smrt-jobs`, and
`@happyvertical/smrt-tenancy` are already declared for the default runtime and
worker surfaces.

Missing a dependency added by a custom MCP extension fails at startup with
`ERR_MODULE_NOT_FOUND` naming the package to declare.

WebMCP is wired at the root Provider as a read-only, authenticated browser
surface. The template includes `@happyvertical/smrt-web` on the synchronized
release line; keep the generated definitions page-owned when you need a
narrower tool set.

```svelte
<script lang="ts">
  import { webMcpToolDefinitions } from '@happyvertical/smrt-virt-web';
  import { Provider } from '@happyvertical/smrt-svelte';

  const webmcp = $derived(
    typeof document !== 'undefined' && 'modelContext' in document
      ? { definitions: webMcpToolDefinitions, basePath: '/api', effects: ['read'] as const }
      : false,
  );
</script>

<Provider {webmcp}>
  {@render children()}
</Provider>
```

`registerWebMcpTools()` feature-detects browser support and uses the current
authenticated page session. Omitted policy exposes all `read`-effect tools:
intrinsic `list`/`get` plus custom actions explicitly declared as reads. To
advertise mutations on a trusted surface, pass an explicit effect allowlist, for
example `effects: ['read', 'write']`; include `destructive` only where delete and
destructive custom actions are intended. Generated custom actions execute
through their authenticated REST routes, and undeclared custom effects fail
closed as destructive.

## 9. Add optional live browser data

Use this only on an interactive page. The template already includes
`@happyvertical/smrt-web` for the root Provider; no separate install is needed
for WebMCP. Live browser collections remain opt-in per page.

Keep the server load from section 7, then seed the browser collection from its
hydrated rows so the first render does not issue a duplicate request:

```svelte
<script lang="ts">
  import { createSmrtCollection } from '@happyvertical/smrt-web';
  import { liveCollection } from '@happyvertical/smrt-svelte/web';
  import { getCollectionDefinition } from '@happyvertical/smrt-virt-web';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const items = createSmrtCollection(getCollectionDefinition('items'), {
    basePath: '/api',
    initialData: data.items,
    staleTimeMs: 30_000,
  });
  const view = liveCollection(items);
</script>

{#each view.rows as item (item.id)}
  <p>{item.title}</p>
{/each}
```

Import the live runtime only from routes that use it. Static pages and the root
layout should keep using server loads and should not pay for browser data tools.

## 10. Graduate to smrt-saas-starter

Stay here while you are learning the object model or building a focused app
from first principles. Move to `smrt-saas-starter` when you want a
production-shaped SaaS baseline with onboarding, billing/subscriptions,
background workers, provider configuration, deployment conventions, and
mobile surfaces. Those concerns are intentionally absent here.

## Runtime profiles and deployment

- `local`: SQLite, loopback single-use owner bootstrap, user-owned files, and
  embedded/on-demand jobs.
- `self-hosted`: PostgreSQL, public authentication, operator providers, and
  separate workers. Copy `.env.self-hosted.example` to `.env.self-hosted` for
  the service configuration. Separately create the ignored plain `.env` file
  with `DATABASE_URL` and `POSTGRES_PASSWORD` for Compose interpolation, then
  use Compose. Compose refuses to start when either secret is absent. Configure
  installed authentication, asset, and secret readiness modules; each module
  must probe its real provider before web or workers can start.
- `cloud`: hosted identity, managed providers, required tenant context, and
  scalable workers. `.env.cloud.example` records the composition boundary.

The adapter-node `Dockerfile` and `compose.yaml` provide the production path.
Compose gates the web and both workers on the one-shot, idempotent migration
service. The runtime image retains the generated manifest and operator CLI for
doctor/export/import. `pnpm worker` and `pnpm worker:schedule` are separate from
the web process.
Logical export/import is manifest-driven JSON and refuses a non-empty target;
it orders parent tables first and defers nullable cycle edges until every row
exists. Export reads all model tables from one transaction snapshot. Every
export report explicitly records that uploaded assets are excluded; copy the
assets directory separately when moving profiles. Every supported local web
entry point (`app:start` or `pnpm dev`) holds a shared writer lease. Direct
production startup must set an explicit loopback `HOST`, and `app:start` is the
recommended entry point. Stop the app before backup/import. For deployed import, stop
web/workers and set `SMRT_MAINTENANCE_MODE=true`. Extend
`scripts/smrt-portability.mjs` for domain-specific transformations.
