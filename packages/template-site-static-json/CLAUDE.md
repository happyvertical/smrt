# template-site-static-json

Scaffold template for static community news sites with JSON data storage and SMRT framework integration. Used by `smrt gnode create` to generate working SvelteKit applications.

## Architecture

```
template.config.js          # Template config with placeholders and post-gen hooks
index.js                    # Exports template config, path, and file utilities
template/
  scripts/init-data.ts      # Data initialization script
  src/
    site.config.ts          # Typed access to smrt.config.js site section
    routes/                 # SvelteKit page routes
    lib/                    # Utilities (markdown, config loading)
```

## Key Exports

- Template config object with placeholder mappings (site name, location, timezone, coordinates)
- Template directory path and file path support

## Key Patterns

- **Placeholder system**: Variables like site name, location, timezone replaced during generation
- **Post-generation hooks**: Run after template files are copied (e.g., `init-data.ts`)
- **Site config**: `initSiteConfig()` / `getSite()` for typed access to `smrt.config.js` site section
- **No tests**: Template validated through integration testing

## Dependencies

- Peer: `@happyvertical/smrt-core`, `@happyvertical/smrt-config`
- Template runtime: `smrt-content`, `smrt-events`, `smrt-places`, `smrt-profiles`, `smrt-svelte`
