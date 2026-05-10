# template-site-static-json

Scaffold template for static community news sites with JSON data. Used by `smrt gnode create`.

## Exports

- Template config with placeholder mappings (site name, location, timezone, coordinates)
- Template directory path and file path utilities

## Template Contents

- `template.config.js` — placeholder definitions and post-generation hooks
- `template/scripts/init-data.ts` — data initialization script
- `template/src/site.config.ts` — typed access to `smrt.config.js` site section (`initSiteConfig()`/`getSite()`)

## Key Patterns

- **Placeholder system**: variables (site name, location, timezone) replaced during `smrt gnode create`
- **Post-generation hooks**: run after template files are copied (e.g., init-data.ts)
- **Dependency injection**: `template/package.json` ships with empty `dependencies`/`devDependencies`; the scaffolder injects entries from `template.config.js` at generation time, so version bumps live in `template.config.js` only.
- **Workflow scripts**: `workflow:caelus` and `workflow:praeco` are currently stubs that print a clear "upstream package needs a CLI bin" message and exit with status 1. Two independent reasons today's scaffold can't run them:
  1. The upstream `@happyvertical/caelus` and `@happyvertical/praeco` packages are library-only — they do not declare a `bin` field, so `npx @happyvertical/caelus` / `npx @happyvertical/praeco` exits with "could not determine executable to run."
  2. The template does not ship a local workflow shim (e.g. `template/src/workflows/caelus.ts`) that would import the upstream package and invoke the workflow from code. A `tsx`-based script would work fine if such a shim existed; the previous baseline pointed at `tsx src/workflows/caelus.ts` and failed only because the shim file was missing, not because tsx requires upstream to ship a bin.

  Once upstream ships bins, replace the stubs with `npx @happyvertical/caelus --config smrt.config.js` / `npx @happyvertical/praeco --config smrt.config.js` (the scoped names — the unscoped `caelus` is a 404 on the public registry). Alternatively, add a `template/src/workflows/<name>.ts` shim that imports the upstream package's main export and invokes the workflow, then point the script at `tsx src/workflows/<name>.ts`. Until either is in place, callers who need these workflows should write the shim themselves in their generated project.

## Runtime Dependencies

Template projects use: `smrt-content`, `smrt-events`, `smrt-places`, `smrt-profiles`, `smrt-svelte`.
