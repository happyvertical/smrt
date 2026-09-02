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

## Caching

Resolutions are cached per `(key, tenantId, db)` with a TTL. The cache is
invalidated on `PlaybookOverride.save()` and `.delete()`; an app-level write
(`tenantId = null`) clears every tenant's entry for that key, because each
tenant inherits from it. Use `clearPlaybookCache()` in tests.

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
- **The TTL cache has a known repopulation race**, inherited verbatim from
  `smrt-prompts`. A resolution whose database read is already in flight when a
  concurrent `save()` / `delete()` invalidates the key can write the pre-write
  value back afterwards, so that scope can serve a stale plan for up to the
  30s TTL. It fails to a stale-but-valid plan, is self-correcting, and touches
  no authoritative state — a playbook is not an authority boundary and every
  step re-enforces at execution. Fixing it belongs with the deferred
  "extract a shared override package" work in epic #2585, so all four
  implementations gain an invalidation generation at once rather than this one
  diverging.
- **Restart vitest after adding a decorated class**; the manifest is generated
  at startup.

## Related

- `@happyvertical/smrt-prompts` — the pattern this package clones
- `@happyvertical/smrt-languages` — source of the `context` column convention
- `@happyvertical/smrt-features` — parallel package for feature flags
- Epic #2585 — declared agent surface; #2587 capability vocabulary,
  #2588 view intents, #2590 preflight, #2591 manifest emission
