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

`smrt-playground` does not own component code or theming — it only discovers and renders. UI components themselves come from individual packages (`smrt-content/svelte`, `smrt-jobs/svelte`, etc.), from `smrt-ui` for shared domain-agnostic primitives, or from `smrt-svelte` for the top-level integration components.

## Modules

| Module | Scope | Module doc |
|---|---|---|
| `host` | the private SvelteKit app used for Playwright e2e testing of `PlaygroundHost.svelte`; registered as the `smrt-playground-host` workspace package but not published | [agents/host.md](agents/host.md) |

## Docs

- See [`docs/ui-surfaces.md`](../../docs/ui-surfaces.md) for the full UI surface contract
- See [`docs/content/standards.md`](../../docs/content/standards.md) for monorepo conventions

## Visual baselines

The host's theme gallery has Chromium-on-macOS screenshot baselines. Update with `pnpm --filter smrt-playground-host test:e2e:update-snapshots`; details in [agents/host.md](agents/host.md). The spec skips pixel comparison off darwin (CI is Linux).

## Visual regression (styling wave 2)

`Playground Visual Regression` in `Pull Request Validation` compares 120 Linux
Chromium screenshots: Base Controls, Feedback & Overlays, Collections & Content
Lists, Data Table, Calendar and Styleless Mode × Material/Glass/Studio/SMRT/
HappyVertical × light/dark × styled/unstyled. It is a required gate when
`packages/*/src/**/*.svelte`, `smrt-ui/src/themes/**`, `smrt-ui/src/styles/**`,
playground files, the workflow/setup action, or dependency manifests change.
The job has a six-minute wall-clock budget and uploads `playground-visual-diffs`
(expected/actual/diff PNGs, HTML report and traces) on failure.

Baselines live in `e2e/__screenshots__/<preset>/<scheme>/<entry>-<mode>.png`.
Rendering uses the pinned Playwright 1.63.0 Noble **Linux AMD64** image in
`e2e/Dockerfile`, a 1440×1000 viewport at 1×, en-US, America/Edmonton, a fixed
2026-10-13 clock, self-hosted SMRT and HappyVertical fonts, reduced motion and
an unlayered animation/transition override. The screenshot target is the whole
preview stage, including content taller than the viewport. The comparison allows
at most 0.01% changed pixels with a 0.1 per-pixel threshold; do not widen it to
accept an unexplained regression.

After `pnpm install --frozen-lockfile` and `pnpm build`, with Docker running and
port 5560 free, run from the repository root:

```bash
pnpm --filter smrt-playground-host test:visual:container
pnpm --filter smrt-playground-host test:visual:container --update-snapshots
# Focus a deliberate styling change:
pnpm --filter smrt-playground-host test:visual:container --grep 'material/light/base-controls'
```

The wrapper builds the pinned renderer, starts the actual playground dev host,
renders in Linux, writes results into the workspace and stops its host. Native
`test:visual` and `test:visual:update` also exist for that Linux environment;
**both refuse macOS** before Playwright can write even a missing baseline.
Never commit macOS-rendered PNGs. Other Linux distributions/browser versions are
not the baseline environment: use the container on those systems too.
Default comparison uses `updateSnapshots: 'none'`, so missing files fail closed.

To generate on GitHub, dispatch `Pull Request Validation` on the desired branch
with `update_visual_baselines=true`, download `playground-visual-baselines` into
`packages/smrt-playground/e2e/__screenshots__/`, inspect the changed PNGs, rerun
comparison and commit explicit baseline paths alongside the intentional change.
The workflow never commits or approves its own updates. PR runs always compare.
Because `pull_request_target` loads trusted base YAML, workflow edits take effect
for PR events after merging; manual dispatch on the feature branch can exercise
the new visual job before that. Wave-2 changes should cite the job/run URL.
