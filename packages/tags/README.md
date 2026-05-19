# @happyvertical/smrt-tags

Hierarchical tagging with context-scoped slugs, multi-language aliases, and slug utilities.

## Installation

```bash
pnpm add @happyvertical/smrt-tags
```

## Usage

```typescript
import { Tag, TagCollection, TagAlias, TagAliasCollection } from '@happyvertical/smrt-tags';
import { sanitizeSlug, validateSlug, generateUniqueSlug } from '@happyvertical/smrt-tags';

// Create a tag hierarchy
const collection = await TagCollection.create();

const tech = new Tag({
  slug: 'technology',
  name: 'Technology',
  context: 'blog',  // defaults to 'global' if omitted
});
await collection.create(tech);

// Children reference their parent by UUID (`parentId`). Look the parent
// up by slug first, then create the child. `level` is recalculated by
// `TagCollection.moveTag` / `mergeTag` for moves; you can pass it
// explicitly on create or let it stay at 0 and call moveTag later.
const tech = await collection.get({ slug: 'technology', context: 'blog' });
const ai = new Tag({
  slug: 'artificial-intelligence',
  name: 'Artificial Intelligence',
  context: 'blog',
  parentId: tech!.id,
  level: 1,
});
await collection.create(ai);

// Traverse hierarchy
const children = await tech.getChildren();
const ancestors = await ai.getAncestors();

// Context scoping -- same slug, different contexts
const blogNews = new Tag({ slug: 'news', name: 'News', context: 'blog' });
const forumNews = new Tag({ slug: 'news', name: 'Forum News', context: 'forum' });

// Multi-language aliases
const aliasCollection = await TagAliasCollection.create();
const alias = new TagAlias({
  tagSlug: 'technology',
  alias: 'Tecnologia',
  language: 'es',
  context: 'blog',
});
await aliasCollection.create(alias);

// Collection operations
await collection.moveTag('ai', 'new-parent');       // with circular reference detection
await collection.mergeTag('source', 'target');       // moves children + aliases, deletes source
await collection.cleanupUnused();                    // deletes tags with no children and no aliases

// Slug utilities
sanitizeSlug('My Cool Tag!');   // 'my-cool-tag'
validateSlug('my-tag-123');     // true
```

## API

### Models (SmrtObject)

| Export | Description |
|--------|------------|
| `Tag` | Identified by `slug` + `context`. Hierarchical via `parentId` (UUID, inherited from `SmrtHierarchical`). Denormalised `level` recalculated by `TagCollection.moveTag` / `mergeTag`. JSON `metadata`. Hierarchy methods inherited: `getParent()`, `getChildren()`, `getAncestors()`, `getDescendants()`, `getHierarchy()`, `moveTo()`. Own helpers: `getMetadata()`, `setMetadata()`, `updateMetadata()` |
| `TagAlias` | Language-specific translations: `tagSlug`, `alias`, `language` (ISO 639-1), optional `context` |

### Collections (SmrtCollection)

| Export | Description |
|--------|------------|
| `TagCollection` | CRUD + `getOrCreate()`, `moveTag()`, `mergeTag()`, `cleanupUnused()`, `findWithGlobals()` |
| `TagAliasCollection` | CRUD for tag aliases |

### Utilities

| Export | Description |
|--------|------------|
| `sanitizeSlug(input)` | Clean and format slug strings |
| `validateSlug(slug)` | Validate slug format (lowercase, alphanumeric + hyphens) |
| `generateUniqueSlug(name, context, collection)` | Auto-numbered unique slug generation |
| `calculateLevel(parentSlug, collection)` | Determine hierarchy depth from parent |
| `hasCircularReference(slug, parentSlug, collection)` | Detect circular parent references |

### Types

| Export | Description |
|--------|------------|
| `TagOptions` | Options for `Tag` constructor |
| `TagAliasOptions` | Options for `TagAlias` constructor |
| `TagMetadata` | Flexible metadata structure (colors, icons, statistics) |
| `TagHierarchy` | Complete hierarchy result (ancestors, current, descendants) |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@happyvertical/smrt-core` | ORM base (SmrtObject, SmrtCollection) |
| `@happyvertical/smrt-tenancy` | Optional tenant scoping |
