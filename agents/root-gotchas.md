# Root gotchas

Moved verbatim from the root `AGENTS.md` to keep every AGENTS chain under the 32 KB cap.

## Tests and builds

SMRT tests require `smrtVitestPlugin()`. Restart Vitest after adding decorated
classes. Rebuild core after scanner/schema-generator edits: the Vite plugin
consumes deterministic `dist/` artifacts. Vite 8 requires Oxc legacy decorators
(see core guidance). Svelte subpaths require `svelte-check`, not just `tsc`;
use named `$props()` interfaces to avoid recursive inline intersections.
