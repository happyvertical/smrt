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

// `collection.create(...)` returns the saved row, so use it directly
// instead of `new Tag()` + a separate `.create(...)` step. The returned
// instance has its persisted `id` set for use as a parent reference.
const tech = await collection.create({
  slug: 'technology',
  name: 'Technology',
  context: 'blog', // defaults to 'global' if omitted
});

// Children reference their parent by UUID (`parentId`). With `tech`
// already saved, pass `tech.id` directly. `level` is recalculated by
// `TagCollection.moveTag` / `mergeTag` for later moves; you can pass it
// explicitly on create or let it stay at 0 and call moveTag later.
const ai = await collection.create({
  slug: 'artificial-intelligence',
  name: 'Artificial Intelligence',
  context: 'blog',
  parentId: tech.id,
  level: 1,
});

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

// Collection operations. Slug args resolve through (slug, context) —
// pass an explicit context when the same slug exists in multiple
// contexts, otherwise the resolver throws on ambiguity.
await collection.moveTag('artificial-intelligence', 'technology', 'blog'); // cycle-checked
await collection.mergeTag('source', 'target', 'blog');                     // moves children + aliases, deletes source
await collection.cleanupUnused();                                          // deletes tags with no children and no aliases

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
