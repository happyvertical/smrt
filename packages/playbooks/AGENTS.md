# smrt-playbooks

Layered playbook registry, app/tenant overrides, and plan resolution. A
playbook is a named, described, layered sequence of steps an agent follows;
browser agents, in-app agents, the Node MCP server, and the CLI all follow the
same resolved plan. Fourth instance of the `smrt-prompts` layered-override
pattern — keep it consistent with `prompts`, `languages`, and `features`.

## Core pieces

- `definePlaybook()` registers code defaults in a global process registry
  (`globalThis.__smrtPlaybookRegistry`), so a package-bundled playbook resolves
  with no application registration
- `resolvePlaybook()` merges the layers and returns a `PlaybookResolution`
- `PlaybookOverride` (`_smrt_playbook_overrides`) stores partial app-level and
  tenant-level overrides with write-time validation
- `PlaybookOverrideCollection` exposes the standard SmrtCollection CRUD surface

## Resolution layers (priority low → high)

1. Code default — `definePlaybook({ key, title, description, steps })`
2. File/config override — `getPackageConfig<PlaybookPackageConfig>('playbooks', defaults)`
3. App-level stored override — `PlaybookOverride` row with `tenantId = null`
4. Tenant-level stored override — `PlaybookOverride` row with the current tenant
5. Runtime override — passed to `resolvePlaybook(key, { override })`

Inheritance is field-by-field: a stored column is nullable, and `null` means
"use the lower layer".

## Script semantics

