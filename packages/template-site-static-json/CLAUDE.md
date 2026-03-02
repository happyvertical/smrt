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

## Runtime Dependencies

Template projects use: `smrt-content`, `smrt-events`, `smrt-places`, `smrt-profiles`, `smrt-svelte`.
