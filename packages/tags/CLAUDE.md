# @happyvertical/smrt-tags

Hierarchical tagging with context-scoped slugs and multi-language aliases.

## Models

- **Tag** (STI): identified by `slug` (not UUID) + `context` (default: 'global'). Hierarchical via `parentSlug`. `level` auto-calculated from parent. Metadata JSON.
- **TagAlias**: language-specific translations/aliases (ISO 639-1 `language` code, nullable). Optional context scoping.

## Key Collection Methods

- `getOrCreate(slug, options)`: auto-generates name from slug
- `moveTag(slug, newParentSlug)`: circular reference detection, level recalculation
- `mergeTag(sourceSlug, targetSlug)`: moves children + aliases from source to target, then deletes source
- `cleanupUnused()`: only deletes tags with no children AND no aliases
- `findWithGlobals(tenantId)`: tenant + global tags

## Gotchas

- **Slug stored in protected `_slug`**: has override getter/setter (not standard SmrtObject slug behavior)
- **Context defaults to 'global'**: if not specified
- **Optional tenancy** with nullable tenantId