A playbook resolves to a plan the agent executes step by step. **It never
executes as a unit** (epic #2585 invariant 4), so it is never an authority
boundary and adds no new security object to review. Each step is authorized
independently — at the REST boundary in the browser, or by
`PrincipalRun.assertToolAllowed()` server-side. Nothing in this package
executes a step, and there is deliberately no executor export.

Playbooks are consequently never atomic and have no compensation.
`onStepFailure` (`'abort'` | `'continue'`) is the whole of the contract for
what an agent does when step 3 of 5 fails.

## Steps

Exactly two kinds in v1, and playbooks cannot nest:

- `{ kind: 'operation', model: '@happyvertical/smrt-commerce:Order', action: 'submit' }`
  — the qualified pair already used by STI discriminators and
  `@crossPackageRef`. **Never a generated tool name**: that is derived from
  model, action, and namespace, and would silently orphan stored tenant
  overrides on a namespace change.
- `{ kind: 'intent', id }` — a view intent named by its declared #2588
  identity. Valid only where a surface is mounted.

A step referencing another playbook is rejected in `normalizeSteps()` at
definition time.

### Classification is inherited, never self-declared

A step never classifies itself. `resolvePlaybook()` takes a
`classifier` (and, for intents, an `intents` registry) supplied by the host,
which returns the `CapabilityDeclaration` emitted for the referenced operation
by `@happyvertical/smrt-types`. Anything undeclared resolves fail-closed to
`{ effect: 'destructive', idempotent: false, openWorld: true }`. The
vocabulary itself is older and lower and shared with model tools — it lives in
`smrt-types`, not here (owning it here would close a
core → playbooks → core cycle).

## Plane validity

A playbook declares `planes: readonly ('browser' | 'server')[]`. Resolution for
a caller on an undeclared plane fails closed with reason
`'plane-not-declared'`.

- Operation-only playbooks default to both planes.
- A playbook containing a view-intent step defaults to `['browser']`. Server
  validity rides the shipped #2446 browser command/ack bridge, which lets a
  server-side agent drive mounted surfaces with acknowledgement — it must be
  **declared explicitly**, never assumed.
- The same default applies one level down: a `PlaybookIntentRecord` that
  declares no `planes` is browser-only, so server validity must be declared at
  **both** the playbook and the intent. Silence from the intent registry never
  widens a plane (`'intent-plane-not-declared'`).

The `#2588` intent registry does not exist yet, so an intent step with no
`intents` resolver supplied fails closed with
`'intent-registry-unavailable'`. That resolver is the seam #2588 wires into.

## Editability

`editable` defaults **all-false**, matching `normalizeEditableConfig` in
`smrt-prompts`. Every stored column has a flag — `title`, `description`,
`planes`, `onStepFailure`, `enabled`, `metadata` — and `save()` rejects a
non-null value for any field the definition has not opted in. `onStepFailure`
is gated like the rest: flipping a locked playbook from `'abort'` to
`'continue'` would change what an agent does after a failed prerequisite.

`steps` is **structurally** non-editable, not merely defaulted false:

- `PlaybookEditableConfig` has no `steps` key, and marking one throws at
  definition time
- `_smrt_playbook_overrides` has **no `steps` column**, so no write of any kind
  has anywhere to put a step list
- `PlaybookOverride.save()` rejects a `steps` property assigned through the
  untyped option bag rather than dropping it silently
- `normalizePlaybookLayer()` throws on a `steps` key from the config or runtime
  layer
- the resolver reads steps only from `PlaybookRegistry`

The reason is not escalation — under the script model a tenant cannot escalate,
since every step is authorized independently regardless of who wrote the list.
It is that an agent announcing "checking out your cart" while an overridden
step list does something else is a description-behavior mismatch.

Enablement overrides are one-directional: a layer may disable, never re-enable
what a lower layer disabled. Enforced in `mergePlaybookLayers()` (`enabled &&
layer.enabled`) and rejected at `save()` with a specific message. Plane lists
narrow the same way.

## Preflight (#2590)

`preflightPlaybook({ key, plane, principal, resolve, evaluate })` resolves a
playbook through the **caller's own layer chain**, decomposes it, and returns a
per-step verdict — `allow` | `deny` | `unknown` — plus an aggregate. It executes
nothing.

**Advisory only. Preflight predicts; it never grants.** Every step re-enforces at
execution, unconditionally. Without that, a permission revoked mid-playbook would
leave a cached "allowed" standing — a time-of-check/time-of-use bypass. That
constraint is also what makes the cache free: a stale `allow` costs a
correctly-denied step, a stale `deny` costs a briefly hidden capability that
expires on the TTL, and neither is a security event.

The two planes are **not symmetric**, deliberately:

| | Server (`createServerStepEvaluator`) | Browser (`createBrowserStepEvaluator`) |
|---|---|---|
| Layers | `tool-allowlist`, `operation-permission` | `action-exposure`, `public-access`, `field-permissions`, `app-auth` |
| Source | `PrincipalRun.isToolAllowed` + the operation-permission predicate | `isApiActionEnabled`, `isRoutePublic`, field read-permission slugs |
| Intent step | `plane` — denied unless the intent declares `server` | `intent-mount` — always `unknown` |
| App auth | n/a (the predicate *is* the gate) | **`unknown`** — never evaluated |

Browser preflight covers the **static layers only**. Generated REST auth is
`authMiddleware?: (objectName, action) => (req) => Promise<Request | Response>`:
request-bound, `Response`-returning rather than boolean, and free to consult
session stores, rate-limit, or audit. It is not a dry-run predicate, so preflight
**never invokes it**, synthetically or otherwise — the `_preflight` route's
options in `smrt-core` carry no auth handle at all, only the boolean
`appAuthConfigured`. An optional `authPredicate` seam can later be added to
`BrowserPreflightLayerSource` and turn the `app-auth` `unknown` into a real
verdict **without changing the report contract**.

`createBrowserPlaybookPreflight()` (in `rest-preflight.ts`) is the provider wired
into `APIConfig.playbookPreflight`. Core owns the route and the static-layer
facts because `ObjectRegistry` is core's; this package owns resolution and the
verdict vocabulary — so the dependency stays one-way.

### Not an oracle

Every playbook the caller's chain cannot resolve — unknown key, disabled,
wrong-plane, unresolvable intent, or an error thrown anywhere in resolution or
evaluation — returns the single frozen `PLAYBOOK_PREFLIGHT_UNAVAILABLE` value: no
key echo, no reason, no message, and served by the route with an unconditional
200. An unknown key and an unauthorized key are byte-identical.

Timing is held in the same class from both ends. The unknown-key path pays the
same override-layer read a resolvable key pays (`equalizeUnknownKeyCost`),
because `resolvePlaybook()` short-circuits a registry miss before touching the
database; and unavailable results are cached for unknown and
registered-but-unavailable keys **alike**, because caching only one of them would
put every *repeat* probe of the other in a different timing class. Growth from
probing random keys is bounded where it belongs — the preflight cache is capped
with expiry-first eviction — not by declining to cache.

### Verdict rules worth knowing

- `deny` beats `unknown` beats `allow` (`worstVerdict`), and a step's `reason` is
  always the first layer that produced its verdict — reason and verdict can never
  describe different layers.
- Evaluation never short-circuits: preflight exists to say *which* step of five
  would die.
- A missing **field** read-permission slug redacts a field, it does not fail the
  step, so `field-permissions` stays `allow` with `reason: 'fields-redacted'` and
  the missing slugs attached. Reporting `deny` would predict a failure that will
  not happen.
- A non-public route with **no** middleware wired is a real, statically knowable
  `deny` (the generator's fail-closed 401). With one wired it is `unknown`.
- A tool listing may filter on preflight (`filterPlaybooksByPreflight` in
  `smrt-agents`), but that filter is a listing convenience and **never**
  load-bearing for authorization.

## Caching

Resolutions are cached per `(key, tenantId, db)` with a TTL. The cache is
invalidated on `PlaybookOverride.save()` and `.delete()`; an app-level write
(`tenantId = null`) clears every tenant's entry for that key, because each
tenant inherits from it. Use `clearPlaybookCache()` in tests.

A monotonic per-`(db, key)` invalidation generation closes the read-racing-a-
write window; see the Gotchas entry below before touching `cache.ts`.

Preflight results cache separately, per `(principal, key, plane, tenant)`, with a
shorter TTL and **no invalidation ceremony of their own** — an entry captured
under an older generation of the playbook cache is dropped on read. `principal`
is an opaque, caller-scoped partition key: it is never echoed in a report and
never consulted for authority. Use `clearPlaybookPreflightCache()` in tests.

Two partitioning traps, both of which produce a cross-context read rather than a
stale one:

- **The tenant is resolved, not defaulted.** `preflightPlaybook()` applies the
  same `tenantId !== undefined ? tenantId : (getTenantId() ?? null)` fallback
  `loadPlaybookBase()` does. Scoping an omitted tenant to `null` would let two
  ambient `withTenant()` callers with one principal share an entry — and the
  report carries the resolved title and description.
- **The principal must cover every input the evaluation reads.** The REST
  provider's default folds in `appAuthConfigured` (it decides whether
  `public-access` / `app-auth` are verdicts or `unknown`) and distinguishes an
  *absent* permission set (`perm:unpublished`, field layer `unknown`) from an
  explicitly empty one (known, `allow` with redactions). A custom `principal`
  must do the same.

## Gotchas

- **`context` carries the tenant scope.** `save()` sets
  `this.context = this.tenantId ?? '__app__'` and `conflictColumns` is
  `['key', 'context']`. `tenantId` is nullable, and a unique index over it
  would let multiple NULL rows coexist on PostgreSQL and DuckDB. The `context`
  trick (from `smrt-languages`) is what makes the same upsert correct on all
  three dialects — do not "simplify" it to `['key', 'tenantId']`.
- **Identity changes need the delete-then-insert dance.** Changing `key` or
  `tenantId` on an existing row changes the conflict identity, so a plain
  `super.save()` writes the old primary key under a new one. Same handling as
  `PromptOverride` / `LanguageOverride`: a transaction where the driver has
  one, otherwise a staged replacement row deleted only after the new row is
  durable.
- **JSON fields are stored as strings.** `planes` and `metadata` are text
  columns with guarded `getPlanes()` / `setPlanes()` / `getMetadata()` /
  `setMetadata()` helpers that swallow parse errors. Never override
  `toJSON()`; extend serialization through `transformJSON()`.
- **`resolvePlaybook()` returns a result, it does not throw for policy.**
  Unknown key, disabled, wrong plane, and unresolvable intents all come back as
  `{ ok: false, reason, message }`. It *does* throw for programming errors —
  notably a `steps` key on an override layer.
- **The cache carries an invalidation generation, and this is where it
  diverges from `smrt-prompts`.** A resolution captures
  `getPlaybookCacheGeneration(key, db)` before its asynchronous layer loads and
  hands it back to `setCachedPlaybookBase()`; a concurrent `save()` / `delete()`
  bumps the generation, and the in-flight resolution is then refused the cache
  write instead of repopulating the key it just invalidated with the pre-write
  value. Without it, "a stale entry is never served after a write" held only
  until a read raced a write, and then failed for the full 30s TTL. Generations
  are tracked per `(db, key)`, not per tenant, because an app-level row is
  inherited by every tenant. `clearPlaybookCache()` bumps rather than resets
  them, so a resolution that started before the clear cannot write back either.
  `smrt-prompts` and `smrt-languages` carry the same mechanism (#2609);
  `smrt-languages` additionally keys its generation by locale.
- **Restart vitest after adding a decorated class**; the manifest is generated
  at startup.

## Related

- `@happyvertical/smrt-prompts` — the pattern this package clones
- `@happyvertical/smrt-languages` — source of the `context` column convention
- `@happyvertical/smrt-features` — parallel package for feature flags
- Epic #2585 — declared agent surface; #2587 capability vocabulary,
  #2588 view intents, #2590 preflight, #2591 manifest emission
