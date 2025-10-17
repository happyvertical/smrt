---
id: "content"
title: "@smrt/content: Content Processing Module"
sidebar_label: "@smrt/content"
sidebar_position: 6
---

# @smrt/content

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Content processing module for SMRT framework - handles documents, web content, and media with AI-powered analysis capabilities.

## Overview

The `@smrt/content` package is a SMRT-specific module that provides comprehensive content processing capabilities. It handles document extraction (PDFs, text files, web content), content management with metadata, AI-powered content analysis, and filesystem synchronization. Built on top of the SMRT framework, it automatically generates REST APIs, AI tools (MCP), and CLI commands for all content operations.

The package provides:

- **Document Processing**: Extract text from PDFs (with OCR support), text files, and remote URLs
- **Content Management**: Structured content objects with metadata, versioning, and reference tracking
- **Web Content Mirroring**: Download and cache content from remote sources with automatic text extraction
- **AI Integration**: Built-in content analysis via SMRT's `do()` and `is()` methods
- **Filesystem Export**: Write content as markdown files with YAML frontmatter
- **Collection Operations**: Batch processing, advanced querying, and content organization
- **REST API**: Auto-generated CRUD endpoints for all content operations
- **MCP Tools**: AI-accessible tools for content management

## Features

- **Document Text Extraction**: Extract text from PDFs (with OCR), text files, HTML, and JSON
- **Web Content Scraping**: Download and process content from remote URLs with automatic caching
- **Content Classification**: Type, variant, and status fields for flexible content organization
- **Reference Management**: Track relationships between content objects
- **Metadata Support**: Flexible JSON metadata for schema extension
- **Markdown Export**: Generate markdown files with YAML frontmatter in organized directory structures
- **AI-Powered Analysis**: Use inherited SMRT methods for summaries, classification, and transformations
- **Context Isolation**: Namespace content by context for multi-project organization
- **Batch Operations**: Process multiple content objects with collection methods
- **Automatic Caching**: Avoid reprocessing documents with built-in cache management
- **REST API Generation**: Full CRUD operations auto-generated via @smrt decorator
- **MCP Server Integration**: AI-accessible tools for content creation and management
- **CLI Support**: Command-line interface for content operations

## Installation

```bash
# Install with pnpm (recommended for monorepo)
pnpm add @smrt/content

# Or with npm
npm install @smrt/content

# Or with bun
bun add @smrt/content
```

## Quick Start

### Basic Content Management

```typescript
import { Content, Contents } from '@smrt/content';

// Initialize collection with database configuration
const contents = await Contents.create({
  db: { url: 'sqlite:./content.db' }
});

// Create and save content
const article = new Content({
  title: 'AI in Content Processing',
  body: 'Large language models have revolutionized content analysis...',
  type: 'article',
  author: 'Research Team',
  status: 'published',
  tags: ['ai', 'nlp', 'content-processing'],
  metadata: {
    category: 'technology',
    readingTime: 15
  }
});

await article.initialize();
await article.save();

// Use AI-powered analysis
const summary = await article.do('Create a 2-sentence summary');
const isAcademic = await article.is('written in academic style');
const topics = await article.do('Extract key topics as JSON array');
```

### Web Content Mirroring

```typescript
import { Contents } from '@smrt/content';

const contents = await Contents.create({
  db: { url: 'sqlite:./mirrors.db' }
});

// Mirror content from URL (automatically extracts text)
const mirrored = await contents.mirror({
  url: 'https://example.com/article.html',
  context: 'research_sources',
  mirrorDir: './cache'
});

console.log(mirrored.title); // Auto-generated from filename
console.log(mirrored.body);  // Extracted text content
console.log(mirrored.type);  // 'mirror'
```

### Document Processing

```typescript
import { fetchDocument } from '@have/documents';
import { Content } from '@smrt/content';

// Process a PDF document
const doc = await fetchDocument('https://example.com/paper.pdf', {
  cacheDir: './cache'
});

// Extract text from document parts
const text = doc.parts.map(part => part.content).join('\n\n');

// Create content from extracted text
const content = new Content({
  title: 'Research Paper',
  body: text,
  type: 'document',
  source: 'pdf_extraction',
  original_url: 'https://example.com/paper.pdf'
});

await content.initialize();
await content.save();
```

