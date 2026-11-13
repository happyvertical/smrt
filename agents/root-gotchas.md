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
