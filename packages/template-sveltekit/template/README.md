# s-m-r-t SvelteKit starter

This is the small, ground-up starting point for s-m-r-t 0.43.10. It contains
one object and a profile-aware operational surface for local, self-hosted, and
managed-cloud environments. It does not provision external providers.

## 1. Install and run

Requirements: Node.js 26.0.0 or newer and pnpm 11.25.0. The exact pnpm version
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
`pnpm app:<operation>`. Every lifecycle script is a one-line call to
`smrt app <operation>` from `@happyvertical/smrt-cli`; the app ships no copied
operator scripts, so upgrading the CLI upgrades them.

`app:start` defaults adapter-node `ORIGIN` to its loopback HTTP URL (including
the selected `PORT`) and preserves an explicitly configured `ORIGIN`. Origin
changes invalidate the managed process configuration identity.

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

Do not edit generated files. The `smrt()` plugin in `vite.config.ts` owns
local scanning, manifests, types, routes, and the decorator transform. It
consumes exactly the packages listed in `smrt.config.ts` under
`consumer.packages` (profiles, tenancy, and users) so those models are
available to setup and tooling; add a SMRT package there when the app uses its
objects.

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

`src/hooks.server.ts` mounts the runtime configured in `src/lib/server/smrt.ts`
(`createSmrtSvelteKitRuntime()` from `@happyvertical/smrt-app-runtime/sveltekit`).
It keeps tenant selection separate from authorization:

1. A subdomain slug is looked up as an active Tenant UUID and stored only as a
   candidate in `locals.selectedTenantId` and `locals.selectedTenantSlug`.
2. That candidate does not enter AsyncLocalStorage and cannot scope queries.
3. The signed session is loaded. Its tenant is accepted only for an active (or
   legitimately inherited) membership, which establishes the authorized
   `locals.tenantId`, the permission set, and the tenant context.
4. The runtime enables tenancy, so `@TenantScoped` collections honor that
   context.

The default selector ignores `x-tenant-id`. To select tenants from a path,
signed cookie, or trusted gateway, pass `selectTenant` to
`createSmrtSvelteKitRuntime()`; selection must still never establish
authorization. Validate a gateway's identity/signature before mapping its
header to a tenant, and use `switchSessionTenant()` for browser session
changes. That helper checks active membership and rotates the session ID; never
copy an untrusted header directly into `locals.tenantId` or
`enterTenantContext()`.

`src/lib/server/smrt.ts` holds only the runtime and its options. The `smrt()`
plugin registers the generated objects before it runs, and each generated API
route imports this module and resolves collections through its exported
`runtime.getCollection()` (a `getCollection` export here would take precedence,
deprecated for one release, so do not add one). In the local profile
the runtime holds the single-writer lease (`acquireWriterLease: false` opts
out). `runtime.getCollection()` and `runtime.classOptions()` are
request-scoped (under `database-rls` isolation they carry the request
transaction): call them inside a request and never keep the result.

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
import { runtime } from '$lib/server/smrt';

