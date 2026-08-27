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
| Principal-bound server tools | Server-side work that must never be browser-exposed | Server-owned tools run with `executeAsPrincipal` on the authenticated server path (see [#2450](https://github.com/happyvertical/smrt/issues/2450)) |

Keep these namespaces and trust boundaries distinct. Generated model tools
describe data capabilities; mounted UI tools describe transport-neutral
interaction state; bespoke tools describe a component-owned intent; and
principal-bound tools stay behind server authorization.

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
or `destructive` only for a page that needs them, and bound the surface with a
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
