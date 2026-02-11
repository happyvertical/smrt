# template-sveltekit

Base SvelteKit project template with SMRT framework integration. Provides scaffolding for full-stack applications with REST APIs, CLI, and SQLite database support.

## Architecture

```
index.js                    # Template utility functions
template/
  src/
    lib/
      objects/Item.ts       # Example SMRT object definition
      server/               # Server-side utilities
    routes/                 # SvelteKit page routes
```

## Key Exports

- `getTemplatePath()` — Returns path to template directory
- `copyTemplate(destination, options)` — Copies template files with project name substitution
- `templateInfo` — Metadata: SvelteKit 2.x, Svelte 5, REST API, SMRT CLI, SQLite

## Key Patterns

- **File copying with substitution**: Project name replaced in template files during generation
- **Example SMRT object**: `Item.ts` demonstrates `@smrt()` decorator usage
- **No tests**: Straightforward file operations validated through integration

## Dependencies

- Template peer: `@happyvertical/smrt-core`
