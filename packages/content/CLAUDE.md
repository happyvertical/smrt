# @have/content: Content Processing Module

## Purpose and Responsibilities

The `@have/content` package is a SMRT-specific module that provides comprehensive content processing capabilities for the HAVE SDK. It is **not part of the main build pipeline** and is designed specifically for use with the SMRT framework. The package handles:

- **Document Processing**: Unified interface for working with documents (PDFs, text files, web content)
- **Content Management**: Structured content objects with metadata, versioning, and references
- **AI Integration**: Built-in AI-powered content analysis via SMRT's inherited methods
- **Collection Operations**: Batch processing, querying, and content organization
- **File System Integration**: Content mirroring, caching, and markdown export
- **Web Content Processing**: URL-based content extraction and analysis

This package was intentionally separated from the core SMRT framework to maintain modularity while providing specialized content processing capabilities.

## Architecture and Status

**Package Location**: `packages/content/` (SMRT-specific module in smrt/ directory)
**Build Status**: Excluded from main build pipeline
**Integration**: Requires SMRT framework for full functionality
**Target Environment**: Node.js only
**Build Tool**: Vite (library mode for package builds, dev mode with Svelte for UI)
**Version**: 0.4.1

## Core Components

### Content Class (`content.ts`)
The primary data model representing structured content objects with comprehensive metadata.

**Extends**: `SmrtObject` - Inherits database persistence, AI methods, and SMRT framework capabilities

**Key Properties**:
- `type` (string|null): Content classification (e.g., 'article', 'document', 'mirror')
- `fileKey` (string|null): Reference to file storage location
- `author` (string|null): Content author name
- `title` (string): Content title (required, defaults to empty string)
- `description` (string|null): Short summary or description
- `body` (string): Main content text (required, defaults to empty string)
- `publish_date` (Date|null): Publication date
- `url` (string|null): URL source of content
- `source` (string|null): Original source identifier
- `original_url` (string|null): Original URL if mirrored/copied
- `language` (string|null): Content language code
- `tags` (string[]): Array of content tags
- `status` ('published'|'draft'|'archived'|'deleted'): Publication status (default: 'draft')
- `state` ('deprecated'|'active'|'highlighted'): Content state flag (default: 'active')
- `metadata` (Record<string, any>): Flexible JSON metadata for schema extension

**SMRT Decorators**:
```typescript
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true
})
```

**Key Methods**:
- `initialize()`: Sets up content instance, syncs title to name field
- `addReference(content: Content | string)`: Add reference to related content
- `getReferences()`: Retrieve all referenced content objects
- `loadReferences()`: Load reference network (currently no-op, extensible)
- `toJSON()`: Serialize to plain JSON object
- Inherited: `save()`, `delete()`, `do()`, `is()` from SmrtObject

**Important Notes**:
- Title is automatically synced to `name` property during initialization for SmrtObject compatibility
- References are stored in protected `references` array, not persisted to database (extensible design)
- Full REST API automatically generated via @smrt decorator
- MCP tools enable AI-powered content management

### Contents Class (`contents.ts`)
Collection manager for Content objects with advanced batch operations.

**Extends**: `SmrtCollection<Content>` - Inherits batch operations, querying, and collection management

**Configuration**:
- `contentDir` (string): Directory for exporting content as markdown files
- `ai` (AIClientOptions): AI client configuration for inherited capabilities
- Inherits database configuration from SmrtCollection

**Static Factory**:
```typescript
static async create(options: ContentsOptions): Promise<Contents>
```
Use this instead of direct instantiation to ensure proper initialization.

**Key Methods**:

**`mirror(options: { url: string; mirrorDir?: string; context?: string })`**
- Downloads and stores content from remote URL
- Extracts text using Document class
- Auto-generates title/slug from filename
- Checks for existing content by URL (won't duplicate)
- Returns Content object with type='mirror'
- Throws error if URL is invalid or missing

**`writeContentFile(options: { content: Content; contentDir: string })`**
- Exports Content to filesystem as markdown with YAML frontmatter
- Path structure: `{contentDir}/{context}/{slug}/index.md`
- Auto-formats plain text to markdown paragraphs
- Detects existing markdown to preserve formatting
- Includes title, slug, context, author, publish_date in frontmatter

**`syncContentDir(options: { contentDir?: string })`**
- Syncs all article-type content to filesystem
- Filters by `type: 'article'` automatically
- Calls writeContentFile for each matching content
- Uses configured contentDir if not provided

**`getOrUpsert(data: ContentOptions)`**
- Gets existing content or creates new one
- Inherited from SmrtCollection
- Respects slug + context uniqueness

**Private Methods**:
- `isMarkdown(text)`: Detects markdown syntax patterns
- `formatAsMarkdown(text)`: Converts plain text to basic markdown

**Important Notes**:
- Mirror checks for duplicates using URL before creating
- Context field is important for organizing content (included in file paths and uniqueness)
- Loading cache (`loaded` Map) available for performance optimization
- Access database via `getDb()` method

### Document Class (`document.ts`)
Specialized handler for extracting text from various document types.

**Supported File Types**:
- **PDFs**: Via @have/pdf package with OCR fallback
- **Text files**: .txt, .md, .json, .xml, .html, .css, .js, .ts, .yaml, .yml
- **Web content**: Remote URLs via Spider package
- **Detection**: Automatic MIME type detection or file extension fallback

**Configuration**:
```typescript
interface DocumentOptions {
  fs?: FilesystemAdapter;
  cacheDir?: string;           // Default: os.tmpdir()/.cache/have-sdk
  url?: string;                // file://, http://, https:// URLs
  localPath?: string;          // Override computed local path
  type?: string;               // MIME type override
}
```

**Static Factory**:
```typescript
static async create(options: DocumentOptions): Promise<Document>
```
Handles initialization and downloads remote files automatically.

**Key Properties**:
- `url` (URL): Parsed URL object
- `type` (string): MIME type
- `localPath` (string, read-only): Local file path (computed or provided)
- `cacheDir` (string, read-only): Cache directory location
- `isRemote` (boolean, protected): Flag for remote vs local files

**Key Methods**:

**`getText()`**
- Extracts text content from document
- Uses caching (`.extracted_text` suffix) to avoid reprocessing
- PDF extraction via @have/pdf's getPDFReader()
- Text file reading via fs.readFile
- Throws error for unsupported types
- Returns extracted text string

**`isTextFile()`**
- Checks if file can be read as plain text
- Checks MIME type patterns (text/*, application/json, etc.)
- Checks file extension fallbacks
- Returns boolean

**`initialize()`**
- Downloads remote files to cache directory
- Uses downloadFileWithCache from @have/files
- No-op for local files
- Called automatically by static create()

**Important Implementation Details**:
- Remote file paths: `{cacheDir}/{hostname-slug}/{pathname}`
- Local file paths: Direct from file:// URL pathname
- Caching uses @have/files getCached/setCached with `.extracted_text` suffix
- MIME type detection via getMimeType from @have/files
- PDF processing may involve OCR for scanned documents

**Gotchas**:
- Must call initialize() or use static create() before getText()
- Unsupported types throw "not yet implemented" error
- Cache keys are based on localPath, so moving files breaks cache

### Utility Functions (`utils.ts`)
Content serialization utilities for markdown/YAML interoperability.

**`contentToString(content: Content): string`**
- Converts Content object to markdown with YAML frontmatter
- Format: `---\n{YAML}\n---\n{body}`
- Separates body from other properties
- Uses yaml package for frontmatter serialization

**`stringToContent(data: string): object`**
- Parses markdown string with YAML frontmatter
- Extracts frontmatter between `---` separators
- Returns plain object with merged frontmatter and body
- Handles missing frontmatter gracefully
- Returns: `{ ...frontmatter, body: string }`

**Important Notes**:
- These are pure functions, not methods
- Compatible with standard markdown + frontmatter format
- Used internally by writeContentFile for exports
- Can be used for custom import/export workflows

## Dependencies

### Internal HAVE SDK Dependencies
- **@have/smrt**: Core framework (SmrtObject, SmrtCollection, decorators)
- **@have/pdf**: PDF text extraction capabilities
- **@have/spider**: Web content scraping (via Document class)
- **@have/files**: File system operations, caching, download management
- **@have/utils**: Utility functions (makeSlug, etc.)

### External Dependencies
- **yaml**: YAML parsing and stringification for frontmatter handling

### Development Dependencies
- **@faker-js/faker**: Test data generation
- **@types/node**: TypeScript Node.js definitions
- **typescript**: TypeScript compiler
- **vitest**: Testing framework
- **svelte**: Development UI framework

## Usage Examples

### Basic Content Management

```typescript
import { Content, Contents } from '@have/content';

// Initialize collection with database and AI config
const contents = await Contents.create({
  db: { url: 'sqlite:./content.db' },
  ai: { type: 'openai', apiKey: process.env.OPENAI_API_KEY }
});

// Create content with comprehensive metadata
const article = new Content({
  title: 'AI in Content Processing',
  body: 'Large language models have revolutionized how we process and analyze content...',
  type: 'article',
  author: 'Research Team',
  source: 'research_paper',
  status: 'published',
  state: 'active',
  tags: ['ai', 'nlp', 'content-processing'],
  metadata: {
    category: 'technology',
    difficulty: 'intermediate',
    readingTime: 15
  }
});

// Initialize and save (sets up database record)
await article.initialize();
await article.save();

// Use inherited AI capabilities for analysis
const summary = await article.do('Create a 2-sentence summary');
const isAcademic = await article.is('written in academic style');
const topics = await article.do('Extract key topics as JSON array');

// Add to collection
await contents.add(article);
```

### Document Processing Workflow

```typescript
import { Document, Content, Contents } from '@have/content';

// Process PDF document
const doc = await Document.create({
  url: 'https://example.com/research.pdf',
  cacheDir: './cache'
});

// Extract text content
const extractedText = await doc.getText();

// Create content from document
const content = new Content({
  title: 'Extracted Research Paper',
  body: extractedText,
  type: 'document',
  fileKey: doc.localPath,
  source: 'pdf_extraction',
  original_url: 'https://example.com/research.pdf'
});

await content.initialize();
await content.save();
```

### Web Content Mirroring

```typescript
import { Contents } from '@have/content';

const contents = await Contents.create({
  db: { url: 'sqlite:./mirrors.db' }
});

// Mirror content from URL
const mirrored = await contents.mirror({
  url: 'https://example.com/article',
  context: 'research_sources',
  mirrorDir: './mirrors'
});

// Content is automatically extracted, processed, and saved
console.log(mirrored.title); // Auto-generated from URL
console.log(mirrored.body);  // Extracted text content
```

### Content Export and Synchronization

```typescript
import { Contents } from '@have/content';

const contents = await Contents.create({
  db: { url: 'sqlite:./content.db' },
  contentDir: './content-export'
});

// Export article-type content to filesystem as markdown
await contents.syncContentDir({
  contentDir: './exported-content'
});

// Individual file writing with YAML frontmatter
await contents.writeContentFile({
  content: article,
  contentDir: './markdown-files'
});
```

### Content Utilities

```typescript
import { contentToString, stringToContent } from '@have/content';

// Serialize content to markdown with YAML frontmatter
const markdownString = contentToString(article);
console.log(markdownString);
/*
---
title: AI in Content Processing
author: Research Team
type: article
status: published
---
Large language models have revolutionized how we process...
*/

// Parse markdown string back to content data
const contentData = stringToContent(markdownString);
const restoredContent = new Content(contentData);
```

## Advanced Integration Patterns

### Reference Management

```typescript
// Add references between content pieces
const sourceArticle = new Content({ title: 'Source Material' });
const derivedArticle = new Content({ title: 'Analysis Based on Source' });

await derivedArticle.addReference(sourceArticle);
await derivedArticle.addReference('https://external-source.com');

// Load reference network
const references = await derivedArticle.getReferences();
```

### Collection Querying

```typescript
// Advanced querying with SMRT collection methods
const recentArticles = await contents.list({
  where: {
    type: 'article',
    status: 'published',
    state: 'active'
  },
  limit: 10,
  offset: 0
});

// Get or create pattern
const content = await contents.getOrUpsert({
  title: 'Unique Title',
  body: 'Content body'
});
```

## Integration with SMRT Framework

The @have/content package is a full SMRT module with:

### SMRT Decorators
```typescript
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true
})
export class Content extends SmrtObject {
  // Automatic REST API generation
  // MCP tool integration for AI access
  // CLI command support
}
```

### Inherited SMRT Capabilities
- **Database Operations**: Automatic schema management and CRUD operations
- **AI Integration**: Built-in `do()` and `is()` methods for content analysis
- **API Generation**: Automatic REST API endpoints
- **MCP Tools**: AI-accessible tools for content management
- **CLI Support**: Command-line interface for content operations

## Development Patterns and Best Practices

### Initialization Pattern
Always use static factory methods for proper async initialization:

```typescript
// ✅ Correct - use static create()
const contents = await Contents.create({ db: { url: 'sqlite:./content.db' } });
const doc = await Document.create({ url: 'https://example.com/file.pdf' });