### Content Export and Sync

```typescript
import { Contents } from '@smrt/content';

const contents = await Contents.create({
  db: { url: 'sqlite:./content.db' },
  contentDir: './exported-content'
});

// Export all article-type content as markdown files
await contents.syncContentDir({
  contentDir: './blog-posts'
});

// Export individual content with YAML frontmatter
await contents.writeContentFile({
  content: article,
  contentDir: './markdown-files'
});
// Creates: ./markdown-files/{context}/{slug}/index.md
```

## Usage

### Creating and Managing Content

```typescript
import { Content, Contents } from '@smrt/content';

// Initialize collection
const contents = await Contents.create({
  db: { url: 'sqlite:./content.db' },
  ai: { type: 'openai', apiKey: process.env.OPENAI_API_KEY }
});

// Create content with comprehensive metadata
const content = new Content({
  title: 'Advanced TypeScript Patterns',
  body: 'TypeScript provides powerful type system features...',
  type: 'article',
  variant: 'tutorial:typescript:advanced',
  author: 'Engineering Team',
  description: 'Deep dive into advanced TypeScript patterns',
  publish_date: new Date(),
  source: 'technical_blog',
  status: 'published',
  state: 'active',
  tags: ['typescript', 'programming', 'patterns'],
  language: 'en',
  metadata: {
    category: 'programming',
    difficulty: 'advanced',
    readingTime: 20,
    prerequisites: ['typescript-basics', 'javascript']
  }
});

await content.initialize();
await content.save();
```

### Querying Content

```typescript
// Get content by ID
const content = await contents.get({ id: 'content-id' });

// Get or create content (unique by slug + context)
const article = await contents.getOrUpsert({
  title: 'Unique Article',
  slug: 'unique-article',
  context: 'blog',
  body: 'Article content'
});

// List content with filtering
const published = await contents.list({
  where: {
    type: 'article',
    status: 'published',
    state: 'active'
  },
  limit: 10,
  offset: 0
});

// Filter by tags (using metadata)
const aiArticles = await contents.list({
  where: { type: 'article' }
}).then(items => items.filter(c => c.tags.includes('ai')));
```

### Working with References

```typescript
// Add references between content pieces
const sourceArticle = new Content({ title: 'Source Material' });
await sourceArticle.initialize();

const derivedArticle = new Content({ title: 'Analysis' });
await derivedArticle.initialize();

// Add content reference
await derivedArticle.addReference(sourceArticle);

// Add URL reference
await derivedArticle.addReference('https://external-source.com/article');

// Get all references
const references = await derivedArticle.getReferences();
console.log(references); // [sourceArticle, Content { url: 'https://...' }]
```

### AI-Powered Content Operations

```typescript
// Content analysis and transformation using inherited SMRT methods
const content = await contents.get({ slug: 'my-article' });

// Generate summaries
const summary = await content.do('Create a 2-sentence summary');
const tldr = await content.do('Generate a TL;DR in bullet points');

// Classification
const isAcademic = await content.is('written in academic style');
const isOpinionated = await content.is('expressing strong opinions');

// Extraction
const topics = await content.do('Extract key topics as JSON array');
const keywords = await content.do('List the 10 most important keywords');

// Content transformation
const simplified = await content.do('Rewrite at 5th grade reading level');
const translated = await content.do('Translate to Spanish');
```

### Context-Based Organization

```typescript
// Use context to organize content into logical namespaces
const contents = await Contents.create({
  db: { url: 'sqlite:./content.db' }
});

// Organize by source
await contents.mirror({
  url: 'https://blog.com/post',
  context: 'blog-posts'
});

await contents.mirror({
  url: 'https://docs.com/api',
  context: 'documentation'
});

// Organize by project
await contents.getOrUpsert({
  title: 'Project A Notes',
  slug: 'notes',
  context: 'project-a',
  body: 'Project notes...'
});

await contents.getOrUpsert({
  title: 'Project B Notes',
  slug: 'notes', // Same slug, different context
  context: 'project-b',
  body: 'Different project notes...'
});

// These are two different content objects (unique by slug + context)
```

