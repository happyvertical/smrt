# @happyvertical/smrt-playground

Shared playground discovery, runtime, and host components for SMRT UI packages.

`@happyvertical/smrt-playground` is the implementation package behind the public
`smrt playground ...` CLI workflow. It provides the shared host, discovery
helpers, Vite integration, and scaffolding templates used by the repo-wide
playground convention.

## Standard Convention

Package-owned playgrounds live with the package:

- `src/svelte/playground.ts`
- `src/playground.ts`

Consumer-app local overrides live at:

- `src/playground.ts`

The package file is the source of truth for preview entries. The bridge file is
the import target used for package publishing and app-level discovery.

## Package Playground Module

Each participating package exports a `SmrtPlaygroundModule` from
`src/svelte/playground.ts`.

```ts
export default {
  packageName: '@happyvertical/smrt-example',
  displayName: 'Example',
  entries: [
    {
      id: 'example-card',
      title: 'Example Card',
      loadComponent: () => import('./components/ExampleCard.svelte'),
      props: {
        title: 'Hello world',
      },
      modes: {
        mock: true,
      },
    },
  ],
};
```

Recommended conventions:

- Keep preview entries close to the real exported components.
- Prefer `loadComponent` over eager component imports for package portability.
- Use stable `id` values because app-local overrides merge by package name plus
  entry id.
- Publish `./playground` only for packages that should be discoverable outside
  the workspace.

## App Integration

For a local app playground route, use the shared host plus the Vite virtual
module:

```svelte
<script lang="ts">
import { PlaygroundHost } from '@happyvertical/smrt-playground/svelte';
import { playgroundModules } from 'virtual:smrt-playground/modules';
</script>

<PlaygroundHost
  title="SMRT Playground"
  subtitle="Package previews and local app overrides"
  modules={playgroundModules}
/>
```

In Vite, install the plugin:

```ts
import { smrtPlaygroundVitePlugin } from '@happyvertical/smrt-playground/vite';

plugins: [smrtPlaygroundVitePlugin()];
```

## CLI Workflow

Most projects should use the CLI instead of wiring files manually:

- `smrt playground init`
- `smrt playground dev`
- `smrt playground list`

Typical flows:

- In an SMRT package, `smrt playground init` scaffolds
  `src/svelte/playground.ts` and `src/playground.ts`.
- In a consumer app, `smrt playground init` scaffolds `src/playground.ts` plus
  a local `/playground` route powered by the shared host.
- `smrt playground dev` runs the shared workspace host in repo mode, or the
  local app playground in consumer mode.
- `smrt playground list` shows discovered playground modules and entry modes.

## Exports

- `@happyvertical/smrt-playground`
  Discovery helpers, merge/runtime helpers, templates, and types.
- `@happyvertical/smrt-playground/vite`
  Vite plugin for discovery and virtual module wiring.
- `@happyvertical/smrt-playground/svelte`
  Shared Svelte host components.
