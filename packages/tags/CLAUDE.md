# @happyvertical/smrt-tags

Hierarchical tagging system with contexts, multi-language aliases, and flexible metadata for organizing content.

## Architecture

```
src/
  index.ts                  # Export barrel
  types.ts                  # TagOptions, TagAliasOptions, TagMetadata, TagHierarchy
  utils.ts                  # Slug and hierarchy utilities
  models/
    tag.ts                  # Core tag with hierarchy and context scoping
    tag-alias.ts            # Multi-language aliases
  collections/
    tags.ts                 # TagCollection with getOrCreate(), hierarchy ops
    tag-aliases.ts          # TagAliasCollection
```

## Models

### Tag

Tenancy-optional model with slug-based identification, parent-child hierarchy, and context-based scoping.

**Properties**: `slug` (unique), `name`, `parentSlug`, `level` (auto-calculated), `description`, `metadata` (JSON), `context` (namespace)

**Methods**:
- Hierarchy: `getParent()`, `getChildren()`, `getAncestors()`, `getDescendants()`
- Metadata: `getMetadata()`, `setMetadata()`, `updateMetadata()`
- Static: `getBySlug()`, `getRootTags()`

**Metadata schema**: color, backgroundColor, icon, emoji, usageCount, lastUsed, trending, featured, sortOrder, showInNav, displayFormat, aiGenerated, confidence, source, reviewStatus

### TagAlias

Multi-language support with `tagSlug`, `alias`, `language` (ISO 639-1), and `context`.

## Collections

### TagCollection

- `getOrCreate(options)` — Idempotent tag creation
- `listByContext(context)` — Context-scoped listing
- Hierarchy traversal with circular reference detection and automatic level calculation

## Utilities

- `sanitizeSlug(input)` — Normalize to valid slug format
- `validateSlug(slug)` — Check slug validity
- `generateUniqueSlug(base, existing)` — Generate unique slug
- `calculateLevel(tag, tags)` — Compute hierarchy depth
- `hasCircularReference(tag, tags)` — Detect circular parent references

## Key Patterns

- **Context isolation**: Same tag name can exist in different contexts (e.g., `blog`, `docs`)
- **Slug-based identification**: Tags use slugs, not IDs, for stable references
- **Automatic level tracking**: Level is auto-calculated from parent chain
- **Circular reference prevention**: Validated on save

## Key Exports

`Tag`, `TagCollection`, `TagAlias`, `TagAliasCollection`

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-tenancy`
- `@happyvertical/ai`, `@happyvertical/sql`, `@happyvertical/files`, `@happyvertical/utils`, `@happyvertical/logger`
