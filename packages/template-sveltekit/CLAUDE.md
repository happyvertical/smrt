# template-sveltekit

Base SvelteKit project template used by `smrt init`. Scaffolds a full-stack app with SMRT integration.

## Exports

- `getTemplatePath()` — returns path to template directory
- `copyTemplate(destination, options)` — copies template files with project name substitution
- `templateInfo` — metadata (SvelteKit 2.x, Svelte 5, REST API, SMRT CLI, SQLite)

## Template Contents

- `template/src/lib/objects/Item.ts` — example `@smrt()` object
- `template/src/lib/server/` — server-side utilities
- `template/src/routes/` — SvelteKit page routes

## Key Pattern

File copying with placeholder substitution — project name is replaced in template files during generation.
