---
id: tags
title: "@smrt/tags: Hierarchical Tagging System"
sidebar_label: "@smrt/tags"
sidebar_position: 10
---

# @smrt/tags

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Reusable tagging system with hierarchies, contexts, and multi-language support for SMRT framework.

## Overview

The `@smrt/tags` package provides a comprehensive tagging system for organizing and categorizing content in SMRT applications. Built on the SMRT framework, it offers hierarchical tag structures (parent-child relationships), context-based scoping for namespace isolation, multi-language aliases for internationalization, and flexible metadata storage for application-specific customization.

Tags are ideal for:
- **Content Categorization**: Organize articles, documents, and media
- **Taxonomy Management**: Build category trees and classification systems
- **Multi-Language Support**: Provide localized tag names and synonyms
- **Hierarchical Organization**: Create nested tag structures with unlimited depth
- **Context Isolation**: Separate tags by application domain or tenant

## Features

- **Hierarchical Structure**: Parent-child relationships with automatic level tracking
- **Context Scoping**: Namespace isolation for multi-tenant or domain-specific tags
- **Multi-Language Support**: Tag aliases with language codes (ISO 639-1)
- **Flexible Metadata**: JSON storage for custom properties (colors, icons, statistics)
- **Slug-Based Identification**: URL-friendly unique identifiers
- **Relationship Traversal**: Query ancestors, descendants, children, and parents
- **Circular Reference Prevention**: Validates hierarchy integrity
- **Auto-Generated APIs**: REST endpoints, CLI commands, and MCP tools included
- **Type-Safe Operations**: Full TypeScript support with comprehensive types

## Installation

```bash
# Install with pnpm (recommended for SMRT projects)
pnpm add @smrt/tags

# Or with npm
npm install @smrt/tags

# Or with bun
bun add @smrt/tags
```

## Usage

### Basic Tag Creation

```typescript
import { Tag, TagCollection } from '@smrt/tags';

// Create a root tag
const techTag = new Tag({
  slug: 'technology',
  name: 'Technology',
  context: 'blog',
  description: 'All things tech',
});

// Save to database
const collection = await TagCollection.create();
await collection.create(techTag);
```

### Hierarchical Tags

```typescript
// Create a parent-child hierarchy
const aiTag = new Tag({
  slug: 'artificial-intelligence',
  name: 'Artificial Intelligence',
  context: 'blog',
  parentSlug: 'technology', // Link to parent
  level: 1, // Child of root
});

await collection.create(aiTag);

// Create a deeper hierarchy
const mlTag = new Tag({
  slug: 'machine-learning',
  name: 'Machine Learning',
  context: 'blog',
  parentSlug: 'artificial-intelligence',
  level: 2, // Grandchild of root
});

await collection.create(mlTag);
```

### Querying Tag Relationships

```typescript
// Get immediate children
const children = await techTag.getChildren();
console.log('Children:', children.map(t => t.name));
// Output: ['Artificial Intelligence']

// Get all descendants (recursive)
const descendants = await techTag.getDescendants();
console.log('All descendants:', descendants.map(t => t.name));
// Output: ['Artificial Intelligence', 'Machine Learning']

// Get ancestors (path to root)
const ancestors = await mlTag.getAncestors();
console.log('Path:', ancestors.map(t => t.name));
// Output: ['Technology', 'Artificial Intelligence']

// Get parent
const parent = await mlTag.getParent();
console.log('Parent:', parent?.name);
// Output: 'Artificial Intelligence'
```

### Context-Based Scoping

```typescript
// Create tags in different contexts
const blogTag = new Tag({
  slug: 'news',
  name: 'News',
  context: 'blog', // Blog namespace
});

const forumTag = new Tag({
  slug: 'news',
  name: 'Forum News',
  context: 'forum', // Forum namespace
});

// Same slug, different contexts - no conflict!
await collection.create(blogTag);
await collection.create(forumTag);

// Query by context
const blogTags = await collection.list({
  where: { context: 'blog' },
});

const forumTags = await collection.list({
  where: { context: 'forum' },
});
```

### Multi-Language Aliases

```typescript
import { TagAlias, TagAliasCollection } from '@smrt/tags';

// Create tag
const devTag = new Tag({
  slug: 'development',
  name: 'Development',
  context: 'global',
});
await collection.create(devTag);

// Add translations
const aliasCollection = await TagAliasCollection.create();

const spanishAlias = new TagAlias({
  tagSlug: 'development',
  alias: 'Desarrollo',
  language: 'es',
  context: 'global',
});

const frenchAlias = new TagAlias({
  tagSlug: 'development',
  alias: 'Développement',
  language: 'fr',
  context: 'global',
});

await aliasCollection.create(spanishAlias);
await aliasCollection.create(frenchAlias);

// Search by alias
const aliases = await aliasCollection.list({
  where: { tagSlug: 'development' },
});
console.log('Translations:', aliases.map(a => `${a.language}: ${a.alias}`));
// Output: ['es: Desarrollo', 'fr: Développement']
```

### Custom Metadata

