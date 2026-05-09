# smrt-playground

Shared playground discovery, runtime helpers, and host components for SMRT UI packages.

## Core pieces

- `discovery.ts` — finds package-owned `./playground` modules across the workspace and installed `node_modules`
- `runtime.ts` — coerces and merges discovered modules into a unified registry consumed by the host
- `templates.ts` — generates Svelte route templates for app-level and package-level playground hosts
- `svelte/PlaygroundHost.svelte` — the host component that renders discovered playground entries
- `vite.ts` — vite plugin used by the SvelteKit playground host to wire everything together

## Surface contract

Each UI-shipping package opts in by exporting a `./playground` subpath that resolves to a module shaped like `SmrtPlaygroundModule`:

```typescript
// packages/<name>/src/svelte/playground.ts
export const playground: SmrtPlaygroundModule = {
  packageName: '@happyvertical/smrt-<name>',
  entries: [
    {
      id: '<name>:component-id',
      label: 'Human-readable label',
      load: () => import('./components/MyComponent.svelte'),
    },
  ],
};
```

## CLI integration

The `smrt playground` commands (`init`, `dev`, `list`) consume this package. The CLI commands live in `@happyvertical/smrt-cli`; the runtime they delegate to is here.

## Relationship to `smrt-svelte`

`smrt-playground` does not own component code or theming — it only discovers and renders. UI components themselves come from individual packages (`smrt-content/svelte`, `smrt-jobs/svelte`, etc.) or from `smrt-svelte` for shared primitives.

## Internal `host/` directory

The `host/` directory is a private SvelteKit app used for Playwright e2e testing of `PlaygroundHost.svelte`. It is registered as `smrt-playground-host` in the workspace but is not published.

## Docs

- See [`docs/ui-surfaces.md`](../../docs/ui-surfaces.md) for the full UI surface contract
- See [`docs/standards.md`](../../docs/standards.md) for monorepo conventions