// ❌ Incorrect - missing initialization
const contents = new Contents({ db: { url: 'sqlite:./content.db' } });
await contents.initialize(); // Easy to forget!
```

### Content Uniqueness
Content uniqueness is based on `slug` + `context` combination:

```typescript
// These create two different content objects
await contents.getOrUpsert({ title: 'Test', slug: 'test', context: 'blog' });
await contents.getOrUpsert({ title: 'Test', slug: 'test', context: 'docs' });

// This updates existing content (same slug + context)
await contents.getOrUpsert({
  title: 'Updated Test',
  slug: 'test',
  context: 'blog'
});
```

### Context Organization
Use context to organize content into logical namespaces:

```typescript
// Organize by source
await contents.mirror({ url: 'https://blog.com/post', context: 'blog-posts' });
await contents.mirror({ url: 'https://docs.com/api', context: 'documentation' });

// Organize by project
await contents.getOrUpsert({
  title: 'Project A Notes',
  context: 'project-a',
  body: '...'
});
```

### Error Handling Patterns

```typescript
// Mirror with error handling
try {
  const content = await contents.mirror({
    url: userProvidedUrl,
    mirrorDir: './cache'
  });
} catch (error) {
  if (error.message.includes('Invalid URL')) {
    // Handle invalid URL
  }
  // Handle other errors
}

