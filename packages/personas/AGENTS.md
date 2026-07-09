# @happyvertical/smrt-personas

Tenant-owned, context-scoped agent personas and their resolution. Layers over
`@happyvertical/smrt-agents`' `TenantAgent` availability/ceiling gate to decide
*how* an agent behaves for a given tenant and context (its `TenantAgent` binding
decides *whether* it runs and caps its capabilities).

This is the L2 foundation of the "learning agents" epic (#1885). Foundation
only: `AgentPersona` + `PersonaResolver`. `ExecuteAsPrincipal`, feedback, the
reflection runner, and multi-instance routing are separate issues
(#1888/#1889/#1890).

## Models

- **AgentPersona** (`@TenantScoped({ mode: 'required' })`, table `agent_personas`):
  a behavioral profile for one agent class within one tenant. Many per
  `(tenant, agentClass)`; unique on `(tenant_id, agent_class, name)` via
  `conflictColumns`. Fields:
  - `agentClass` — canonical qualified agent type (e.g.
    `@happyvertical/smrt-agents:Praeco`); stored canonical so it lines up with
    `TenantAgent.agentClass`.
  - `name` — persona name, unique per `(tenant, agentClass)`.
  - `contextType` / `contextId` — optional scoping. No `contextType` = a
    tenant-wide default; `contextType` only = type-scoped; both = exact context.
  - `instructions` — system prompt layered onto the agent.
  - `allowedTools` — JSON array of tool ids stored as a string; use
    `getAllowedTools()` / `setAllowedTools()` (tolerant `try/catch` parse).
  - `runAsUserId` — `@crossPackageRef('@happyvertical/smrt-users:User')`, the
    principal the persona runs as.
  - `actsAsProfileId` — optional `@crossPackageRef('@happyvertical/smrt-profiles:Profile')`,
    a `Bot` identity for audit/attribution.
  - `memoryScope` — memory/reflection partition key (empty → resolver-derived).
  - `priority` — integer; higher wins among personas that apply at the same
    tenant level.
  - `enabled` — boolean; only enabled personas are resolved.

## Collection

`AgentPersonaCollection`:

- `byTenantAndClass(tenantId, agentClass)` — all personas for the pair
  (canonicalized), ordered by descending priority then name.
- `findActive(tenantId, agentClass, context?)` — enabled personas applicable to
  a context, same ordering.

## PersonaResolver

`resolve(tenantId, agentClass, context, options) → ResolvedPersona` layers,
bottom to top: **manifest defaults → `TenantAgent` gate/ceiling → AgentPersona**.

- **Hierarchy inheritance** mirrors `TenantAgentCollection.resolveForTenant`:
  walks the requesting tenant then its ancestors (`options.getAncestorIds`,
  nearest first). The nearest level with any applicable persona wins (a closer
  level shadows a farther one).
- **Selection within a level**: most context-specific first
  (exact > type-scoped > tenant-wide), then highest `priority`, then name.
- **Ceiling**: `options.availability` (a `PersonaAvailabilityGate`) gates
  availability and intersects the resolved `allowedTools`. Build one from a
  `ResolvedAgentAvailability` with `availabilityFromResolvedAgent()`.
- **Default fallback**: when no persona applies, returns a defined default
  (`source: 'default'`, `name: 'default'`) from manifest defaults + the gate.

Because the walk reads personas across tenants, `resolve()` is intended for a
system/admin path where cross-tenant reads are allowed — not inside a strict
per-tenant interceptor context (same expectation as `resolveForTenant`).

## Dependencies

Leaf package (acyclic by construction — nothing depends back on it):

- Runtime: `@happyvertical/smrt-core`, `@happyvertical/smrt-tenancy`,
  `@happyvertical/smrt-agents` (the `TenantAgent` type it bridges).
- `runAsUserId` / `actsAsProfileId` reference `@happyvertical/smrt-users` and
  `@happyvertical/smrt-profiles` via `@crossPackageRef` string ids only — no
  package edge (keeps the DAG minimal). No inter-`smrt-*` `peerDependencies`.

## Gotchas

- **`conflictColumns` replaces the default `(slug, context)` unique index** — the
  unique key is `(tenant_id, agent_class, name)`, so same-named personas across
  tenants are allowed and tenant isolation is preserved.
- **`allowedTools` is text, not `type: 'json'`** — stored as a JSON string and
  read through the helpers, so it never auto-hydrates to an object.
- **Resolver runs outside strict tenant context** — it deliberately crosses
  tenants to walk the hierarchy.
