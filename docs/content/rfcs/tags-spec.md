# @have/tags SPEC.md

## Design Notes

This document outlines the database schema for the `@have/tags` package. The architecture is designed for flexibility, reusability, and multi-language support across all SMRT-based packages.

The key architectural decisions are:

1.  **Context-Based Scoping**: Tags are grouped by `context` (e.g., 'assets', 'content', 'global'), allowing for package-specific or shared tag vocabularies.
2.  **Optional Hierarchies**: Tags can have parent-child relationships via `parent_slug`, enabling taxonomies and category trees.
3.  **Slug-Based Primary Keys**: Human-readable `slug` as the primary key for intuitive queries and URLs.
4.  **Multi-Language Aliases**: A separate `tag_aliases` table supports translations, variations, and alternative spellings.
5.  **Flexible Metadata**: A JSON `metadata` field allows application-specific data (colors, icons, usage counts, etc.) without schema changes.
6.  **Reusable Join Pattern**: Consuming packages implement their own join tables (e.g., `asset_tags`, `content_tags`) for many-to-many relationships.

---

## Core Tables

### Primary Tables

#### `tags`
The central table for tag definitions.

-   `slug`: (String, Primary Key) - Unique identifier within context (e.g., 'electronics', 'user-avatar', 'featured').
-   `name`: (String, Required) - Human-readable display name (e.g., 'Electronics', 'User Avatar', 'Featured').
-   `context`: (String, Required, Default: 'global') - Namespace/grouping (e.g., 'assets', 'content', 'products', 'global').
-   `parent_slug`: (String, FK to `tags.slug`, Nullable) - Points to parent tag for hierarchical taxonomies.
-   `level`: (Integer, Default: 0) - Hierarchy depth (0 = root, 1 = first level, etc.). Auto-calculated.
-   `description`: (Text, Nullable) - Optional description or usage notes.
-   `metadata`: (JSON, Nullable) - Flexible storage for application data.
-   `created_at`: (Datetime) - Timestamp of creation.
-   `updated_at`: (Datetime) - Timestamp of last update.

**Indexes**:
-   Primary key on `slug`
-   Index on `context` for fast context filtering
-   Index on `parent_slug` for hierarchy queries
-   Composite index on `(context, parent_slug)` for listing tags by context and parent

**Constraints**:
-   `parent_slug` must reference a valid `tags.slug` or be NULL
-   `level` must be >= 0

#### `tag_aliases`
Stores alternative names, translations, and variations for tags.

-   `id`: (UUID, Primary Key) - Unique identifier for the alias.
-   `tag_slug`: (String, FK to `tags.slug`, Required) - The tag this alias belongs to.
-   `alias`: (String, Required) - The alternative name or translation.
-   `language`: (String, Nullable) - ISO 639-1 language code (e.g., 'en', 'es', 'fr', 'de'). NULL for language-neutral aliases.
-   `context`: (String, Nullable) - Optional context scoping for the alias.
-   `created_at`: (Datetime) - Timestamp of creation.

**Indexes**:
-   Primary key on `id`
-   Index on `tag_slug` for reverse lookups
-   Index on `alias` for search
-   Composite index on `(alias, language)` for multi-language search

**Constraints**:
-   Unique constraint on `(tag_slug, alias, language, context)` - Prevents duplicate aliases
-   `tag_slug` must reference a valid `tags.slug`

### Join Table Pattern (Implemented by Consuming Packages)

Each package that uses tags creates its own join table following this pattern:

#### Example: `asset_tags`
```sql
CREATE TABLE asset_tags (
  asset_id UUID REFERENCES assets(id) ON DELETE CASCADE,
  tag_slug TEXT REFERENCES tags(slug) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (asset_id, tag_slug)
);
```

#### Example: `content_tags`
```sql
CREATE TABLE content_tags (
  content_id UUID REFERENCES contents(id) ON DELETE CASCADE,
  tag_slug TEXT REFERENCES tags(slug) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (content_id, tag_slug)
);
```

**Key Points**:
-   Each consuming package creates its own join table
-   Join table name follows pattern: `{singular_entity}_tags`
-   Foreign keys reference the package's entity table and `tags.slug`
-   Composite primary key on both IDs prevents duplicates
-   ON DELETE CASCADE ensures cleanup when entities or tags are deleted

