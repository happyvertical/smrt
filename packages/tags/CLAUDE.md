# @happyvertical/smrt-tags

Hierarchical tagging with context-scoped slugs and multi-language aliases.

## Models

- **Tag** (STI, extends `SmrtHierarchical`): public identifier is `slug` (not UUID) + `context` (default: 'global'), but the hierarchy FK is `parentId` (UUID) since R3-B. `TagCollection.moveTag` / `mergeTag` / `getChildren` keep slug-string signatures and resolve to UUIDs internally. `level` is a denormalised depth recalculated on `moveTag`. Metadata JSON.
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
