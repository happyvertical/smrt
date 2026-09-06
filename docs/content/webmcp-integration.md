---
title: WebMCP integration model
sidebar_position: 3
---

# WebMCP integration model

WebMCP is the browser-facing capability surface for an s-m-r-t application. A
good integration composes narrowly scoped tools from four sources. The
application's authenticated REST routes remain the authorization boundary;
WebMCP exposure only decides which capabilities a model can discover.

## The four tool sources

| Source | Best for | Registration model |
| --- | --- | --- |
| Generated model tools | Reading and mutating a model through generated REST | `webMcpToolDefinitions` with the Provider, or `registerWebMcpTools()` from `@happyvertical/smrt-web` |
| Mounted UI tools | Inspecting a mounted Form or DataSurface and requesting a user-reviewed action | `<Provider webmcp={{ ui: ... }}>` |
| Bespoke component tools | One intent owned by one component | `useWebMcpTool(() => spec)` from `@happyvertical/smrt-svelte` |
| Declared view intents | A component-owned interaction that is static, namespaced, and emittable into the manifest | `defineIntent({ ... })` in a `*.intents.ts` sidecar from `@happyvertical/smrt-web/intents`, bound with `useViewIntent(intent, { identity })` from `@happyvertical/smrt-svelte` |
| Principal-bound server tools | Server-side work that must never be browser-exposed | Server-owned tools run with `executeAsPrincipal` on the authenticated server path (see [#2450](https://github.com/happyvertical/smrt/issues/2450)) |

Keep these namespaces and trust boundaries distinct. Generated model tools
describe data capabilities; mounted UI tools describe transport-neutral
interaction state; bespoke tools and declared view intents describe a
component-owned intent; and principal-bound tools stay behind server
authorization.

The four browser sources derive their tool names independently and all reach
one `document.modelContext`, so each reserves its names through a
document-global tool-name lock before registering
([#2613](https://github.com/happyvertical/smrt/issues/2613)). A name two
sources both want is refused synchronously, with a message naming the tool and
which source already holds it (`generated`, `ui`, `intent`, or `bespoke`).
`useViewIntent` labels its reservation `intent` even though it registers
through the bespoke registrar, so an intent collision names the intent rather
than a hand-written tool.
Before the lock, the browser rejected whichever registration arrived second and
that tool was simply absent. Disposing a registration releases its names, so
mounting and unmounting the same tool repeatedly keeps working.

"Synchronously" describes the registrar's own contract — it throws before
calling `registerTool`. The Svelte bindings load `@happyvertical/smrt-web`
lazily, so from a component's point of view the report still arrives a
microtask or two after mount: `<Provider>` logs the throw through its logger,
and `useWebMcpTool` reports it as a `console.warn` naming the tool and owner.
Neither surfaces a collision as an exception the component can catch.

Declared view intents and bespoke component tools are the same trust
boundary reached two ways, and both register through
`registerWebMcpBespokeTool` under one exposure policy. Prefer a declared
intent: it is static, so it classifies at declaration, carries a stable
namespaced identity a playbook step can name, and can be emitted into the
manifest and knowledge graph. `useWebMcpTool` stays the escape hatch for a
tool set derived from fetched data, which no static form can express.

## Generated model tools

The template wires the generated definitions into its root Provider:

```svelte
<Provider
  webmcp={{
    definitions: webMcpToolDefinitions,
    basePath: '/api',
    effects: ['read'],
  }}
>
  {@render children()}
</Provider>
```

Omitting `effects` (or selecting `['read']`) exposes reads only. Add `write`
or `destructive` only for a page that needs them, and bind the surface with a
namespace, `maxTools`, and a canonical `filterTool` where appropriate. Policy
validation is atomic: duplicate names, malformed definitions, or a filter
mismatch reject the prospective registration before any browser tool is
installed. Use one complete definition source for a collection; do not mix
legacy and canonical definitions for the same collection.

Tool results are untrusted application content. Do not treat annotations as
authorization, and do not place secrets or hidden fields in a definition.
Generated fetchers use the page's authenticated REST transport, so auth,
tenant, writable-field, and sensitive-field checks remain server-side.

## Mounted UI tools

Enable the fixed UI adapter when a page has mounted forms or data surfaces:

```svelte
<Provider webmcp={{ ui: { dataSurfaceRegistry: surfaces } }}>
  {@render children()}
</Provider>
```

The adapter exposes six stable `smrt_ui_*` tools for listing, inspecting, and
executing form controls and DataSurface controls. It reads the current
transport-neutral registries at execution time and never inspects the DOM.
Form mutations can be staged by an agent, but apply, clear, and undo require a
separate human-confirmed path. Agent input cannot assert confirmation. Secret
values and hidden columns are omitted from serialized results.

## Declared view intents

A view intent is an interaction a component owns that has no model projection
and never will — filter this list, advance the wizard, open the archived tab.
Declare it as a literal object at module scope in a `.ts` sidecar, so the
scanner can find it without evaluating the module:

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

Bind it to a mounted registry identity for the component's lifetime:

```svelte
<script lang="ts">
import { useViewIntent } from '@happyvertical/smrt-svelte';
import { nextPageIntent } from './OrderTable.intents.js';

useViewIntent(nextPageIntent, {
  identity: { surfaceId: 'orders-table', kind: 'table' },
});
</script>
```

Three properties follow from the declaration being data:

- **It classifies at declaration**, through the same fail-closed rule as a
  generated model action. Omit `capability` and the intent resolves to
  destructive, non-idempotent, open-world, and a read-only Provider excludes
  it.
- **It cannot reach REST.** The declaration type has no `execute`, `url`,
  `route`, or `fetch` field, `defineIntent` rejects any unknown key and any
  function value anywhere in the object, and the tool's `execute` is
  constructed by the registry from `target`. An intent dispatches exactly one
  `ControlInteractionRegistry` or `DataSurfaceRegistry` command, as
  `source: 'agent'` — so `StagedControlReview` stays on the path and an
  agent-staged value remains a proposal.
- **It is emittable.** The stable namespaced `id` is what a playbook step
  names (`{ kind: 'intent', id }`) and what the manifest will carry.

The contract, the registry, and the compilation live in
`@happyvertical/smrt-web` with no Svelte dependency; Svelte is the first
binding, not the only one.

## Bespoke component tools

Use `useWebMcpTool` for an intent that belongs to one component rather than to
the application data model:

```svelte
<script lang="ts">
  import { useWebMcpTool } from '@happyvertical/smrt-svelte';

  useWebMcpTool(() => ({
    name: 'invoice_preview',
    description: 'Preview the current invoice without changing it.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: () => JSON.stringify({ ok: true }),
  }));
</script>
```

The hook feature-detects `document.modelContext`, is a no-op during SSR and in
browsers without WebMCP, and aborts the component's registration on unmount or
when its reactive specification changes. Use a stable, component-specific
name and return bounded, untrusted-content-safe results.

`useWebMcpTool` routes through the same registrar as generated tools, so a
bespoke tool is subject to the same fail-closed `effects` exposure policy: no
`annotations`, or annotations that leave the effect undeclared, classify
destructive, non-idempotent, open-world — the tool above must declare
`readOnlyHint: true` to register under a read-only policy. The policy is the
nearest `<Provider webmcp={{ effects: [...] }}>`'s configured `effects`;
without a Provider ancestor, or without `effects` configured, only reads are
exposed. Unlike generated tools, a bespoke tool never receives the
`namespace` prefix and is never counted against `maxTools` — a component
author already chose a stable name, and budgeting one intent against a shared
generated-tool set could make an unrelated tool fail to register.

## Lifecycle and verification

WebMCP registration is client-only. A missing `modelContext` must not prevent
SSR or hydration. Every registration should be disposed or aborted with its
own Provider/component lifecycle. Test the complete composition with a real
in-memory SQLite database and generated REST handlers; double only
`document.modelContext` and external AI providers. Include checks for:

- authenticated reads and writes, plus 401/403 failures;
- read-only, write, destructive, and undeclared custom-action exposure;
- direct tool-only fetches and generated route envelopes;
- relationship-derived cache invalidation after a mutation;
- mounted Form/DataSurface registration and consent behavior;
- bespoke tool lifecycle, SSR, and a missing `modelContext`.

The executable fixture is
`packages/smrt-web/src/webmcp-e2e.integration.test.ts` for database, REST,
cache, and generated tools, and
`packages/smrt-svelte/src/web/__tests__/webmcp-composed.integration.svelte.test.ts`
for the mounted UI and bespoke component composition.