// Document getText with type checking
const doc = await Document.create({ url });
if (doc.isTextFile() || doc.type === 'application/pdf') {
  const text = await doc.getText();
} else {
  console.log('Unsupported file type:', doc.type);
}
```

### Caching Strategy
Leverage built-in caching to avoid reprocessing:

```typescript
// Document getText caches extracted text automatically
const doc = await Document.create({ url: 'large-file.pdf' });
const text1 = await doc.getText(); // Extracts and caches
const text2 = await doc.getText(); // Returns cached result instantly

// Cache location: {localPath}.extracted_text
```

### AI Integration Patterns

```typescript
// Use inherited SMRT AI methods
const content = await contents.get({ slug: 'article-slug' });

// Generate summaries
const summary = await content.do('Create a 2-sentence summary');

// Classification
const isAcademic = await content.is('written in academic style');

// Extraction
const topics = await content.do('Extract key topics as JSON array');

// Content transformation
const simplified = await content.do('Rewrite at 5th grade reading level');
```

### Export and Sync Patterns

```typescript
// Single content export
await contents.writeContentFile({
  content: myContent,
  contentDir: './exported'
});
// Creates: ./exported/{context}/{slug}/index.md

// Batch sync all articles
await contents.syncContentDir({ contentDir: './blog-posts' });
// Filters type='article' automatically