---

## SMRT Integration

The `@have/tags` package will be built on the `@have/smrt` framework, leveraging its AI-first object model, ORM capabilities, and code generation tools.

### 1. SMRT Object Implementation

The database tables will be represented as `SmrtObject` classes.

```typescript
import { SmrtObject, SmrtCollection } from '@have/smrt';
import { text, integer, datetime, foreignKey, oneToMany } from '@have/smrt/fields';

// Tag Model
class Tag extends SmrtObject {
  slug = text({ primaryKey: true });
  name = text({ required: true });
  context = text({ default: 'global' });
  parentSlug = foreignKey(Tag, { nullable: true }); // Self-referencing for hierarchy
  level = integer({ default: 0 });
  description = text();
  metadata = text(); // JSON stored as text, parsed on access

  // Relationships
  aliases = oneToMany(TagAlias);
  children = oneToMany(Tag, { foreignKey: 'parentSlug' });

  // Timestamps
  createdAt = datetime({ default: () => new Date() });
  updatedAt = datetime({ default: () => new Date() });

  constructor(options: any = {}) {
    super(options);
    Object.assign(this, options);
  }

  /**
   * Get metadata as parsed object
   */
  getMetadata(): Record<string, any> {
    return this.metadata ? JSON.parse(this.metadata) : {};
  }

  /**
   * Set metadata from object
   */
  setMetadata(data: Record<string, any>): void {
    this.metadata = JSON.stringify(data);
  }
}

// Tag Alias Model
class TagAlias extends SmrtObject {
  tagSlug = foreignKey(Tag, { required: true });
  alias = text({ required: true });
  language = text(); // Nullable
  context = text(); // Nullable

  // Timestamps
  createdAt = datetime({ default: () => new Date() });

  constructor(options: any = {}) {
    super(options);
    Object.assign(this, options);
  }
}
```

### 2. Tag Collection with Context Support

```typescript
import { SmrtCollection } from '@have/smrt';

class TagCollection extends SmrtCollection<Tag> {
  static readonly _itemClass = Tag;

  /**
   * Get or create a tag with context
   */
  async getOrCreate(slug: string, context: string = 'global'): Promise<Tag> {
    return this.getOrUpsert({ slug, context });
  }

  /**
   * List tags by context with optional parent filtering
   */
  async listByContext(context: string, parentSlug?: string): Promise<Tag[]> {
    const where: any = { context };
    if (parentSlug !== undefined) {
      where.parentSlug = parentSlug;
    }
    return this.list({ where });
  }

  /**
   * Get root tags (no parent) for a context
   */
  async getRootTags(context: string = 'global'): Promise<Tag[]> {
    return this.list({
      where: { context, parentSlug: null }
    });
  }

  /**
   * Get tag hierarchy (all ancestors and descendants)
   */
  async getHierarchy(slug: string): Promise<{
    ancestors: Tag[];
    current: Tag;
    descendants: Tag[];
  }> {
    const tag = await this.get({ slug });
    if (!tag) throw new Error(`Tag '${slug}' not found`);

    const ancestors = await this.getAncestors(tag);
    const descendants = await this.getDescendants(tag);

    return { ancestors, current: tag, descendants };
  }

  /**
   * Get all ancestor tags (recursive)
   */
  private async getAncestors(tag: Tag): Promise<Tag[]> {
    const ancestors: Tag[] = [];
    let current = tag;

    while (current.parentSlug) {
      const parent = await this.get({ slug: current.parentSlug });
      if (!parent) break;
      ancestors.unshift(parent); // Add to beginning
      current = parent;
    }

    return ancestors;
  }

  /**
   * Get all descendant tags (recursive)
   */
  private async getDescendants(tag: Tag): Promise<Tag[]> {
    const children = await this.list({ where: { parentSlug: tag.slug } });
    const descendants: Tag[] = [...children];

    for (const child of children) {
      const childDescendants = await this.getDescendants(child);
      descendants.push(...childDescendants);
    }

    return descendants;
  }
}
```

### 3. Tag Alias Management

