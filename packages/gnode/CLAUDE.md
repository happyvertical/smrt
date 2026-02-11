# @happyvertical/smrt-gnode

Federation library for local knowledge base sites (gnodes). Provides site generation, template scaffolding, and configuration management for SMRT-powered content sites.

## Architecture

```
src/
  index.ts              # Export barrel
  gnode.ts              # Core Gnode model
  gnode-config.ts       # Gnode configuration management
  gnode-template.ts     # Template scaffolding utilities
  site-publisher.ts     # Site publishing and deployment
```

## Key Exports

- `Gnode` — Core gnode model representing a local knowledge base site
- `GnodeConfig` — Configuration for gnode instances
- `GnodeTemplate` — Template management for site scaffolding
- `SitePublisher` — Publishing utilities for deploying gnode content

## Key Patterns

- **Template-based**: Sites are scaffolded from templates (SvelteKit, static JSON)
- **Configuration-driven**: Sites are configured via `smrt.config.js`
- **Federation-ready**: Designed for future inter-gnode communication (not yet implemented)

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-config`
- `@happyvertical/files`, `@happyvertical/utils`