### Markdown Utilities

```typescript
import { contentToString, stringToContent } from '@smrt/content';

// Convert content to markdown with YAML frontmatter
const markdown = contentToString(article);
console.log(markdown);
/*
---
title: My Article
author: John Doe
status: published
tags:
  - ai
  - content
---
Article body content here...
*/

// Parse markdown string back to content data
const contentData = stringToContent(markdown);
const restoredContent = new Content(contentData);
await restoredContent.initialize();
```

### Advanced Export Patterns

```typescript
// Custom sync with filtering
const contents = await Contents.create({
  db: { url: 'sqlite:./content.db' }
});

// Export only published articles
const articles = await contents.list({
  where: {
    type: 'article',
    status: 'published'
  }
});

for (const article of articles) {
  await contents.writeContentFile({
    content: article,
    contentDir: './site/content'
  });
}

// Export with custom organization
const byAuthor = await contents.list({
  where: { status: 'published' }
});

for (const content of byAuthor) {
  const authorSlug = content.author?.toLowerCase().replace(/\s+/g, '-') || 'unknown';
  await contents.writeContentFile({
    content,
    contentDir: `./authors/${authorSlug}`
  });
}
```

### Error Handling

```typescript
// Mirror with error handling
try {
  const content = await contents.mirror({
    url: userProvidedUrl,
    mirrorDir: './cache'
  });
} catch (error) {
  if (error.message.includes('Invalid URL')) {
    console.error('Please provide a valid URL');
  } else {
    console.error('Failed to mirror content:', error);
  }
}

// Check for duplicates before mirroring
const url = 'https://example.com/article';
const existing = await contents.get({ url });

if (existing) {
  console.log('Content already mirrored:', existing.id);
} else {
  const mirrored = await contents.mirror({ url });
}
```

## REST API Server

The package includes auto-generated REST API endpoints via the SMRT framework.

### Starting the Server

```typescript
import { startRestServer } from '@smrt/core';
import { Content } from '@smrt/content';

// Start server with Content endpoints
const shutdown = await startRestServer(
  [Content],
  {},
  {
    port: 3100,
    hostname: 'localhost',
    basePath: '/api/v1',
    enableCors: true
  }
);
```

### API Endpoints

All endpoints are automatically generated from the `@smrt()` decorator:

```bash
# List contents (with filtering and pagination)
GET /api/v1/contents?type=article&status=published&limit=10&offset=0

# Get specific content
GET /api/v1/contents/:id

# Create content
POST /api/v1/contents
Content-Type: application/json
{
  "title": "New Article",
  "body": "Article content",
  "type": "article",
  "status": "draft"
}

# Update content
PUT /api/v1/contents/:id
Content-Type: application/json
{
  "status": "published"
}

# Delete content
DELETE /api/v1/contents/:id
```

### Example API Usage

```bash
# Create content
curl -X POST http://localhost:3100/api/v1/contents \
  -H "Content-Type: application/json" \
  -d '{
    "title": "AI Tutorial",
    "body": "Introduction to AI...",
    "type": "article",
    "status": "draft",
    "tags": ["ai", "tutorial"]
  }'

# List all published articles
curl "http://localhost:3100/api/v1/contents?type=article&status=published"

# Get specific content
curl http://localhost:3100/api/v1/contents/abc123

# Update content status
curl -X PUT http://localhost:3100/api/v1/contents/abc123 \
  -H "Content-Type: application/json" \
  -d '{"status": "published"}'
```

## API Reference

### Classes

#### Content
Main content data model extending `SmrtObject`.