```typescript
class TagAliasCollection extends SmrtCollection<TagAlias> {
  static readonly _itemClass = TagAlias;

  /**
   * Add an alias to a tag
   */
  async addAlias(
    tagSlug: string,
    alias: string,
    language?: string,
    context?: string
  ): Promise<TagAlias> {
    return this.getOrUpsert({ tagSlug, alias, language, context });
  }

  /**
   * Search tags by alias
   */
  async searchByAlias(
    alias: string,
    language?: string
  ): Promise<Tag[]> {
    const where: any = { alias };
    if (language) where.language = language;

    const aliases = await this.list({ where });
    const tagSlugs = [...new Set(aliases.map(a => a.tagSlug))];

    const tagCollection = new TagCollection(this.options);
    await tagCollection.initialize();

    const tags: Tag[] = [];
    for (const slug of tagSlugs) {
      const tag = await tagCollection.get({ slug });
      if (tag) tags.push(tag);
    }

    return tags;
  }

  /**
   * Get all aliases for a tag
   */
  async getAliasesForTag(tagSlug: string): Promise<TagAlias[]> {
    return this.list({ where: { tagSlug } });
  }
}
```

### 4. Code Generation

The `@have/smrt` code generators will automatically create:

-   **A REST API**: For managing tags from web applications.
-   **A CLI**: For administrative tasks and batch operations.
-   **An MCP Server**: To expose tagging tools to AI agents.

```typescript
// Auto-generated API endpoints:
// GET    /api/v1/tags              - List all tags
// POST   /api/v1/tags              - Create tag
// GET    /api/v1/tags/:slug        - Get tag by slug
// PUT    /api/v1/tags/:slug        - Update tag
// DELETE /api/v1/tags/:slug        - Delete tag

// GET    /api/v1/tag-aliases       - List all aliases
// POST   /api/v1/tag-aliases       - Create alias
// GET    /api/v1/tag-aliases/:id   - Get alias by ID
// DELETE /api/v1/tag-aliases/:id   - Delete alias
```

---

## Integration Pattern for Consuming Packages

### Example: Assets Package Integration

```typescript
// In @have/assets package

import { Tag, TagCollection } from '@have/tags';
import { Asset } from './models/Asset';

class Asset extends SmrtObject {
  // ... existing fields

  /**
   * Add a tag to this asset
   */
  async addTag(tagSlug: string): Promise<void> {
    const tagCollection = new TagCollection(this.options);
    await tagCollection.initialize();

    // Ensure tag exists (get or create)
    const tag = await tagCollection.getOrCreate(tagSlug, 'assets');

    // Insert into asset_tags join table
    const db = await this.getDb();
    await db.execute(
      'INSERT INTO asset_tags (asset_id, tag_slug) VALUES (?, ?) ON CONFLICT DO NOTHING',
      [this.id, tag.slug]
    );
  }

  /**
   * Remove a tag from this asset
   */
  async removeTag(tagSlug: string): Promise<void> {
    const db = await this.getDb();
    await db.execute(
      'DELETE FROM asset_tags WHERE asset_id = ? AND tag_slug = ?',
      [this.id, tagSlug]
    );
  }

  /**
   * Get all tags for this asset
   */
  async getTags(): Promise<Tag[]> {
    const db = await this.getDb();
    const rows = await db.query(
      'SELECT tag_slug FROM asset_tags WHERE asset_id = ?',
      [this.id]
    );

    const tagCollection = new TagCollection(this.options);
    await tagCollection.initialize();

    const tags: Tag[] = [];
    for (const row of rows) {
      const tag = await tagCollection.get({ slug: row.tag_slug });
      if (tag) tags.push(tag);
    }

    return tags;
  }

  /**
   * Check if asset has a specific tag
   */
  async hasTag(tagSlug: string): Promise<boolean> {
    const db = await this.getDb();
    const rows = await db.query(
      'SELECT 1 FROM asset_tags WHERE asset_id = ? AND tag_slug = ? LIMIT 1',
      [this.id, tagSlug]
    );
    return rows.length > 0;
  }
}
```

---

## Core Functions

### Tag Lifecycle
-   `createTag(data)`: Creates a new tag. Requires `slug`, `name`, optionally `context`, `parent_slug`.
-   `getTag(slug, context)`: Retrieves a tag by slug and context.
-   `listTags(options)`: Lists tags with filtering (by context, parent, level).
-   `updateTag(slug, data)`: Updates a tag's properties (name, description, metadata).
-   `deleteTag(slug)`: Deletes a tag and all its aliases (cascades to join tables).

