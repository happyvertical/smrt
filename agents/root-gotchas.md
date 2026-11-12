# Root gotchas

Moved verbatim from the root `AGENTS.md` to keep every AGENTS chain under the 32 KB cap.

## Tests and builds

SMRT tests require `smrtVitestPlugin()`. Restart Vitest after adding decorated
classes. Rebuild core after scanner/schema-generator edits: the Vite plugin
consumes deterministic `dist/` artifacts. Vite 8 requires Oxc legacy decorators
(see core guidance). Svelte subpaths require `svelte-check`, not just `tsc`;
use named `$props()` interfaces to avoid recursive inline intersections.

## Build-time gates beyond Biome

- `pnpm build` runs `check:manifest-paths` after Turbo: a built manifest must
  not hold an absolute `filePath` (#4948). Rebuild the named package.
- `pnpm lint` runs `scripts/check-required-reasons.mjs` (#4923): a
  `required: true` field in `packages/*/src` states `requiredFor` or sits in
  `scripts/required-reasons-baseline.json`, which only shrinks
  (`--prune` drops fixed entries).