// Custom sync with filtering
const articles = await contents.list({ where: { type: 'article', status: 'published' } });
for (const article of articles) {
  await contents.writeContentFile({ content: article, contentDir: './site/content' });
}
```

## Testing

### Test Configuration

**Test Database Setup**: Each test should use a unique database to avoid conflicts:

```typescript
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = path.resolve(`${os.tmpdir()}/.have-sdk-tests/contents`);

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

**Environment Variables**: AI integration tests require `OPENAI_API_KEY`:

```bash
# Run all tests (skips AI tests without key)
bun test

# Run with AI tests
OPENAI_API_KEY=sk-... bun test

# Watch mode
bun run test:watch
```

**Test Data Generation**: Uses @faker-js/faker for realistic test data:

```typescript
import { faker } from '@faker-js/faker';

const fakeContent = {
  title: faker.lorem.sentence(),
  body: faker.lorem.paragraph(),
  author: faker.person.fullName(),
  publish_date: faker.date.recent()
};
```

### Common Test Patterns

```typescript
// Test content CRUD
it('should create and retrieve content', async () => {
  const contents = await Contents.create({ db: { url: getTestDbUrl('crud') } });
  const content = await contents.getOrUpsert({ title: 'Test', body: 'Test body' });

  expect(content.id).toBeDefined();

  const retrieved = await contents.get({ id: content.id });
  expect(retrieved?.title).toBe('Test');
});

// Test context isolation
it('should respect context boundaries', async () => {
  const contents = await Contents.create({ db: { url: getTestDbUrl('context') } });
  const slug = 'test-slug';

  const contentA = await contents.getOrUpsert({ slug, context: 'contextA' });
  const contentB = await contents.getOrUpsert({ slug, context: 'contextB' });

  expect(contentA.id).not.toBe(contentB.id);
});

// Test mirroring (typically skipped in CI due to time)
it.skip('should mirror remote content', async () => {
  const contents = await Contents.create({ db: { url: getTestDbUrl('mirror') } });

  const mirrored = await contents.mirror({
    url: 'https://example.com/document.pdf',
    mirrorDir: './test-cache'
  });

  expect(mirrored.id).toBeDefined();
  expect(mirrored.type).toBe('mirror');
}, 60000); // Extended timeout for network operations
```

### Development Commands

```bash
# Install dependencies
bun install

# Run tests (skips AI tests without OPENAI_API_KEY)
bun test

# Run tests in watch mode
bun run test:watch

# Run tests with AI integration
OPENAI_API_KEY=sk-... bun test

# Build package for distribution
bun run build

# Build in watch mode for development
bun run build:watch

# Run development server with Svelte UI
bun run dev
# Access at: http://localhost:3003

# Start REST API server
bun src/server.ts
# Access at: http://localhost:3100/api/v1
```

## REST API Server

The package includes a pre-built REST API server (`server.ts`) demonstrating auto-generated endpoints.

### Starting the Server

```bash
# Start server directly
bun src/server.ts

# Or using tsx/ts-node
tsx packages/content/src/server.ts
```

### Server Configuration

```typescript
import { startRestServer } from '@have/smrt';
import { Content } from './content';

const shutdown = await startRestServer(
  [Content],  // SMRT objects to expose
  {},         // context
  {
    port: 3100,
    hostname: 'localhost',
    basePath: '/api/v1',
    enableCors: true
  }
);
```

### Auto-Generated Endpoints

All endpoints automatically generated from `@smrt()` decorator:

```bash
# List contents (with filtering, pagination)
GET /api/v1/contents?type=article&status=published&limit=10&offset=0

# Get specific content
GET /api/v1/contents/:id

# Create content
POST /api/v1/contents
Content-Type: application/json
{
  "title": "New Content",
  "body": "Content body text",
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
  -d '{"title":"Test","body":"Test content"}'

# List all contents
curl http://localhost:3100/api/v1/contents

# Filter by type
curl http://localhost:3100/api/v1/contents?type=article

# Get specific content
curl http://localhost:3100/api/v1/contents/abc123
```

