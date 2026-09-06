# @happyvertical/smrt-web

Browser client data runtime — the web twin of `smrt-mobile`. Materializes the
manifest-generated web collection definitions (`@happyvertical/smrt-virt-web`)
as cached, reactive collections over the generated SMRT REST surface.

## What it does

Wraps a client-data engine (currently TanStack DB) so consumers get
stale-while-revalidate reads, concurrent-request dedup, and optimistic
mutations without hand-wiring cache keys or fetch/state.

- `createSmrtCollection(definition, options)` — typed collection factory over a
  generated `@happyvertical/smrt-virt-web` definition. Stale-while-revalidate
  reads (`staleTimeMs`, default 30s); N concurrent identical reads coalesce into
  one request; optimistic inserts persist through the REST surface and roll back
  automatically on server error. Pass `initialData` (SMRT-owned
  `SmrtWebRow<T>[]`) to seed the cache from server-rendered rows so the first
  client read serves them WITHOUT a duplicate first-render fetch — the SvelteKit
  `+page.server.ts` → hydrate path (#1761). The seed is fresh for `staleTimeMs`;
  fold the same `scope` used for reads into it under a shared `client`.
- `createSmrtWebClient()` — an opaque shared-cache handle. Pass one app-wide
  instance so collections share a cache and deduplicate requests.
- `createDefinitionFetchers(definition, basePath, fetchFn)` — CRUD fetchers
  derived from the generated definition (same URL scheme as the generated
  client, but HTTP error statuses reject instead of resolving).
- `unwrapListResult` / `unwrapItemResult` — normalize generated-client payloads
  (`T[]`, `{ data }` envelopes, `{ error }` bodies → thrown
  `SmrtWebRequestError`).

## Modules

Per-capability semantics live in sibling module docs — read the one for the
module you are editing. This file keeps what holds in every module.

| Module | Scope | Module doc |
|---|---|---|
| `index.ts` hooks + `durable-store.ts` | the six capability hook points, hook error isolation, the no-op guarantee, and the shared durable-store namespacing/wipe registry | [agents/capability-seam.md](agents/capability-seam.md) |
| `offline/` | durable offline writes — config, sync-apply-only replay, idempotency, the shared namespace-keyed engine, and Web Locks leader election | [agents/offline-outbox.md](agents/offline-outbox.md) |
| `sse-client.ts` | the client half of live cache invalidation — the app-wide subscriber, the wire contract it consumes, and SSE-vs-polling behaviour | [agents/live-invalidation.md](agents/live-invalidation.md) |
| `webmcp.ts` | framework-agnostic WebMCP registrar; validates an optionally bounded/namespaced, effect-filtered prospective set atomically, keeps legacy list-backed tools on collection state, and executes canonical tool-only definitions directly through REST fetchers. `registerWebMcpBespokeTool` is the single-tool sibling a UI layer's hand-written component tool routes through (`useWebMcpTool` in smrt-svelte, #2586): same fail-closed effect classification and `effects` policy, no `namespace`/`maxTools` | — |
| `persistence/` + `update-state.ts` | the read-cache rehydrate capability and the framework-free `updateAvailable` primitive (bundle + contract signals) | [agents/version-persistence.md](agents/version-persistence.md) |
| `webmcp-tool-names.ts` | the document-global tool-name lock every registration path reserves through (#2613). Dependency-free; ships as `@happyvertical/smrt-web/webmcp-tool-names` | see below |
| `intents.ts` + `capability-classification.ts` | the framework-agnostic declarative view-intent contract, its declaration registry, and the one capability classification rule both it and `webmcp.ts` apply (#2587, #2588). Ships as the dependency-free `@happyvertical/smrt-web/intents` entry — importing it pulls no client-data engine | — |
| `data-query.ts` | dependency-free browser mirror and defensive response normalizer for the canonical bounded data-query envelope (#2444) | — |
| `remote-query.ts` | query-shaped remote pages over a `SmrtWebCollection`, with keyed stale cache, execution modes, cancellation/latest-query-wins, and optional query-scoped live subscriptions (#2445) | — |

## The engine-absorption boundary (ratified conditions, #1761)

1. **No engine types in the public API.** `@tanstack/*` types must never appear
   on this package's public surface. Collections are handed back as the
   SMRT-owned `SmrtWebCollection`, and the shared cache as the opaque
   `SmrtWebClient`. Enforced by `scripts/check-smrt-web-engine-boundary.mjs`,
   run at the end of `build` (fails the build on any `@tanstack/` reference in
   an emitted `.d.ts`).
2. **Framework-agnostic core.** This entry imports no UI framework and must not
   import `@tanstack/svelte-db` (it ships only a `svelte` export condition,
   unresolvable outside Svelte bundlers). Svelte live-query bindings ship in a
   separate entry/package.
3. **Code-split / lazy.** The engine (~76 kB gzip) must never load on public /
   smrt-sites pages. Consumers load the runtime only on surfaces that use live
   collections.

## Conventions

- **WebMCP definition mirror** — `WebMcpToolDefinition` textually mirrors the
  generated `@happyvertical/smrt-virt-web` / physical `@smrt/web` declaration.
  It is transport-complete and does not imply that a list-materialized client
  collection exists. Keep the mirror dependency-free. Register canonical tools
  or legacy collection definitions for overlapping collections; when composing
  the two forms, keep their names and collection/action identities disjoint.
  Duplicates fail atomically before registration.
  With no exposure policy, only `read` effects are selected; broader effects
  require explicit opt-in, and undeclared custom actions are destructive.
  **Classification (#2587)**: a canonical definition's `effect` / `idempotent`
  / `openWorld` are TRUSTED verbatim — core's `tool-schema.ts` is the sole
  classifier, and the registrar never recomputes them by action name. The CRUD
  switch in `webmcp.ts` (`actionSemantics()`) survives only as the fallback for
  legacy `SmrtWebCollectionDefinition` tool descriptors that carry no metadata.
  Both paths share one fail-closed default for an undeclared capability:
  `{ effect: 'destructive', idempotent: false, openWorld: true }` — see
  `CapabilityClassification` in `@happyvertical/smrt-types`, which this package
  mirrors structurally rather than importing (its dependency-DAG guardrails
  below keep it free of every `@happyvertical/*` dependency).
  Direct mutations invalidate their
  own and relationship-derived collection names through the public
  `invalidateSmrtWebCollections()` seam when the host supplies its shared
  `SmrtWebClient`. Legacy `filter` callbacks receive complete collection
  metadata; canonical definitions use `filterTool`. Supplying either filter for
  definitions of the other kind fails closed rather than ignoring the predicate
  or fabricating incomplete metadata for a policy decision. Filters and fetcher
  resolvers receive isolated value snapshots, so integrations must key external
  state by stable values such as collection/action rather than definition object
  identity.
  Canonical writes validate that shared client handle before registration, and
  string or structured `{ error }` REST envelopes fail before cache
  invalidation. The private `__smrt_options` GET sentinel is reserved only for
  no-path single-options-bag actions; positional actions preserve a legitimate
  parameter with that name.
  This capability policy is not authorization:
  the authenticated REST surface remains the auth, tenant, field-write, and
  sensitive-data boundary.

- **No inter-smrt dependencies** — depends only on TanStack packages
  (dependency-DAG guardrails). Definitions and fetchers arrive as arguments.
- **Data-query mirror** — `data-query.ts` mirrors the portable
  `smrt-types` request/result shape structurally because this package cannot
  depend on another SMRT package. Server adapters own authorization and full
query/result policy; browser code calls `executeSmrtWebDataQuery()` to reject
malformed or over-limit returned envelopes — including a response for a
different request id — before they reach a UI surface.
- Rows are plain DTOs with a required `id`; optimistic inserts use
  `newLocalId()` — the generated REST layer strips client ids on create
  (#1540), so the post-persist refetch reconciles server-assigned ids.
- To swap the engine, reimplement the SMRT-owned public types over a different
  backend; the boundary guard keeps consumers insulated from the change.

## Declarative view intents — the static form (#2588)

A view intent is a component-owned interaction with no model projection. It is
declared as DATA and compiles into the mounted `ControlInteractionRegistry` /
`DataSurfaceRegistry` commands, so `StagedControlReview` stays on the path and
an agent-staged value stays a proposal. Registration goes through
`registerWebMcpBespokeTool`, so an intent inherits the same fail-closed
`effects` exposure policy as a generated model tool.

### The contract #2591's scanner matcher implements against

The scanner walks `**/*.ts` and `**/*.tsx` only and matches decorators on
classes, not standalone calls, so an emittable intent must satisfy ALL of:

1. **A `.ts`/`.tsx` module**, never inline in a `.svelte` file. Convention: a
   sidecar named for what it belongs to — `OrderTable.intents.ts` — or one
   intents module per feature. The binding imports from it.
2. **Imported from `@happyvertical/smrt-web/intents`.** The package root
   re-exports the runtime half only; `defineIntent` ships solely from the
   `/intents` entry, so the matcher has exactly one import specifier to
   recognize and a sidecar never drags in the client-data engine.
3. **A module-scope `defineIntent(...)` call** — not inside a function, a
   class, a conditional, or a loop.
4. **Exactly one argument, an object literal** whose values are literals,
   literal objects, or literal arrays. No spreads, no identifiers, no template
   interpolation, no computed keys. The shape `definePrompt` already uses.

Anything computed or conditional is NOT static and keeps using
`useWebMcpTool` — that escape hatch exists precisely because a tool set
derived from fetched data cannot be read without evaluation.

Worked example, complete and matchable:

```ts
// OrderTable.intents.ts
import { defineIntent } from '@happyvertical/smrt-web/intents';

export const nextPageIntent = defineIntent({
  id: 'orders.next_page',
  description: 'Advance the orders table by one page',
  capability: { effect: 'read', idempotent: false, openWorld: false },
  target: { registry: 'dataSurface', controlId: 'next-page', kind: 'table' },
});
```

`id` is lowercase and dot-namespaced with at least two segments. It is the
identity a playbook step names (`{ kind: 'intent', id }`, #2589) and the
manifest will carry, so it must not be derived from a namespace, a generated
tool name, or a route. The WebMCP tool name is `id` with `.`/`-` replaced by
`_`; an id resolving into the reserved `smrt_ui_` prefix is rejected, because
the six fixed UI tools are unchanged by this contract and intents sit above
them rather than duplicating them. That flattening is not injective —
`orders.foo_bar` and `orders.foo.bar` both derive `orders_foo_bar` — so
`defineIntent` also rejects a second id that derives a tool name an already
declared intent derives, at the one place both are visible. Two such intents
would otherwise fight over a single WebMCP tool name at mount, where the
failure is a shadowed or rejected registration rather than a clear error.

**That check covers intents only** — a derived name can still collide with a
GENERATED model tool (`${model}_${action}`) or, under a custom
`webmcp.ui.prefix`, with one of the six fixed UI tools, and neither is
knowable at declaration time because both depend on a runtime
`namespace`/`prefix` the declaration never sees. Those cross-path collisions
are caught at REGISTRATION instead, by the document-global tool-name lock
below (#2613).

### The no-REST invariant

`ViewIntentDeclaration` has no `execute`, `fetch`, `url`, `route`, `endpoint`,
or `method` field and no field of function type; `target` is a closed
two-member union naming a browser registry. `defineIntent` additionally
rejects, at runtime, any key outside its allowlist and any non-JSON value
anywhere in the object, so an `as any` cast smuggles nothing either. The
tool's `execute` is then CONSTRUCTED by `compileViewIntentToolSpec` from
`intent.target` — no author-supplied callable ever runs. Proven by
`src/intents.test.ts` ("the no-REST invariant"). If you add a field to the
declaration, it must be data, and it must be reachable by the scanner without
evaluation.

## The document-global tool-name lock (#2613)

`webmcp-tool-names.ts` is the reservation table the three name-deriving paths
coordinate through, and ships as the dependency-free
`@happyvertical/smrt-web/webmcp-tool-names` entry so a UI layer can reserve
its own names without pulling the client-data engine.

The three paths do NOT share one registrar — verify this before assuming a
funnel. `registerWebMcpTools` and `registerWebMcpUiTools` (in
`@happyvertical/smrt-svelte`) each call `document.modelContext.registerTool`
directly; only intents and `useWebMcpTool` route through
`registerWebMcpBespokeTool`. So each path reserves for itself:

| Path | Owner | Reserves in |
|---|---|---|
| generated model tools | `generated` | `registerWebMcpTools`, after selection/budget validation, before the first `registerTool` |
| the six fixed `smrt_ui_*` tools | `ui` | `registerWebMcpUiTools` (`smrt-svelte`), after the prefix lock |
| declared view intents | `intent` | `registerWebMcpBespokeTool`'s shared body, via `registerViewIntent` |
| bespoke `useWebMcpTool` tools | `bespoke` | the same shared body |

Reservation is all-or-nothing and rejects a duplicate SYNCHRONOUSLY with
`WebMcpToolNameCollisionError`, which carries the colliding name plus the
owner holding it and the owner that asked. Previously the host rejected the
later registration and the tool was silently absent. **This is a behavior
change**: `registerWebMcpBespokeTool` and `registerViewIntent` now throw where
they used to succeed-then-lose-the-tool.

Rules for anything that adds a fourth path or edits an existing one:

- **The table is keyed on the `document`, not on module state.** A registrar
  with an injectable document must pass the SAME object it reads
  `modelContext` from, or its reservations land in a different table. Module
  state would fragment across bundle chunks, a duplicated dependency, and HMR;
  the table is stored on the document under a `Symbol.for` key so every copy
  of the module resolves to one slot. It is stamped with the `modelContext` it
  was built for and resets when the host installs a new one, so tools the old
  registry held never strand their names.
- **Dispose must release**, or a mount/unmount cycle wedges the name
  permanently — the failure mode #2595 already hit as a re-registration race.
  A reservation releases only names it still holds.
- **A tool the effects policy excluded reserves nothing**: it was never
  registered, so its name stays available.
- Consumer app code that registers directly against `document.modelContext`
  (for example `packages/template-sveltekit`'s runtime-diagnostics tools) does
  not participate and can still collide at the host.

## Reference consumer

`packages/products` consumes the runtime as its reference store across npm,
federation, and standalone modes (see the smrt-web track, PRD #1755).

## WebMCP integration fixture

`src/webmcp-e2e.integration.test.ts` is the production-shaped composition
fixture for generated WebMCP tools. It uses `smrtVitestPlugin()`, a real
in-memory SQLite database, and generated REST handlers. Only the browser
`document.modelContext` and external AI boundary are doubled. Keep this fixture
focused on the WebMCP contract: auth failures, effect/exposure policy,
tool-only fetches, custom actions, relationship cache invalidation, and
registration disposal. Its descriptors come from the OXC manifest adapter so
the test follows the same generation path as the virtual WebMCP module; the
Vitest config excludes test files from the package manifest to avoid exposing
fixture-only classes to package discovery. The integration model is documented in
`docs/content/webmcp-integration.md`.
