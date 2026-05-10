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
- **Workflow scripts**: `workflow:caelus` and `workflow:praeco` are currently stubs that print a clear "upstream package needs a CLI bin" message and exit with status 1. The upstream `@happyvertical/caelus` and `@happyvertical/praeco` packages are library-only today — they do not declare a `bin` field, so neither `npx <pkg>` nor `tsx src/workflows/<name>.ts` resolves to a runnable entry point. Once upstream ships bins, replace the stubs with `npx @happyvertical/caelus --config smrt.config.js` / `npx @happyvertical/praeco --config smrt.config.js` (the scoped names — the unscoped `caelus` is a 404 on the public registry). Until then, callers who need these workflows should write a small script that imports the package's main export and runs the workflow from code.

## Runtime Dependencies

Template projects use: `smrt-content`, `smrt-events`, `smrt-places`, `smrt-profiles`, `smrt-svelte`.
