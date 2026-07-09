# @happyvertical/smrt-personas

Tenant-owned, context-scoped agent personas and their resolution. Layers over
`@happyvertical/smrt-agents`' `TenantAgent` availability/ceiling gate to decide
*how* an agent behaves for a given tenant and context (its `TenantAgent` binding
decides *whether* it runs and caps its capabilities).

This is the L2 layer of the "learning agents" epic (#1885): the persona foundation
(`AgentPersona` + `PersonaResolver`), the **persona learning & adaptation loop**
(#1889) — feedback → confidence-scored reinforcement → a scheduled reflection
runner that emits pending directive proposals → a permission-gated approval
surface that activates an approved rewrite as a tenant/persona-scoped prompt
override — and the persona-as-durable-instance / multi-instance helpers (#1890,
below). `ExecuteAsPrincipal` remains a separate issue (#1888).

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

- **Feedback** (`@TenantScoped({ mode: 'optional' })`, table `agent_feedback`):
  one reinforcement signal against a persona and the learning episode it judges.
  Human signals (`accept` / `reject` / `correction` / `rating`) and autonomous
  signals (`outcome` / `metric`) each carry a required **`correlationId`** (+
  optional `correlationType`) back to the AI call / dispatch / job. `scope` /
  `key` name the `LearningMemory` episode; `toLearningOutcome()` maps the signal
  onto a `LearningOutcome` (feeds reinforcement, #1886). `FeedbackCollection`:
  `forPersona`, `forScope`, `byCorrelation`.

- **DirectiveProposal** (`@TenantScoped({ mode: 'required' })`, table
  `directive_proposals`): a pending, human-reviewable proposed edit to a
  persona's `instructions`. Read-only generated surface (`api`/`cli`/`mcp` =
  `list`/`get`) — writes go through the gated approval service, not CRUD. Key
  fields: `promptKey`, `proposedInstructions`, `currentInstructions` (diff),
  `rationale`, `evidence` (JSON: episode + feedback ids), `status`
  (`pending`/`approved`/`rejected`/`superseded`), `fingerprint` (dedup so a
  rejected rewrite is never re-surfaced), `proposedBy`, `reviewedBy` /
  `reviewedAt` / `activatedOverrideId`. `DirectiveProposalCollection`:
  `pending(...)` (the review queue), `findByFingerprint(...)`.

## Learning loop (#1889)

- **Persona instructions via prompt overrides** (`persona-prompt.ts`): a
  persona's instructions apply through a per-persona registered prompt key
  (`persona.<id>.instructions`, neutral empty base template) plus a
  tenant-scoped `prompt_override`. Two personas of the same tenant/class resolve
  different instructions without colliding on the override `(key, context)`
  identity. `ensurePersonaInstructionsPrompt` (idempotent registration,
  `editable` configurable), `applyPersonaInstructions` /
  `upsertPromptTemplateOverride` (write the override — flows through
  `PromptOverride.save()` → `validatePromptOverride`, so a non-editable template
  is refused), `resolvePersonaInstructions`.
- **Memory scoping** (`persona-memory.ts`): `personaLearningMemory` routes a
  `LearningMemory` by the persona's `memoryScope` (used as `owner_id`), so
  personas learn independently. `reinforceFromFeedback` applies a `Feedback`
  signal to memory as automatic, confidence-only reinforcement (ungated).
- **ReflectionRunner** (`reflection-runner.ts`): a schedulable pass that, under
  the autonomous reflection principal (which **lacks**
  `personas.activate-directive`), reinforces recent feedback, consolidates
  episodes + feedback via an injected `reflect` boundary (the AI call, mocked in
  tests), and records a **pending** `DirectiveProposal` (deduped by fingerprint).
  It cannot activate anything.
- **The gate = a permission split** (`directive-principal.ts`,
  `directive-approval.ts`): activating a directive is the permissioned operation
  `personas.activate-directive` (contributed to the manifest permission catalog
  via `registerPermissionDefinitions`). `DirectiveApprovalService.approve` /
  `reject` first `assertCanActivate(principal)`; approval writes the
  persona-scoped override and records an `accept` signal, rejection records a
  `reject` signal and closes the proposal. A `DirectivePrincipal` is built from
  granted slugs (`principalFromPermissions`) or a `PermissionResolver`
  (`resolveDirectivePrincipal`).

## Svelte UI

`@happyvertical/smrt-personas/svelte` ships a minimal, presentational
`DirectiveReviewQueue` component (Svelte 5): it lists pending proposals with a
current-vs-proposed diff and Approve/Reject actions, delegating to `onApprove`
(optionally with reviewer-edited text) / `onReject` callbacks a host wires to
the gated `DirectiveApprovalService`. Built with `svelte-package`; Svelte tests
run in CI only.

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

## Persona as Durable Instance (#1890)

A persona is a **durable instance** of an agent class — N per tenant, each
independently scheduled, memory-scoped, and permission-scoped. `persona-instance.ts`
wires that to the `@happyvertical/smrt-agents` multi-instance primitives (which are
per-package opt-in via `static multiInstance`, singleton by default):

- **Identity** — `personaInstanceKey(persona)` returns the persona id, or `null`
  for the `default` persona (`DEFAULT_PERSONA_NAME`). A `null` key reuses the
  **singleton** runtime identity (class-keyed dispatch subscriber + un-suffixed
  memory scope). `agentOptionsForPersona(persona)` projects `{ instanceKey,
  tenantId }` to spread into the agent constructor.
- **Scheduling** — `schedulePersonaInstance(schedules, persona, { cron, … })`
  creates an `AgentSchedule` for the instance. The instance key rides in
  `agentConfig` (which the scheduler spreads into the agent constructor →
  `AgentOptions.instanceKey`); `agentId` is left **null** on purpose, because the
  scheduler copies `agentId`→`SmrtJob.objectId` and the `TaskRunner`
  `loadFromId()`s it against the agent's STI table — a persona id is not a row
  there. The default persona carries no key → runs the singleton.
- **Admin** — `buildPersonaInstanceAdmin(personas, { tenantId, agentClass,
  manifest })` renders the class's `uiSlots`/`adminRoutes` **once per instance**
  (with the per-instance dispatch subscriber); `addPersonaInstance()` /
  `removePersonaInstance(personaId)` are the add/remove affordances.
- **Non-destructive upgrade** — `upgradeSingletonToDefaultPersona(personas, {
  tenantId, agentClass, runAsUserId, … })` maps an existing singleton to a single
  `default` persona. It's null-keyed, so the running agent's dispatch subscriber,
  memory, and config are untouched; idempotent (a second call returns the
  existing default with `created: false` and never overwrites it).

## Dependencies

Leaf package (acyclic by construction — nothing depends back on it):

- Runtime: `@happyvertical/smrt-core`, `@happyvertical/smrt-tenancy`,
  `@happyvertical/smrt-agents` (the `TenantAgent` type it bridges, plus the
  `AgentSchedule`/multi-instance surface `persona-instance.ts` builds on),
  `@happyvertical/smrt-prompts` (persona instructions via `PromptOverride` +
  `resolvePrompt`), `@happyvertical/smrt-users` (the permission catalog slug +
  `PermissionResolver` principal), and `@happyvertical/sql` (`DatabaseInterface`
  type). These edges are all acyclic (none of those packages depend on personas).
- Svelte peer + `@happyvertical/smrt-ui` for the optional `./svelte` review-queue
  component.
- `runAsUserId` / `actsAsProfileId` reference `@happyvertical/smrt-users` and
  `@happyvertical/smrt-profiles` via `@crossPackageRef` string ids only. No
  inter-`smrt-*` `peerDependencies`.

## Gotchas

- **`conflictColumns` replaces the default `(slug, context)` unique index** — the
  unique key is `(tenant_id, agent_class, name)`, so same-named personas across
  tenants are allowed and tenant isolation is preserved.
- **`allowedTools` is text, not `type: 'json'`** — stored as a JSON string and
  read through the helpers, so it never auto-hydrates to an object.
- **Resolver runs outside strict tenant context** — it deliberately crosses
  tenants to walk the hierarchy.
- **The gate is the permission split, not a bespoke check** — the reflection
  principal simply lacks `personas.activate-directive`, so it can only propose;
  everything privileged in `DirectiveApprovalService` calls `assertCanActivate`
  first. Instruction rewrites are gated; confidence-only reinforcement is not.
- **Persona instructions live in the override layer, not the base prompt** — the
  per-persona prompt key registers a neutral empty template, so re-registration
  stays idempotent as instructions change; the tenant-scoped override carries the
  actual text. Activation still honours `validatePromptOverride` editability.
- **Directive dedup is by fingerprint across all statuses** — the runner skips a
  proposal whose `(personaId, promptKey, proposedInstructions)` fingerprint
  already exists (pending, approved, or rejected), so a rejected rewrite is never
  re-surfaced.
