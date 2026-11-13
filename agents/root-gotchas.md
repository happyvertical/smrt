# Root gotchas

Moved verbatim from the root `AGENTS.md` to keep every AGENTS chain under the 32 KB cap.

## Tests and builds

Turbo global inputs cover authored package instructions and source configuration
under package roots, source/test/template directories, scripts and examples.
Keep generated `dist/` template copies outside those globs: their first build
would invalidate every task. Turbo 2.10 does not support negated global globs.
Vite-generated `src/types/virtual-modules.d.ts` is an output, not a build input;
package task overrides must preserve that exclusion and output declaration.

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
- `pnpm lint` also runs `scripts/check-hand-written-ddl.mjs` (#4930): a new
  hand-written `CREATE`/`ALTER`/`DROP TABLE` in `packages/*/src` outside the
  migrator, the schema code and core's `system/` tables fails, naming file and
  line. Existing ones sit in `scripts/hand-written-ddl-baseline.json`, which
  only shrinks (`--prune`). Declare the shape on a model instead.