**Properties:**
- `type` (string|null): Content classification (e.g., 'article', 'document', 'mirror')
- `variant` (string|null): Namespaced classification (format: generator:domain:specific-type)
- `fileKey` (string|null): Reference to file storage location
- `author` (string|null): Content author name
- `title` (string): Content title
- `description` (string|null): Short summary or description
- `body` (string): Main content text
- `publish_date` (Date|null): Publication date
- `url` (string|null): URL source of content
- `source` (string|null): Original source identifier
- `original_url` (string|null): Original URL if mirrored/copied
- `language` (string|null): Content language code
- `tags` (string[]): Array of content tags
- `status` ('published'|'draft'|'archived'|'deleted'): Publication status
- `state` ('deprecated'|'active'|'highlighted'): Content state flag
- `metadata` (Record<string, any>): Flexible JSON metadata

**Methods:**
- `initialize()`: Sets up content instance
- `save()`: Persists to database (inherited from SmrtObject)
- `delete()`: Removes from database (inherited from SmrtObject)
- `addReference(content)`: Add reference to related content
- `getReferences()`: Retrieve all referenced content objects
- `do(prompt)`: AI-powered content operation (inherited from SmrtObject)
- `is(question)`: AI-powered content classification (inherited from SmrtObject)
- `toJSON()`: Serialize to plain JSON object

#### Contents
Collection manager for Content objects extending `SmrtCollection<Content>`.

**Methods:**
- `Contents.create(options)`: Static factory method for proper initialization
- `get(where)`: Find single content by criteria
- `list(options)`: Query multiple contents with filtering
- `getOrUpsert(data)`: Get existing or create new content (unique by slug + context)
- `add(content)`: Add content to collection
- `mirror(options)`: Download and extract content from URL
- `writeContentFile(options)`: Export content to markdown file
- `syncContentDir(options)`: Export all article-type content to directory

### Types

```typescript
interface ContentOptions extends SmrtObjectOptions {
  type?: string | null;
  variant?: string | null;
  fileKey?: string | null;
  author?: string | null;
  title?: string | null;
  description?: string | null;
  body?: string | null;
  publish_date?: Date | null;
  url?: string | null;
  source?: string | null;
  status?: 'published' | 'draft' | 'archived' | 'deleted' | null;
  state?: 'deprecated' | 'active' | 'highlighted' | null;
  original_url?: string | null;
  language?: string | null;
  tags?: string[];
  metadata?: Record<string, any>;
}

interface ContentsOptions extends SmrtCollectionOptions {
  ai?: AIClientOptions;
  contentDir?: string;
}
```

### Utility Functions

```typescript
// Convert content to markdown with YAML frontmatter
function contentToString(content: Content): string;

// Parse markdown with frontmatter to content data
function stringToContent(data: string): object;
```

For complete API documentation, see the [SMRT documentation](https://happyvertical.github.io/smrt/api/content/globals).

## TypeScript Support

The package is written in TypeScript and provides comprehensive type definitions:

```typescript
import type {
  Content,
  ContentOptions,
  Contents,
  ContentsOptions
} from '@smrt/content';
```

## Development

### Commands

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Run tests in watch mode
pnpm run test:watch

# Build package
pnpm run build

# Build in watch mode
pnpm run build:watch

# Start REST API server
bun src/server.ts
# Access at: http://localhost:3100/api/v1
```

### Testing

Tests use Vitest with unique database instances to avoid conflicts:

```typescript
import os from 'node:os';
import path from 'node:path';
import { Contents } from '@smrt/content';

const TMP_DIR = path.resolve(`${os.tmpdir()}/.smrt-tests/content`);

function getTestDbUrl(testName: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  return `file:${TMP_DIR}/${testName}-${timestamp}-${random}.db`;
}

// Use in tests
const contents = await Contents.create({
  db: { url: getTestDbUrl('my-test') }
});
```

## Dependencies

### Internal SMRT Dependencies
- **@smrt/core**: Core SMRT framework with ORM and code generation

### External Dependencies
- **@have/documents**: Document fetching and processing
- **@have/files**: File system operations and caching
- **@have/pdf**: PDF text extraction
- **@have/spider**: Web content scraping
- **@have/ocr**: Optical Character Recognition
- **@have/utils**: Utility functions
- **yaml**: YAML parsing and stringification

## License

This package is part of the SMRT Framework and is licensed under the MIT License - see the [LICENSE](../../LICENSE) file for details.