### Hierarchy Management
-   `getRootTags(context)`: Gets all top-level tags (no parent) for a context.
-   `getChildTags(parent_slug)`: Gets immediate children of a parent tag.
-   `getTagHierarchy(slug)`: Gets full hierarchy (ancestors, current, descendants).
-   `moveTag(slug, new_parent_slug)`: Moves a tag to a new parent (updates level automatically).

### Alias Management
-   `addAlias(tag_slug, alias, language, context)`: Creates an alias for a tag.
-   `removeAlias(alias_id)`: Deletes an alias.
-   `getAliasesForTag(tag_slug)`: Gets all aliases for a tag.
-   `searchByAlias(alias, language)`: Finds tags matching an alias.

### Metadata Operations
-   `getTagMetadata(slug)`: Retrieves parsed metadata object.
-   `setTagMetadata(slug, metadata)`: Sets metadata from object (stored as JSON).
-   `updateTagMetadata(slug, updates)`: Merges updates into existing metadata.

### Bulk Operations
-   `bulkCreateTags(tags)`: Creates multiple tags in a transaction.
-   `mergeTag(from_slug, to_slug)`: Merges one tag into another (updates all join tables).
-   `cleanupUnusedTags(context)`: Removes tags with no references in join tables.

---

## Tag Metadata Examples

The `metadata` JSON field supports arbitrary application data:

### UI Styling
```json
{
  "color": "#3b82f6",
  "backgroundColor": "#eff6ff",
  "icon": "tag",
  "emoji": "🏷️"
}
```

### Usage Statistics
```json
{
  "usageCount": 142,
  "lastUsed": "2025-01-15T10:30:00Z",
  "trending": true
}
```

### Display Configuration
```json
{
  "featured": true,
  "sortOrder": 10,
  "showInNav": true,
  "displayFormat": "badge"
}
```

### Custom Application Data
```json
{
  "aiGenerated": true,
  "confidence": 0.95,
  "source": "auto-tagger",
  "reviewStatus": "approved"
}
```

---

## Context Examples

The `context` field enables flexible tag organization:

### Package-Specific Contexts
-   `'assets'` - Tags specific to asset management
-   `'content'` - Tags for content/articles
-   `'products'` - Product categorization tags
-   `'profiles'` - User/profile tags

### Application-Level Contexts
-   `'global'` - Tags shared across all packages
-   `'ui'` - UI/theme-related tags
-   `'workflow'` - Process/status tags

### Multi-Tenancy Contexts
-   `'tenant:acme'` - Tags for specific tenant
-   `'project:alpha'` - Project-specific tags

---

## Hierarchy Examples

### Category Taxonomy
```
Electronics (slug: 'electronics', level: 0)
  ├─ Computers (slug: 'computers', level: 1, parent: 'electronics')
  │   ├─ Laptops (slug: 'laptops', level: 2, parent: 'computers')
  │   └─ Desktops (slug: 'desktops', level: 2, parent: 'computers')
  └─ Mobile (slug: 'mobile', level: 1, parent: 'electronics')
      ├─ Phones (slug: 'phones', level: 2, parent: 'mobile')
      └─ Tablets (slug: 'tablets', level: 2, parent: 'mobile')
```

### Workflow Status
```
In Progress (slug: 'in-progress', level: 0)
  ├─ Draft (slug: 'draft', level: 1, parent: 'in-progress')
  ├─ Review (slug: 'review', level: 1, parent: 'in-progress')
  └─ Revision (slug: 'revision', level: 1, parent: 'in-progress')

Completed (slug: 'completed', level: 0)
  ├─ Published (slug: 'published', level: 1, parent: 'completed')
  └─ Archived (slug: 'archived', level: 1, parent: 'completed')
```

---

## Multi-Language Alias Examples

### Product Tag with Translations
```
Tag: slug='electronics', name='Electronics', context='products'

Aliases:
- 'Elektronik' (language: 'de')
- 'Électronique' (language: 'fr')
- 'Electrónica' (language: 'es')
- '电子产品' (language: 'zh')
```