await syncPermissionCatalog(runtime.classOptions('Permission'));
const roles = await RoleCollection.create(runtime.classOptions('Role'));
await roles.seedSystemRoles({ seedPermissions: true });
```

The home-page form action demonstrates the hand-written server boundary: it
passes the session's exact `locals.permissions` snapshot to
`assertOperationPermission()`. Keep that pattern for custom SvelteKit actions,
endpoints, jobs running as a principal, and other in-process writes.

Generated REST routes are authentication-gated and tenant-scoped, and their
writes (POST/PUT/DELETE and mutating custom actions) also require the
`<collection>.<action>` permission in the session's `locals.permissions`
snapshot, failing closed with 403. Local owner onboarding seeds the default
role matrix over the catalog; run the sync and seed above again after adding
objects so existing roles receive the new slugs. Reads are not permission-gated
beyond field read permissions, so keep sensitive reads behind app-owned handlers
or the framework's Postgres RLS setup.

## 7. Load data into a SvelteKit page

Initial data belongs in `+page.server.ts`, where it can use the database and
session context directly. Return plain serializable rows:

```ts
export const load: PageServerLoad = async ({ depends, locals }) => {
  depends('smrt:items');

  if (!locals.permissions.includes('items.read')) {
    return { items: [] };
  }

  const items = await runtime.getCollection<Item>('Item');
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

## Optional portable MCP Apps packaging

The ordinary scaffold does not create a plugin package or add a remote endpoint.
When you create a project with `smrt gnode create <name> --mcp-apps`, it adds
`mcp-apps/plugin.json` and `mcp-apps/mcp.json`. The initial server points only
at loopback (`http://127.0.0.1:3000/api/mcp`) so it cannot silently publish a
local instance. Run `pnpm mcp-apps:validate` in the generated application after
editing package metadata. It rejects symlinks, traversal paths, missing or linked UI assets (including screenshots),
non-object or malformed manifests, credential-shaped JSON fields and credential carrier files,
URL userinfo, non-portable schemas, and non-loopback HTTP server URLs. Diagnostics never
include malformed manifest content.

The option stages `src/routes/api/mcp/+server.ts`, one
`mountMcpAppRoute({ runtime, ... })` call from
`@happyvertical/smrt-app-mcp/sveltekit` that publishes `Item` to
principals holding `items.read` (the signed session's permissions locally),
refuses browser requests from a foreign `Origin`, and serves a bounded static
resource with a restrictive CSP and the optional OpenAI display metadata. It
also stages the protected-resource metadata route. For a view, mount
`McpAppsBridge` from `@happyvertical/smrt-svelte/mcp-apps` with an
application-configured trusted host origin.
The scaffold does not enable remote MCP tasks, so a deployment that adds them
must supply the durable worker's live authorization callback before publication.

Before changing that URL, mount the native SDK v2 Streamable HTTP endpoint and
configure the application gateway's verified principal, issuer, audience and
scopes. Plugin metadata is an install surface only; it neither authenticates a
request nor grants tenant or workflow authority. Register `.app.json` only
after the host creates an eligible server ID; do not copy runtime extension
metadata into the portable manifest.

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
  import { AppShell } from '@happyvertical/smrt-svelte/app';

  const webmcp = $derived(
    typeof document !== 'undefined' && 'modelContext' in document
      ? { definitions: webMcpToolDefinitions, basePath: '/api', effects: ['read'] as const }
      : false,
  );
</script>

<!-- AppShell passes `webmcp` to its Provider unchanged. -->
<AppShell title="s-m-r-t app" {webmcp} {nav}>
  {@render children()}
</AppShell>
```

The root layout is `AppShell` from `@happyvertical/smrt-svelte/app` (Provider,
theme and its CSS, the admin shell, and navigation); the app supplies its
navigation and content. `/setup` and `/settings` use the same package's
`OwnerSetupForm` and `ShellSettingsPage`.

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
the web process. Workers register the app's own objects from
`.smrt/runtime/register.js`, which `pnpm build` compiles, so a scheduled or
queued job may target objects in `src/lib/objects`; build before starting a
worker. A worker is a plain Node process: an object that imports a SvelteKit
virtual module (`$env/*`, `$app/*`) or a `.svelte` file cannot load there.
Logical export/import is manifest-driven JSON and refuses a non-empty target;
it orders parent tables first and defers nullable cycle edges until every row
exists. Export reads all model tables from one transaction snapshot. Every
schema-v2 export includes filesystem assets referenced by exported asset rows
through a bounded, provider-neutral manifest with byte lengths and SHA-256
digests. Import stages and verifies those assets before committing database
rows; legacy database-only schema-v1 bundles are rejected with a version error.
Every supported local web
entry point (`app:start` or `pnpm dev`) holds a shared writer lease. Direct
production startup must set an explicit loopback `HOST`, and `app:start` is the
recommended entry point. Stop the app before backup/import. For deployed import, stop
web/workers and set `SMRT_MAINTENANCE_MODE=true`. For domain-specific
transformations, add a `scripts/smrt-portability.mjs` adapter; when present it
replaces `smrt app export`/`import`'s built-in one.

### MCP authorization

In the `local` profile, the opt-in MCP route accepts two credentials. One is
the signed browser session. The other is an owner-minted bearer token for a
local MCP client such as Claude Desktop through `smrt-mcp-bridge`:

```bash
pnpm exec smrt app token --scopes items.read --label "Claude Desktop"
pnpm exec smrt app token list
pnpm exec smrt app token revoke <id>
```

The token is printed once and only its hash is stored. It is bound to the
owner and the owner's workspace. It expires after 30 days unless you pass
`--expires`, up to 365 days. It never carries a permission the owner no longer
holds. Point the bridge at `/api/mcp` with `<PREFIX>_SERVER_URL` and
`<PREFIX>_TOKEN`; see the `@happyvertical/smrt-app-cli` README.

For `self-hosted` and `cloud`, configure HTTPS `SMRT_MCP_RESOURCE`,
`SMRT_MCP_ISSUER`, `SMRT_MCP_JWKS_URI`, and space-separated
`SMRT_MCP_SCOPES` values. On every request, the runtime maps the verified
issuer and subject to the user linked through OIDC login. That user must have
exactly one active tenant membership. Disabled, unmapped, or multi-tenant
identities are denied. To use a different lookup, pass the route an explicit
`auth` built with `createHostedMcpResourceAuth({ ..., resolvePrincipal })`. The route never derives tenant authority from
JWT claims, request headers, or tool arguments. Missing configuration fails
closed before MCP dispatch.
