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
- **Workflow scripts**: `workflow:caelus` and `workflow:praeco` delegate to the upstream packages via `npx @happyvertical/caelus` / `npx @happyvertical/praeco`. Both packages are scoped (the unscoped `caelus` 404s on the public registry); use the full scoped name in `npx` so the installed dependency is the one resolved. If the upstream microservice has not yet shipped a `bin` entry, scaffolded projects will need to fall back to direct `tsx` invocation pointed at the upstream `src/workflows/*.ts` until the CLI is exposed.

## Runtime Dependencies

Template projects use: `smrt-content`, `smrt-events`, `smrt-places`, `smrt-profiles`, `smrt-svelte`.