### Variation Aliases (Same Language)
```
Tag: slug='user-avatar', name='User Avatar', context='assets'

Aliases:
- 'profile picture' (language: 'en')
- 'profile pic' (language: 'en')
- 'avatar' (language: 'en')
- 'user image' (language: 'en')
```

---

## Best Practices

### Slug Naming Conventions
-   Use lowercase kebab-case: `'user-avatar'`, `'featured-content'`
-   Keep slugs concise but descriptive
-   Avoid special characters except hyphens
-   Use context to namespace: tags in different contexts can have same slug

### Context Usage
-   Use `'global'` for tags shared across packages
-   Use package names (`'assets'`, `'content'`) for package-specific tags
-   Consider multi-tenancy: `'tenant:{id}'` for isolated tag vocabularies

### Hierarchy Guidelines
-   Keep hierarchies shallow (3-4 levels max) for usability
-   Use `level` field for efficient queries (auto-calculated on save)
-   Consider circular reference prevention in parent updates

### Metadata Design
-   Store only application-specific data in metadata
-   Use consistent key names across tags
-   Document expected metadata schema for your application
-   Keep metadata lightweight (avoid large objects)

### Alias Strategy
-   Add common misspellings as aliases
-   Include abbreviations and acronyms
-   Provide translations for multi-language support
-   Use `language: null` for language-neutral variations

---

## Migration from Other Tag Systems

### Simple Flat Tags → Hierarchical
```typescript
// Convert flat tags to hierarchical
async function convertToHierarchy(
  flatTags: string[],
  categoryMap: Record<string, string> // tag -> category
) {
  const tagCollection = new TagCollection(options);

  // Create categories first (root level)
  const categories = [...new Set(Object.values(categoryMap))];
  for (const category of categories) {
    await tagCollection.getOrCreate(category, 'products');
  }

  // Create tags with parents
  for (const tag of flatTags) {
    const parent = categoryMap[tag];
    await tagCollection.create({
      slug: tag,
      name: tag,
      context: 'products',
      parentSlug: parent || null,
    });
  }
}
```

### Adding Context to Existing Tags
```typescript
// Migrate global tags to package-specific contexts
async function migrateToContext(oldContext: string, newContext: string) {
  const tagCollection = new TagCollection(options);
  const tags = await tagCollection.listByContext(oldContext);

  for (const tag of tags) {
    tag.context = newContext;
    await tag.save();
  }
}
```

---

## Performance Considerations

### Indexing Strategy
-   Index on `context` for fast filtering by package
-   Index on `parent_slug` for hierarchy traversal
-   Composite index on `(alias, language)` for multi-language search
-   Consider full-text search index on `name` and `alias` for large datasets

### Caching Recommendations
-   Cache frequently used tag hierarchies
-   Cache tag → aliases mapping for search
-   Invalidate cache on tag updates/deletes
-   Use context-scoped cache keys

### Query Optimization
-   Use `level` field to limit recursion depth in hierarchy queries
-   Batch load tags when fetching entities with tags
-   Consider materialized path for deep hierarchies (alternative to recursive queries)

---

## Security Considerations

### Input Validation
-   Sanitize slug input (lowercase, alphanumeric + hyphens only)
-   Validate context values against allowed list
-   Prevent circular parent references
-   Limit hierarchy depth to prevent abuse

### Access Control
-   Implement context-based permissions (e.g., only 'assets' package can create 'assets' tags)
-   Consider read vs. write permissions for tags
-   Audit tag creation/updates in multi-tenant environments

---

## Future Enhancements

Potential features for future versions:

1.  **Tag Merging UI**: Visual tool for merging duplicate tags
2.  **Auto-Tagging**: AI-powered tag suggestions based on content
3.  **Tag Analytics**: Usage trends, popularity metrics
4.  **Tag Validation Rules**: Required tags, mutually exclusive tags
5.  **Versioning**: Track tag definition changes over time
6.  **Materialized Paths**: Alternative hierarchy implementation for better performance
7.  **Tag Templates**: Pre-defined tag sets for common use cases

---

This specification provides a solid foundation for a flexible, scalable tagging system that can be reused across all SMRT-based packages in the HAVE SDK.