```typescript
// Create tag with custom metadata
const featuredTag = new Tag({
  slug: 'featured',
  name: 'Featured',
  context: 'blog',
});

// Set metadata
featuredTag.setMetadata({
  color: '#ff6b6b',
  backgroundColor: '#ffe0e0',
  icon: 'star',
  emoji: '⭐',
  featured: true,
  sortOrder: 1,
  usageCount: 0,
});

await collection.create(featuredTag);

// Read metadata
const metadata = featuredTag.getMetadata();
console.log('Tag color:', metadata.color);
console.log('Is featured:', metadata.featured);

// Update specific metadata fields
featuredTag.updateMetadata({
  usageCount: 42,
  lastUsed: new Date().toISOString(),
});

await collection.update(featuredTag);
```

### Slug Utilities

```typescript
import {
  sanitizeSlug,
  validateSlug,
  generateUniqueSlug,
  calculateLevel,
  hasCircularReference,
} from '@smrt/tags';

// Sanitize user input
const cleanSlug = sanitizeSlug('My Cool Tag!');
console.log(cleanSlug); // 'my-cool-tag'

// Validate slug format
const isValid = validateSlug('my-tag-123');
console.log(isValid); // true

const isInvalid = validateSlug('My Tag!');
console.log(isInvalid); // false

// Generate unique slug
const collection = await TagCollection.create();
const uniqueSlug = await generateUniqueSlug(
  'Technology',
  'blog',
  collection
);
// If 'technology' exists, returns 'technology-1', 'technology-2', etc.

// Calculate hierarchy level
const level = await calculateLevel('parent-slug', collection);
console.log('Level:', level); // Parent's level + 1

// Prevent circular references
const isCircular = await hasCircularReference(
  'technology',
  'artificial-intelligence',
  collection
);
if (isCircular) {
  console.error('Cannot create circular reference!');
}
```

### Working with Collections

```typescript
import { TagCollection } from '@smrt/tags';

const collection = await TagCollection.create({
  database: './my-tags.db', // SQLite database path
});

// List all tags
const allTags = await collection.list();

// Filter by context
const blogTags = await collection.list({
  where: { context: 'blog' },
});

// Get root tags (no parent)
const rootTags = await collection.list({
  where: { parentSlug: '', level: 0 },
});

// Search by name
const searchResults = await collection.list({
  where: { name: { $like: '%tech%' } },
});

// Get single tag
const tag = await collection.get({ slug: 'technology' });

// Update tag
if (tag) {
  tag.description = 'Updated description';
  await collection.update(tag);
}

// Delete tag (orphans children - consider handling that)
await collection.delete({ slug: 'technology' });
```

### Integration Example: Blog Post Tagging

```typescript
import { Tag, TagCollection } from '@smrt/tags';

// Define your blog post interface
interface BlogPost {
  id: string;
  title: string;
  content: string;
  tagSlugs: string[]; // Store tag slugs
}

// Create and assign tags
async function tagBlogPost(post: BlogPost, tagNames: string[]) {
  const collection = await TagCollection.create();

  for (const name of tagNames) {
    const slug = sanitizeSlug(name);

    // Create tag if it doesn't exist
    let tag = await collection.get({ slug, context: 'blog' });
    if (!tag) {
      tag = new Tag({
        slug,
        name,
        context: 'blog',
      });
      await collection.create(tag);
    }

    // Add to post
    if (!post.tagSlugs.includes(slug)) {
      post.tagSlugs.push(slug);
    }
  }

  return post;
}

// Retrieve tag objects for display
async function getPostTags(post: BlogPost): Promise<Tag[]> {
  const collection = await TagCollection.create();
  const tags: Tag[] = [];

  for (const slug of post.tagSlugs) {
    const tag = await collection.get({ slug, context: 'blog' });
    if (tag) tags.push(tag);
  }

  return tags;
}
```

## API Reference

### Core Classes

- **`Tag`**: Main tag entity with hierarchy support
  - Properties: `slug`, `name`, `context`, `parentSlug`, `level`, `description`, `metadata`
  - Methods: `getParent()`, `getChildren()`, `getAncestors()`, `getDescendants()`, `getMetadata()`, `setMetadata()`, `updateMetadata()`

- **`TagCollection`**: CRUD operations for tags
  - Methods: `create()`, `get()`, `list()`, `update()`, `delete()`

- **`TagAlias`**: Multi-language aliases and variations
  - Properties: `tagSlug`, `alias`, `language`, `context`
  - Methods: `getTag()`

- **`TagAliasCollection`**: CRUD operations for aliases
  - Methods: `create()`, `get()`, `list()`, `update()`, `delete()`

### Utility Functions

- **`sanitizeSlug(input)`**: Clean and format slug strings
- **`validateSlug(slug)`**: Validate slug format (lowercase, alphanumeric + hyphens)
- **`generateUniqueSlug(name, context, collection)`**: Create unique slugs with auto-numbering
- **`calculateLevel(parentSlug, collection)`**: Determine hierarchy depth
- **`hasCircularReference(slug, parentSlug, collection)`**: Check for circular hierarchies

### Type Definitions

- **`TagOptions`**: Options for creating Tag instances
- **`TagAliasOptions`**: Options for creating TagAlias instances
- **`TagMetadata`**: Flexible metadata structure (colors, icons, statistics, etc.)
- **`TagHierarchy`**: Complete hierarchy result (ancestors, current, descendants)

For complete API documentation, see the generated TypeDoc documentation at `/api/tags/globals`.

## License

This package is part of the SMRT Framework and is licensed under the MIT License - see the [LICENSE](../../LICENSE) file for details.