## Common Gotchas and Troubleshooting

### 1. Forgetting to Initialize
**Problem**: Using `new` constructor without calling `initialize()` or using static `create()`

```typescript
// ❌ Will fail - not initialized
const contents = new Contents({ db: { url: 'sqlite:./db' } });
await contents.getOrUpsert({ title: 'Test' }); // Error!

// ✅ Correct approaches
const contents = await Contents.create({ db: { url: 'sqlite:./db' } });
// OR
const contents = new Contents({ db: { url: 'sqlite:./db' } });
await contents.initialize();
```

### 2. Context and Slug Confusion
**Problem**: Not understanding that uniqueness is based on `slug` + `context` together

```typescript
// These are THREE different content objects
await contents.getOrUpsert({ title: 'Test', slug: 'test' });           // context: ''
await contents.getOrUpsert({ title: 'Test', slug: 'test', context: 'blog' });
await contents.getOrUpsert({ title: 'Test', slug: 'test', context: 'docs' });
```

**Solution**: Always be explicit about context when uniqueness matters:

```typescript
// Explicit context ensures correct behavior
const content = await contents.getOrUpsert({
  title: 'Test',
  slug: 'test',
  context: 'my-context'
});
```

### 3. Mirror URL Validation
**Problem**: Mirror throws error with invalid URLs

```typescript
// ❌ Will throw "Invalid URL provided"
await contents.mirror({ url: 'not-a-valid-url' });

// ✅ Always validate or catch errors
try {
  const content = await contents.mirror({ url: userInput });
} catch (error) {
  if (error.message.includes('Invalid URL')) {
    console.error('Please provide a valid URL');
  }
}
```

### 4. Document Type Support
**Problem**: Calling `getText()` on unsupported file types

```typescript
// ❌ Will throw "not yet implemented"
const doc = await Document.create({ url: 'file:///path/to/video.mp4' });
await doc.getText(); // Error!

// ✅ Check type first
if (doc.isTextFile() || doc.type === 'application/pdf') {
  const text = await doc.getText();
} else {
  console.log('Unsupported type:', doc.type);
}
```

### 5. Cache Invalidation
**Problem**: Cached extraction results persist even when source changes

```typescript
// Document extraction is cached by localPath
const doc = await Document.create({ url: 'file:///path/to/file.pdf' });
const text1 = await doc.getText(); // Extracts and caches

// If file changes on disk, cache is stale
// Manual cache clearing needed
```

**Solution**: Be aware of cache locations and clear when needed:
- Document text cache: `{localPath}.extracted_text`
- Uses @have/files `getCached/setCached` functions

### 6. Title vs Name Field
**Problem**: Confusion between `title` and `name` properties

```typescript
const content = new Content({ title: 'My Title' });
await content.initialize();
// After initialization, content.name === 'My Title'
```

**Explanation**: Content syncs `title` to `name` during initialization for SmrtObject compatibility. Use `title` for content-specific operations, `name` is for SMRT framework integration.

### 7. Reference Persistence
**Problem**: Expecting references to be automatically saved to database

```typescript
const content = new Content({ title: 'Main' });
await content.initialize();
await content.addReference('https://source.com');
await content.save();

// References are NOT persisted to database currently
// They're stored in-memory in the references array
```

**Explanation**: Reference system is extensible but not yet persisted. Store reference URLs in `metadata` if persistence is needed:

```typescript
content.metadata.references = ['https://source1.com', 'https://source2.com'];
await content.save();
```

### 8. SyncContentDir Only Syncs Articles
**Problem**: Expecting `syncContentDir()` to sync all content types

```typescript
await contents.getOrUpsert({ type: 'document', title: 'Doc' });
await contents.getOrUpsert({ type: 'mirror', title: 'Mirror' });
await contents.syncContentDir({ contentDir: './output' });
// Only exports content with type='article'
```

**Solution**: Use custom filtering for other types:

```typescript
const allContent = await contents.list({ where: { status: 'published' } });
for (const content of allContent) {
  await contents.writeContentFile({ content, contentDir: './output' });
}
```

### 9. YAML Frontmatter Parsing
**Problem**: Frontmatter parsing fails with invalid YAML

```typescript
const badYaml = `---
title: Test
invalid yaml: [unclosed
---
Body content`;

const parsed = stringToContent(badYaml); // Returns { body: entire string }
// Parsing errors are silently handled, returns empty frontmatter
```

**Solution**: Validate YAML or handle empty frontmatter:

```typescript
const parsed = stringToContent(data);
if (!parsed.title) {
  console.warn('Frontmatter parsing may have failed');
}
```

### 10. Test Database Collisions
**Problem**: Tests interfere with each other due to shared database

```typescript
// ❌ Multiple tests using same database
const contents = await Contents.create({ db: { url: 'sqlite:./test.db' } });

// ✅ Use unique database per test
function getTestDbUrl(testName: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  return `file:/tmp/.have-tests/${testName}-${timestamp}-${random}.db`;
}
```

## Key Features Summary

✅ **SMRT Integration**: Full SMRT module with automatic API generation
✅ **AI-Powered Analysis**: Built-in content analysis and transformation via `do()` and `is()` methods
✅ **Document Processing**: PDF (with OCR), text files, and web content extraction
✅ **Web Content**: URL mirroring with automatic text extraction and caching
✅ **Filesystem Export**: Markdown generation with YAML frontmatter in organized directory structure
✅ **Reference System**: In-memory content linking and relationship management
✅ **Caching**: Automatic extraction result caching with @have/files integration
✅ **Collection Operations**: Batch processing, advanced querying, and getOrUpsert patterns
✅ **Context Organization**: Namespace isolation for multi-project/multi-source content
✅ **TypeScript**: Full type safety and IntelliSense support with comprehensive interfaces
✅ **REST API**: Auto-generated endpoints for all CRUD operations
✅ **MCP Tools**: AI-accessible tools for content management
✅ **Development UI**: Svelte-based development interface on port 3003

## Package Exports

```typescript
import {
  // Classes
  Content,           // Main content data model
  Contents,          // Collection manager
  Document,          // Document processor

  // Types
  ContentOptions,    // Content constructor options
  ContentsOptions,   // Contents constructor options
  DocumentOptions,   // Document constructor options

  // Utils
  contentToString,   // Serialize to markdown + frontmatter
  stringToContent    // Parse markdown + frontmatter
} from '@have/content';
```

## Quick Reference

### Content Properties (Most Common)
- `title` (string): Content title
- `body` (string): Main text content
- `type` (string|null): Classification ('article', 'document', 'mirror')
- `context` (string): Namespace for organization
- `slug` (string): URL-friendly identifier
- `status` ('published'|'draft'|'archived'|'deleted'): Publication status
- `state` ('active'|'deprecated'|'highlighted'): Content state
- `tags` (string[]): Content tags
- `metadata` (object): Flexible JSON metadata

### Contents Methods (Most Common)
- `Contents.create(options)`: Factory method (use instead of constructor)
- `getOrUpsert(data)`: Get or create content (checks slug + context)
- `get(where)`: Find single content by criteria
- `list(options)`: Query multiple contents with filtering
- `mirror(options)`: Download and extract content from URL
- `writeContentFile(options)`: Export content to markdown file
- `syncContentDir(options)`: Export all articles to directory

### Document Methods
- `Document.create(options)`: Factory method with auto-initialization
- `getText()`: Extract text content (with caching)
- `isTextFile()`: Check if file is text-based

This package enables sophisticated content processing workflows while maintaining the modular architecture and AI-first design principles of the HAVE SDK.