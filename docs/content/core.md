# @happyvertical/smrt-core

<p align="center">
  <img src="./smrt-homer.png" alt="SMRT Logo" width="400"/>
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Core AI agent framework with standardized collections, object-relational mapping, and code generators in the HAVE SDK.

## Overview

The `@happyvertical/smrt-core` package provides the foundation for building vertical AI agents. It offers a comprehensive framework with object-relational mapping, AI-powered operations, code generation capabilities, and seamless integration with other HAVE SDK packages.

## Key Features

- **AI-First Object Framework**: Objects with built-in AI operations (`is()`, `do()`, `describe()` methods)
- **Object-Relational Mapping**: Automatic database schema generation from TypeScript classes
- **Standardized Collections**: Advanced CRUD, batch operations, semantic search, and interceptors
- **Code Generation**: CLI tools, REST APIs, and MCP servers generated from objects
- **Field System**: Type-safe field definitions with validation and constraints
- **Vite Plugin Integration**: Virtual modules for automatic service generation
- **AST Scanning**: Automatic discovery of SMRT objects in codebases
- **Cross-Package Integration**: Unified access to AI, files, database, and web capabilities
- **Vector Embeddings**: Generate and manage semantic embeddings for search and similarity

## Installation

```bash
# Install with npm
npm install @happyvertical/smrt-core

# Or with yarn
yarn add @happyvertical/smrt-core

# Or with bun
bun add @happyvertical/smrt-core
```

## Usage

### Define SMRT Objects with TypeScript Types

```typescript
import { SmrtObject, field, foreignKey, smrt } from '@happyvertical/smrt-core';

// Define objects using TypeScript types (primary pattern)
@smrt({
  api: true,  // Auto-generate REST API
  mcp: true,  // Auto-generate MCP tools
  cli: true   // Auto-generate CLI commands
})
class Document extends SmrtObject {
  // TypeScript types → Automatic schema generation
  title: string = '';           // → TEXT column
  content: string = '';         // → TEXT column
  wordCount: number = 0;        // → INTEGER (no decimal)
  rating: number = 4.5;         // → DECIMAL (has decimal)
  isPublished: boolean = false; // → BOOLEAN column
  tags: string[] = [];          // → JSON column
  publishedAt: Date = new Date(); // → DATETIME column

  // Use field decorators only when needed for:
  // 1. Relationships
  @foreignKey(Category)
  categoryId: string = '';

  // 2. Constraints
  @field({ required: true, unique: true })
  slug: string = '';

  constructor(options: any = {}) {
    super(options);
    Object.assign(this, options);
  }

  // AI-powered content validation
  async isHighQuality() {
    return await this.is(`
      - Contains more than 500 words
      - Has clear structure and headings
      - Uses professional language
    `);
  }

  // AI-powered content transformation
  async generateSummary() {
    return await this.do(`
      Create a 2-sentence summary of this document.
      Focus on the key points and main conclusions.
    `);
  }
}
```

#### When to Use Field Helpers

**Use TypeScript types** for most properties (preferred):
```typescript
name: string = '';           // → TEXT
count: number = 0;           // → INTEGER (no decimal point)
price: number = 0.0;         // → DECIMAL (has decimal point)
active: boolean = true;      // → BOOLEAN
created: Date = new Date();  // → DATETIME
tags: string[] = [];         // → JSON
```

**Use field helpers** only when you need:
1. **Relationships**: `categoryId = foreignKey(Category)`
2. **Constraints**: `email = text({ required: true, pattern: /^.+@.+$/ })`
3. **Nullable decimals**: `latitude = decimal({ nullable: true })`

**The 0 vs 0.0 Heuristic**:
- `quantity: number = 0` → INTEGER column (no decimal point)
- `price: number = 0.0` → DECIMAL column (has decimal point)
- `rating: number = 4.5` → DECIMAL column (has decimal point)

### Create and Manage Collections

```typescript
import { SmrtCollection } from '@happyvertical/smrt-core';

class DocumentCollection extends SmrtCollection<Document> {
  static readonly _itemClass = Document;

  constructor(options: any = {}) {
    super({
      db: { url: 'documents.sqlite', type: 'sqlite' },
      ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY },
      ...options
    });
  }

  // Custom query methods
  async findPublished() {
    return this.list({
      where: { isPublished: true },
      orderBy: 'publishedAt DESC'
    });
  }

  // Advanced filtering with AI
  async findByQuality(qualityCriteria: string) {
    const docs = await this.list({});
    const qualityDocs = [];

    for (const doc of docs) {
      if (await doc.is(qualityCriteria)) {
        qualityDocs.push(doc);
      }
    }

    return qualityDocs;
  }
}
```

### Initialize and Use the System

```typescript
// Create collection instance
const documents = new DocumentCollection();
await documents.initialize();

// Create and save a document
const doc = documents.create({
  title: 'AI Agent Development Guide',
  content: 'This guide covers the fundamentals of building AI agents...',
  wordCount: 1250
});
await doc.save();

// Advanced querying with operators
const recentDocs = await documents.list({
  where: {
    'wordCount >': 1000,
    'publishedAt >': '2024-01-01',
    'title like': '%AI%'
  },
  limit: 10,
  orderBy: ['wordCount DESC', 'publishedAt DESC']
});

// Use AI-powered operations
const isQuality = await doc.isHighQuality();
const summary = await doc.generateSummary();
```

## AI-Powered Methods

SMRT objects include built-in AI operations that enable intelligent content analysis and transformation. These methods leverage the configured AI provider to perform natural language tasks.

### `is(criteria)` - Evaluate Criteria

Evaluates whether the object meets specified criteria using AI analysis. Returns a boolean.

```typescript
// Check if content meets quality standards
const isHighQuality = await document.is(`
  - Contains more than 500 words
  - Has clear structure and headings
  - Uses professional language
`);

// Validate data conditions
const isValid = await order.is("Has all required fields populated and total > 0");

// Check content characteristics
const isTechnical = await article.is("Contains technical programming content");
```

### `do(instructions)` - Execute Instructions

Executes AI-powered instructions on the object and returns the result. Use this for content transformation, analysis, and generation tasks.

```typescript
// Generate a summary
const summary = await document.do(`
  Create a 2-sentence summary of this document.
  Focus on the key points and main conclusions.
`);

// Transform content
const bullets = await article.do("Convert the main points into a bulleted list");

// Extract information
const entities = await content.do("Extract all mentioned company names as a JSON array");

// Analyze sentiment
const analysis = await review.do("Analyze the sentiment and provide a score from 1-10");
```

### `describe()` - Generate Description

Generates a natural language description of the object based on its content. Returns a string description.

```typescript
// Generate a product description
const description = await product.describe();
// Returns: "A high-performance wireless mouse with ergonomic design..."

// Use in content pipelines
const items = await collection.list({ where: { description: '' } });
for (const item of items) {
  item.description = await item.describe();
  await item.save();
}
```

### AI Method Best Practices

1. **Be specific with criteria**: Provide clear, measurable conditions for `is()` calls
2. **Use structured prompts**: Break complex instructions into bullet points for `do()` calls
3. **Cache expensive results**: Store AI-generated content in object properties to avoid repeated calls
4. **Handle errors gracefully**: AI methods may throw errors if the provider is unavailable

```typescript
class Article extends SmrtObject {
  summary: string = '';

  // Cache AI-generated summary
  async getSummary() {
    if (!this.summary) {
      this.summary = await this.do('Summarize in 2-3 sentences');
      await this.save();
    }
    return this.summary;
  }

  // Combine AI methods for complex workflows
  async processForPublication() {
    const isReady = await this.is('Has title, content > 300 words, and proper formatting');
    if (!isReady) {
      throw new Error('Article not ready for publication');
    }

    this.description = await this.describe();
    this.summary = await this.do('Create an engaging meta description under 160 characters');
    await this.save();
  }
}
```

## Single Table Inheritance (STI)

SMRT supports Single Table Inheritance where multiple classes share one database table:

### Basic STI Configuration

```typescript
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

// Base class with STI strategy
@smrt({ tableStrategy: 'sti' })
class Event extends SmrtObject {
  title: string = '';
  date: Date = new Date();
  location: string = '';
}

// Child classes automatically inherit STI
@smrt()
class Meeting extends Event {
  roomNumber: string = '';
  attendees: string[] = [];
}

@smrt()
class Conference extends Event {
  sponsorName: string = '';
  ticketPrice: number = 0.0;
  sessions: number = 0;
}
```

### How STI Works

- **Single Table**: All classes in the hierarchy share the `events` table
- **Discriminator Column**: `_meta_type` identifies the actual class type
- **Field Storage**:
  - Base class fields → Regular columns
  - Child-specific fields → JSONB `_meta_data` column

### Polymorphic Queries

```typescript
const eventCollection = await EventCollection.create(options);

// Create different event types
const meeting = await eventCollection.create({
  _meta_type: 'Meeting',
  title: 'Daily Standup',
  roomNumber: '101',
  attendees: ['Alice', 'Bob']
});

const conference = await eventCollection.create({
  _meta_type: 'Conference',
  title: 'Tech Summit',
  sponsorName: 'TechCorp',
  ticketPrice: 299.00
});

// Query returns mixed types!
const allEvents = await eventCollection.list();

for (const event of allEvents) {
  console.log(event.constructor.name); // 'Meeting' or 'Conference'

  if (event instanceof Meeting) {
    console.log(`Room: ${event.roomNumber}`);
  } else if (event instanceof Conference) {
    console.log(`Price: ${event.ticketPrice}`);
  }
}

// Filter by type
const meetings = await eventCollection.list({
  where: { _meta_type: 'Meeting' }
});
```

### Multi-Level Inheritance

```typescript
// Level 1: Base class
@smrt({ tableStrategy: 'sti' })
class Content extends SmrtObject {
  title: string = '';
  body: string = '';
}

// Level 2: Extends Content
@smrt()
class Article extends Content {
  author: string = '';
  publishedDate: Date = new Date();
}

// Level 3: Extends Article
@smrt()
class NewsArticle extends Article {
  newsCategory: string = '';
  breakingNews: boolean = false;
}

// All three classes share the 'contents' table
const article = new NewsArticle({
  title: 'Breaking News',        // From Content
  body: 'Story details...',       // From Content
  author: 'Jane Smith',           // From Article
  publishedDate: new Date(),      // From Article
  newsCategory: 'Technology',     // From NewsArticle
  breakingNews: true              // From NewsArticle
});
```

### When to Use STI

✅ **Use STI when:**
- Classes share most fields (80%+ overlap)
- Need polymorphic queries (mixed types in one query)
- Frequent queries across the hierarchy
- Small number of subclass-specific fields

❌ **Avoid STI when:**
- Many unique fields per subclass (sparse columns)
- Deep hierarchies (3+ levels)
- Subclasses need different indexing strategies

## Code Generation

Generate CLI tools, REST APIs, and MCP servers automatically from your SMRT objects:

### CLI Generation

```typescript
import { CLIGenerator } from '@happyvertical/smrt-core/generators';

const generator = new CLIGenerator({
  collections: [DocumentCollection],
  outputDir: './cli',
  includeAI: true
});

await generator.generate();
// Creates: ./cli/documents-cli.js with full CRUD operations
```

### REST API Generation

```typescript
import { APIGenerator } from '@happyvertical/smrt-core/generators';

const generator = new APIGenerator({
  collections: [DocumentCollection],
  outputDir: './api',
  includeSwagger: true,
  middleware: ['auth', 'validation']
});

await generator.generate();
// Creates: ./api/documents-routes.js with OpenAPI documentation
```

### Caching Headers (Conditional GET)

Generated read routes (`list` and `get`) support conditional GET out of the box, on both the REST generator and the generated SvelteKit routes:

- Every 200 read response carries a **strong ETag** — a SHA-256 hash of the serialized JSON body — plus a `Cache-Control` header.
- A request whose `If-None-Match` matches the current ETag is answered `304 Not Modified` with an **empty body**, saving transfer, parse, and re-render. (v1 still runs the query; a later slice derives the ETag from the change feed for zero-query 304s.)
- Any mutation that changes the serialized data changes the ETag, so stale validators revalidate to a fresh 200.

The `Cache-Control` policy is resolved from the object's `@smrt({ api })` config:

| Model config | Read `Cache-Control` |
|--------------|----------------------|
| Default (any non-public model) | `private, no-cache` — browsers may store but must revalidate; shared caches never store |
| `api: { public: true }` (no cache opt-in) | `private, no-cache` |
| `api: { public: true \| 'read', cache: { sMaxage: n } }` | `public, max-age=0, s-maxage=n` — CDNs serve for `n` seconds; browsers still revalidate |

```typescript
// Opt a genuinely public model into CDN caching for 5 minutes:
@smrt({ api: { public: 'read', cache: { sMaxage: 300 } } })
export class Article extends SmrtObject { /* ... */ }
```

Notes:

- `api.cache.sMaxage` is only honored when reads are public (`public: true` or `public: 'read'`). **Non-public models never emit shared-cache headers**, even if `sMaxage` is configured.
- `max-age=0` keeps browsers revalidating (cheap 304s), so end users see edits immediately while shared caches absorb anonymous traffic.
- Reserve the opt-in for responses that are identical for every requester; it is distinct from the top-level `@smrt({ cache })` knob, which configures the server-side collection read-through cache.
- Mutations (`create`/`update`/`delete`) and custom action routes are unaffected.

### MCP Server Generation

```typescript
import { MCPGenerator } from '@happyvertical/smrt-core/generators';

const generator = new MCPGenerator({
  collections: [DocumentCollection],
  outputDir: './mcp',
  tools: ['list', 'get', 'create', 'update', 'delete', 'search']
});

await generator.generate();
// Creates: ./mcp/documents-mcp-server.js for AI model integration
```

## SMRT Advisor for Claude Code

The SMRT Advisor is a development-time MCP server that integrates with Claude Code to help you write correct SMRT framework code. It provides 11 AI-callable tools for code generation, validation, preview, and discovery.

### Features

**Code Generation Tools (5)**:
- `generate-smrt-class` - Generate complete SMRT classes with decorators and properties
- `add-ai-methods` - Add AI-powered `is()`, `do()`, and `tool()` methods
- `generate-field-definitions` - Generate field definitions with proper imports
- `generate-collection` - Generate SmrtCollection subclasses
- `configure-decorators` - Configure `@smrt()` decorator options

**Validation Tool (1)**:
- `validate-smrt-object` - Validate SMRT object structure and configuration

**Preview Tools (2)**:
- `preview-api-endpoints` - Preview auto-generated REST API endpoints
- `preview-mcp-tools` - Preview auto-generated MCP tools

**Discovery Tools (3)**:
- `list-registered-objects` - List all registered SMRT objects
- `get-object-schema` - Get field schemas (JSON/TypeScript/table formats)
- `get-object-config` - Get decorator configuration (JSON/YAML)

### Setup

The advisor server is configured in your `.mcp.json` file:

```json
{
  "mcpServers": {
    "smrt-advisor": {
      "type": "stdio",
      "command": "pnpm",
      "args": [
        "exec",
        "tsx",
        "/path/to/sdk/packages/core/smrt/src/mcp-advisor/index.ts"
      ],
      "env": {
        "DEBUG": "false"
      },
      "cwd": "/path/to/sdk"
    }
  }
}
```

After restarting Claude Code, you can use the advisor tools directly in your development workflow.

### Example Usage

```typescript
// Ask Claude Code to generate a SMRT class
"Generate a Book class with title, author, isbn, and price fields"

// Claude Code uses generate-smrt-class tool to create:
import { SmrtObject, type SmrtObjectOptions, field, smrt } from '@happyvertical/smrt-core';

export interface BookOptions extends SmrtObjectOptions {
  title?: string;
  author?: string;
  isbn?: string;
  price?: number;
}

@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true
})
export class Book extends SmrtObject {
  @field({ required: true, description: "The title of the book" })
  title: string = '';

  @field({ required: true, description: "The author's name" })
  author: string = '';

  @field({ description: "International Standard Book Number" })
  isbn: string = '';

  @field({ description: "Price of the book" })
  price: number = 0.0;

  constructor(options: BookOptions = {}) {
    super(options);
    this.title = options.title || '';
    this.author = options.author || '';
    this.isbn = options.isbn || '';
    this.price = options.price || 0;
  }
}
```

The advisor helps ensure your SMRT code follows best practices and generates correct configurations.

## Vite Plugin Integration

Use the Vite plugin for automatic service generation during development:

```typescript
// vite.config.js
import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';

export default {
  plugins: [
    smrtPlugin({
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      generateTypes: true,
      hmr: true
    })
  ]
};

// Access virtual modules in your code:
import { setupRoutes } from '@smrt/routes';        // REST routes
import { createClient } from '@smrt/client';       // API client
import { tools } from '@smrt/mcp';                 // MCP tools
import { manifest } from '@smrt/manifest';         // Object manifest
```

## Field Types

The field system provides type-safe database schema generation:

```typescript
import {
  SmrtObject,
  field,
  foreignKey,
  oneToMany,
  manyToMany,
} from '@happyvertical/smrt-core';

class Product extends SmrtObject {
  @field({ required: true, maxLength: 100 })
  name: string = '';

  @field({ min: 0, required: true })
  price: number = 0.0;

  inStock: boolean = true;
  tags: string[] = [];

  @field({ required: true })
  createdAt: Date = new Date();

  // Relationships
  @foreignKey(Category)
  categoryId: string = '';
  reviews = oneToMany(Review);
  relatedProducts = manyToMany(Product);
}
```

## Advanced Querying

Collections support flexible querying with multiple operators:

```typescript
const results = await collection.list({
  where: {
    'price >': 10,              // Greater than
    'price <=': 100,            // Less than or equal
    'name like': '%widget%',    // Pattern matching
    'category in': ['A', 'B'],  // IN operator
    'active': true,             // Equals (default)
    'deleted_at !=': null       // Not equals
  },
  orderBy: ['price DESC', 'name ASC'],
  limit: 20,
  offset: 0
});

// Count records with same filtering
const total = await collection.count({
  where: { 'price >': 50 }
});
```

### Eager Loading (Preventing N+1 Queries)

SMRT supports eager loading to optimize queries that access related objects, solving the common "N+1 query problem":

```typescript
// Define relationships
class Order extends SmrtObject {
  customerId = foreignKey(Customer);
  productId = foreignKey(Product);
  status: string = 'pending';
}

// ❌ Without eager loading: N+1 queries (slow)
const orders = await orderCollection.list({ limit: 100 });
for (const order of orders) {
  const customer = await order.loadRelated('customerId'); // 100 separate queries!
  console.log(customer.name);
}

// ✅ With eager loading: Single query (fast)
const orders = await orderCollection.list({
  limit: 100,
  include: ['customerId', 'productId'] // Pre-load relationships
});

for (const order of orders) {
  const customer = order.getRelated('customerId'); // Already loaded!
  console.log(customer.name);
}
```

**Performance Impact**: 40-70% faster for relationship-heavy queries

**How it works**:
- **SQL adapters**: Generates efficient `LEFT JOIN` queries
- **REST adapters**: Uses batch loading for related objects
- Only works with `foreignKey` relationships
- Access pre-loaded data with `object.getRelated(fieldName)`

For more details, see the package `AGENTS.md` documentation.

### Direct SQL Access

All SMRT objects have public `db` property for direct database access via @happyvertical/sql. This enables custom queries, transactions, and advanced database operations:

```typescript
import { SmrtObject, SmrtCollection } from '@happyvertical/smrt-core';

class Product extends SmrtObject {
  name = text({ required: true });
  price = decimal({ required: true });
  category = text({ required: true });
}

const products = await ProductCollection.create({ db: 'products.db' });

// Direct SQL queries
const expensive = await products.db.many`
  SELECT * FROM products
  WHERE price > ${100}
  ORDER BY price DESC
  LIMIT 10
`;

// Execute custom updates
await products.db.execute`
  UPDATE products
  SET price = price * 0.9
  WHERE category = ${'electronics'}
`;

// Check query results
const count = await products.db.pluck`
  SELECT COUNT(*) FROM products WHERE price > ${50}
`;

// Use template literals for safe parameterization
const category = 'books';
const results = await products.db.query`
  SELECT * FROM products WHERE category = ${category}
`;
```

**Key Benefits**:
- **Direct database access**: Use any SQL query, not limited to ORM methods
- **Template literal safety**: Automatic SQL injection protection via tagged templates
- **Full @happyvertical/sql power**: Access all DatabaseInterface methods (many, single, pluck, execute)
- **Transaction support**: Use `db.transaction()` for atomic operations
- **Performance**: Direct queries can be more efficient for complex operations

**Configuration Options**:
```typescript
// String shortcut (auto-detects database type)
const collection = await ProductCollection.create({
  db: 'products.db'
});

// Config object (explicit type)
const collection = await ProductCollection.create({
  db: {
    type: 'sqlite',
    url: 'products.db'
  }
});

// DatabaseInterface instance (pre-configured)
import { getDatabase } from '@happyvertical/sql';
const db = await getDatabase({ type: 'postgres', url: 'postgres://...' });
const collection = await ProductCollection.create({ db });
```

## Vector Embeddings

SMRT objects support vector embeddings for semantic search and similarity comparisons. Embeddings convert object content into numerical vectors that capture semantic meaning.

### Configuration

Configure embeddings in the `@smrt()` decorator:

```typescript
@smrt({
  embeddings: {
    fields: ['title', 'content', 'summary'],  // Fields to embed
    model: 'text-embedding-3-small'            // Embedding model (optional)
  }
})
class Article extends SmrtObject {
  title: string = '';
  content: string = '';
  summary: string = '';
}
```

### `generateEmbeddings(options?)` - Generate Vectors

Generates vector embeddings for all configured fields. Call this after creating or updating content.

```typescript
const article = await collection.create({
  title: 'Introduction to Vector Search',
  content: 'Vector embeddings enable semantic search...'
});

// Generate embeddings for all configured fields
await article.generateEmbeddings();

// With options
await article.generateEmbeddings({
  force: true,        // Regenerate even if content unchanged
  fields: ['title']   // Only embed specific fields
});
```

### `getEmbedding(fieldName, model?)` - Retrieve Embedding

Retrieves the stored embedding vector for a specific field.

```typescript
// Get the embedding for a field
const titleVector = await article.getEmbedding('title');
// Returns: Float32Array with embedding values

// Get embedding for specific model (if multiple models used)
const vector = await article.getEmbedding('content', 'text-embedding-3-large');
```

### `hasStaleEmbeddings()` - Check for Updates

Checks if the object's content has changed since embeddings were last generated.

```typescript
// Check if embeddings need regeneration
if (await article.hasStaleEmbeddings()) {
  await article.generateEmbeddings();
}

// Use in batch processing
const articles = await collection.list({});
for (const article of articles) {
  if (await article.hasStaleEmbeddings()) {
    await article.generateEmbeddings();
  }
}
```

### `clearEmbeddings()` - Remove Embeddings

Removes all stored embeddings for the object.

```typescript
// Clear all embeddings
await article.clearEmbeddings();

// Useful when content is significantly changed
article.content = newContent;
await article.clearEmbeddings();
await article.generateEmbeddings();
```

### Embedding Best Practices

1. **Choose appropriate fields**: Embed fields with meaningful text content, not IDs or numeric values
2. **Regenerate on content changes**: Use `hasStaleEmbeddings()` to keep embeddings current
3. **Batch processing**: Generate embeddings in batches to manage API rate limits
4. **Select the right model**: Use smaller models for speed, larger models for accuracy

```typescript
// Batch embedding generation with rate limiting
async function embedAllArticles(collection: ArticleCollection) {
  const articles = await collection.list({});

  for (const article of articles) {
    if (await article.hasStaleEmbeddings()) {
      await article.generateEmbeddings();
      await new Promise(resolve => setTimeout(resolve, 100)); // Rate limit
    }
  }
}
```

### Raw Query with Hydration

Execute complex SQL queries while still getting back fully-hydrated SMRT objects:

```typescript
// Complex queries with JOINs, CTEs, subqueries - results are still SMRT objects
const featured = await products.query(`
  SELECT p.* FROM products p
  JOIN categories c ON p.category_id = c.id
  WHERE c.featured = true
  AND NOT EXISTS (
    SELECT 1 FROM inventory i
    WHERE i.product_id = p.id AND i.quantity = 0
  )
  ORDER BY p.created_at DESC
  LIMIT $1
`, [10]);

// Each result is a fully-functional Product instance
for (const product of featured) {
  console.log(product.name);      // Access properties
  await product.save();            // Use SMRT methods
  const valid = await product.is('Is this product well-described?'); // AI methods work
}
```

### Batch Operations

Efficiently work with multiple records:

```typescript
// Batch fetch by IDs (single query, avoids N+1)
const items = await collection.listByIds(['id1', 'id2', 'id3']);

// Find or create with defaults (upsert pattern)
const user = await users.getOrUpsert(
  { email: 'user@example.com' },     // Find by these fields
  { name: 'New User', role: 'member' } // Use these defaults if creating
);

// Get only changed fields between objects
const changes = collection.getDiff(existingUser, updatedData);
// Returns: { name: 'New Name' } if only name changed
```

## Semantic Search

Collections provide semantic search capabilities using vector embeddings. This enables finding similar content based on meaning rather than exact text matching.

### Search by Text Query

```typescript
// Search for articles similar to a text query
const results = await articles.semanticSearch('machine learning basics', {
  field: 'content',      // Which embedded field to search
  limit: 10,             // Max results
  minSimilarity: 0.7     // Minimum cosine similarity (0-1)
});

for (const article of results) {
  console.log(article.title, article._similarity); // _similarity score attached
}
```

### Find Similar Objects

```typescript
// Find articles similar to an existing article
const similar = await articles.findSimilar(article, {
  field: 'content',
  limit: 5,
  excludeSelf: true     // Don't include the source article
});
```

### Low-Level Similarity Search

```typescript
// Search with a pre-computed embedding vector
const queryEmbedding = await collection.ai.embed('search query');
const results = await articles.findSimilarToEmbedding(queryEmbedding, {
  field: 'content',
  limit: 10
});
```

### Batch Generate Embeddings

```typescript
// Generate embeddings for all objects missing them
const stats = await articles.generateMissingEmbeddings({
  batchSize: 50,         // Process in batches
  onProgress: (done, total) => {
    console.log(`Progress: ${done}/${total}`);
  }
});

console.log(`Generated: ${stats.generated}, Skipped: ${stats.skipped}`);
```

## Interceptors

Interceptors allow you to hook into collection operations for cross-cutting concerns like tenancy, auditing, caching, and access control.

### Registering Interceptors

```typescript
import { GlobalInterceptors } from '@happyvertical/smrt-core';

GlobalInterceptors.register({
  name: 'tenancy',
  priority: 100,  // Higher priority runs first

  // Intercept list operations
  beforeList(className, options, context) {
    // Add tenant filter to all queries
    return {
      ...options,
      where: { ...options.where, tenantId: getCurrentTenantId() }
    };
  },

  // Intercept after data is fetched
  afterList(className, results, context) {
    // Log or transform results
    logQuery(className, results.length);
    return results;
  }
});
```

### Available Hooks

| Hook | Description | Return Value |
|------|-------------|--------------|
| `beforeGet` | Before fetching single record | Modified options or void |
| `afterGet` | After fetching single record | Modified result or void |
| `beforeList` | Before listing records | Modified options or void |
| `afterList` | After listing records | Modified results or void |
| `beforeQuery` | Before raw SQL query | Modified query/params or void |
| `afterQuery` | After raw SQL query | Modified results or void |
| `beforeSave` | Before saving record | Modified instance or void |
| `afterSave` | After saving record | void |
| `beforeDelete` | Before deleting record | Boolean (false cancels) or void |
| `afterDelete` | After deleting record | void |

### Interceptor Context

All hooks receive a context object with metadata:

```typescript
interface InterceptorContext {
  className: string;       // SMRT class name (e.g., 'Product')
  collectionName: string;  // Collection class name
  timestamp: Date;         // When operation started
  operation: string;       // 'list' | 'get' | 'query' | 'save' | 'delete'
  metadata: Record<string, any>; // Custom data
}
```

### Example: Audit Logging

```typescript
GlobalInterceptors.register({
  name: 'audit',
  priority: 50,

  afterSave(className, instance, context) {
    auditLog.write({
      action: 'save',
      entity: className,
      entityId: instance.id,
      timestamp: context.timestamp,
      changes: instance._changedFields
    });
  },

  afterDelete(className, id, context) {
    auditLog.write({
      action: 'delete',
      entity: className,
      entityId: id,
      timestamp: context.timestamp
    });
  }
});
```

### Example: Soft Deletes

```typescript
GlobalInterceptors.register({
  name: 'soft-delete',
  priority: 90,

  // Filter out soft-deleted records from all queries
  beforeList(className, options, context) {
    return {
      ...options,
      where: { ...options.where, 'deletedAt': null }
    };
  },

  // Convert delete to soft delete
  beforeDelete(className, id, context) {
    const collection = getCollection(className);
    collection.db.execute`
      UPDATE ${collection.tableName}
      SET deleted_at = ${new Date()}
      WHERE id = ${id}
    `;
    return false; // Cancel the actual delete
  }
});
```

## Context Memory System

The Context Memory System enables SMRT objects to remember and recall operational knowledge, learned patterns, and parsing strategies. This is essential for AI agents that discover effective approaches and need to reuse them across sessions.

### Why Context Memory?

When an AI agent discovers that a specific CSS selector works for extracting content from a website, or learns that a particular date format is used consistently, it should remember this for future use. The Context Memory System provides persistent storage for these learned patterns with:

- **Hierarchical scoping**: Organize patterns by domain, context, and specificity
- **Confidence tracking**: Store how reliable each pattern is (0-1 scale)
- **Automatic fallback**: Query from specific to general scopes
- **Success metrics**: Track usage counts for pattern optimization
- **Expiration support**: Optional TTL for time-sensitive patterns

### Core Methods

#### Object-Level Context

Store and retrieve context specific to an individual object instance:

```typescript
import { SmrtObject, field } from '@happyvertical/smrt-core';

class WebScraper extends SmrtObject {
  @field({ required: true })
  url: string = '';

  async discoverContentSelector() {
    const url = this.url;

    // Try to recall previously discovered selector
    const remembered = await this.recall({
      scope: `parser/content/${new URL(url).hostname}`,
      key: 'article-selector',
      includeAncestors: true // Falls back to parent scopes
    });

    if (remembered) {
      console.log(`Using cached selector (confidence: ${remembered.confidence})`);
      return remembered.value;
    }

    // Discover selector using AI
    const selector = await this.do(`
      Analyze this webpage and determine the best CSS selector
      for the main article content: ${url}
    `);

    // Remember for future use
    await this.remember({
      scope: `parser/content/${new URL(url).hostname}`,
      key: 'article-selector',
      value: selector,
      confidence: 0.9,
      metadata: { discoveredAt: new Date() }
    });

    return selector;
  }
}
```

#### Collection-Level Context

Store context shared across all instances of a collection:

```typescript
class ScraperCollection extends SmrtCollection<WebScraper> {
  static readonly _itemClass = WebScraper;

  async getDefaultUserAgent() {
    // Recall collection-wide default
    const remembered = await this.recall({
      scope: 'config/http',
      key: 'user-agent'
    });

    if (remembered) {
      return remembered.value;
    }

    // Set default for all instances
    const userAgent = 'Mozilla/5.0 (compatible; MyBot/1.0)';
    await this.remember({
      scope: 'config/http',
      key: 'user-agent',
      value: userAgent,
      confidence: 1.0
    });

    return userAgent;
  }
}
```

### Hierarchical Scoping

Context scopes follow a hierarchical pattern for intelligent fallback:

```typescript
// Most specific scope
await scraper.remember({
  scope: 'parser/date/example.com/news',
  key: 'format',
  value: 'MM/DD/YYYY'
});

// Broader scope (fallback for other sections)
await scraper.remember({
  scope: 'parser/date/example.com',
  key: 'format',
  value: 'ISO-8601'
});

// General scope (fallback for all domains)
await scraper.remember({
  scope: 'parser/date',
  key: 'format',
  value: 'YYYY-MM-DD'
});

// Query with ancestor fallback
const format = await scraper.recall({
  scope: 'parser/date/example.com/events',
  key: 'format',
  includeAncestors: true
});
// Returns 'ISO-8601' (parent scope match)
```

**Scope Hierarchy Example**:
```
parser/                           # Root: General patterns
└── date/                         # Date parsing strategies
    ├── example.com/              # Domain-specific patterns
    │   ├── news/                 # Section-specific patterns
    │   └── events/               # Section-specific patterns
    └── another-site.com/
```

### All Context Methods

#### `remember(options)` - Store Context

```typescript
await object.remember({
  id?: string,           // Optional: Update existing entry
  scope: string,         // Hierarchical scope (e.g., 'parser/html/domain.com')
  key: string,           // Context key within scope
  value: any,            // Context value (JSON-serializable)
  metadata?: any,        // Additional metadata
  confidence?: number,   // Confidence score 0-1 (default: 1.0)
  version?: number,      // Version number (default: 1)
  expiresAt?: Date       // Optional expiration timestamp
});
```

#### `recall(options)` - Retrieve Context

```typescript
const context = await object.recall({
  scope: string,              // Scope to query
  key: string,                // Context key
  includeAncestors?: boolean, // Search parent scopes (default: false)
  minConfidence?: number      // Minimum confidence threshold (default: 0)
});

// Returns: { value, confidence, metadata, ... } or null if not found
```

#### `recallAll(options)` - Retrieve Multiple Contexts

```typescript
const contexts = await object.recallAll({
  scope: string,                // Scope to query
  includeDescendants?: boolean, // Include child scopes (default: false)
  minConfidence?: number        // Minimum confidence threshold (default: 0)
});

// Returns: Array of context entries
```

#### `forget(options)` - Delete Context

```typescript
await object.forget({
  scope: string,  // Scope containing the context
  key: string     // Context key to delete
});
```

#### `forgetScope(options)` - Delete Entire Scope

```typescript
// Delete all contexts in a scope
await object.forgetScope({
  scope: string,                // Scope to delete
  includeDescendants?: boolean  // Delete child scopes too (default: false)
});
```

### Practical Use Cases

#### 1. Website Parsing Patterns

```typescript
class ArticleScraper extends SmrtObject {
  async extractArticle(url: string) {
    const domain = new URL(url).hostname;

    // Try to recall parsing strategy
    const strategy = await this.recall({
      scope: `parser/article/${domain}`,
      key: 'extraction-strategy',
      includeAncestors: true
    });

    if (strategy) {
      return await this.applyStrategy(url, strategy.value);
    }

    // Discover new strategy with AI
    const newStrategy = await this.discoverStrategy(url);

    // Remember for next time
    await this.remember({
      scope: `parser/article/${domain}`,
      key: 'extraction-strategy',
      value: newStrategy,
      confidence: 0.85
    });

    return await this.applyStrategy(url, newStrategy);
  }
}
```

#### 2. API Response Patterns

```typescript
class APIClient extends SmrtObject {
  async fetchData(endpoint: string) {
    // Recall known response structure
    const structure = await this.recall({
      scope: `api/response/${endpoint}`,
      key: 'structure'
    });

    if (structure) {
      // Use known structure for efficient parsing
      return this.parseResponse(response, structure.value);
    }

    // Analyze and remember response structure
    const response = await fetch(endpoint);
    const discoveredStructure = await this.analyzeStructure(response);

    await this.remember({
      scope: `api/response/${endpoint}`,
      key: 'structure',
      value: discoveredStructure,
      confidence: 1.0
    });

    return this.parseResponse(response, discoveredStructure);
  }
}
```

#### 3. Configuration Defaults

```typescript
class DocumentProcessor extends SmrtObject {
  async initialize() {
    await super.initialize();

    // Recall processing preferences
    const preferences = await this.recallAll({
      scope: 'config/processing',
      includeDescendants: true
    });

    // Apply remembered preferences
    for (const pref of preferences) {
      this.applyPreference(pref.key, pref.value);
    }
  }

  async updatePreference(key: string, value: any) {
    await this.remember({
      scope: 'config/processing',
      key,
      value,
      confidence: 1.0
    });
  }
}
```

#### 4. Pattern Evolution and Versioning

```typescript
class PatternLearner extends SmrtObject {
  async evolvePattern(scope: string, key: string) {
    // Get current pattern version
    const current = await this.recall({ scope, key });

    if (!current) return;

    // Create improved version
    const improved = await this.improvePattern(current.value);

    // Store as new version
    await this.remember({
      scope,
      key,
      value: improved,
      version: (current.version || 1) + 1,
      confidence: 0.7, // Lower confidence for untested version
      metadata: {
        previousVersion: current.version,
        improvedAt: new Date()
      }
    });
  }
}
```

### Database Storage

Context is stored in the `_smrt_contexts` system table alongside your application data. The table includes:

- **Hierarchical scopes**: For organizing patterns by domain and specificity
- **Confidence tracking**: To prioritize reliable patterns
- **Version support**: For pattern evolution over time
- **Usage metrics**: Success/failure counts for optimization
- **Timestamps**: Created, updated, and last used dates
- **Expiration**: Optional TTL for time-sensitive patterns

The system table is automatically created when you initialize any SMRT object with database configuration.

### Best Practices

1. **Use hierarchical scopes**: Organize from general to specific (e.g., `parser/date/domain.com/section`)
2. **Include confidence scores**: Track how reliable each pattern is
3. **Set appropriate confidence thresholds**: Filter out low-confidence patterns with `minConfidence`
4. **Use metadata for debugging**: Store discovery timestamps, AI model used, etc.
5. **Clean up old patterns**: Use `forgetScope()` to remove outdated contexts
6. **Version critical patterns**: Use version numbers for pattern evolution
7. **Consider expiration**: Set `expiresAt` for time-sensitive patterns

## Cross-Package Integration

SMRT integrates seamlessly with other HAVE SDK packages:

```typescript
// With @happyvertical/spider for web content
import { SpiderAdapter } from '@happyvertical/spider';

class WebDocument extends SmrtObject {
  url = text({ required: true });
  content = text();

  async scrapeContent() {
    const spider = new SpiderAdapter(this.options.spider);
    this.content = await spider.getTextContent(this.url);
    await this.save();
  }
}

// With @happyvertical/pdf for document processing
import { PDFProcessor } from '@happyvertical/pdf';

class PDFDocument extends SmrtObject {
  filePath = text({ required: true });
  extractedText = text();

  async extractText() {
    const pdf = new PDFProcessor(this.options.pdf);
    this.extractedText = await pdf.extractText(this.filePath);
    await this.save();
  }
}

// With @happyvertical/files for file management
class FileDocument extends SmrtObject {
  async saveToFile(filename: string) {
    await this.fs.writeText(filename, this.content);
  }
}
```

## Error Handling

SMRT provides comprehensive error handling with specific error types:

```typescript
import { ValidationError, DatabaseError, RuntimeError } from '@happyvertical/smrt-core';

try {
  await document.save();
} catch (error) {
  if (error instanceof ValidationError) {
    console.log('Validation failed:', error.field, error.value);
  } else if (error instanceof DatabaseError) {
    console.log('Database error:', error.operation, error.sql);
  } else if (error instanceof RuntimeError) {
    console.log('Runtime error:', error.operation, error.target);
  }
}
```

## Performance Tips

SMRT includes several optimizations for building high-performance AI agents:

### 1. Use Eager Loading for Relationships

When accessing related objects for most/all items in a list, use eager loading to avoid N+1 queries:

```typescript
// 40-70% faster for relationship-heavy queries
const orders = await orderCollection.list({
  where: { status: 'pending' },
  include: ['customerId', 'productId'],
  limit: 50
});
```

### 2. Collection Instances are Cached Automatically

Collections are automatically cached and reused when loading relationships, providing 60-80% reduction in initialization overhead:

```typescript
// First access initializes and caches the collection
const customer = await order.loadRelated('customerId');

// Subsequent accesses reuse the cached collection instance
const product = await order.loadRelated('productId');
```

### 3. Batch Operations

For inserting or updating many objects, use transactions when supported:

```typescript
await db.transaction(async () => {
  for (const data of items) {
    const obj = await collection.create(data);
    await obj.save();
  }
});
```

### 4. Use Indexes for Frequently Queried Fields

Add indexes to fields that are commonly used in WHERE clauses:

```typescript
class Product extends SmrtObject {
  sku = text({ required: true, unique: true, index: true });
  category = text({ index: true }); // Frequently queried
  price = decimal({ min: 0 });
}
```

### 5. Cache AI Responses

For expensive AI operations, cache results in object properties:

```typescript
class Document extends SmrtObject {
  summary: string = '';

  async getSummary() {
    if (!this.summary) {
      this.summary = await this.do('Summarize this document');
      await this.save(); // Cache result
    }
    return this.summary;
  }
}
```

**Learn more**: See the performance considerations in package `AGENTS.md` for detailed optimization strategies.

## Troubleshooting

### Collection Table Names

**Issue**: Collections query incorrect table names (e.g., `place_collections` instead of `places`).

**Cause**: In versions before v0.32.1, collections used their own class name for table naming instead of the item class name.

**Fixed in v0.32.1**: Collections now correctly use the item class name for table naming:
```typescript
class PlaceCollection extends SmrtCollection<Place> {
  static readonly _itemClass = Place;
  // Table name: 'places' (from Place class), not 'place_collections'
}
```

**Migration**: If you have data in the incorrectly-named table:
```sql
-- Rename the table to match the item class name
ALTER TABLE place_collections RENAME TO places;
```

### Static Factory Pattern Required

**Issue**: TypeError when trying to instantiate collections with `new`.

**Cause**: Collection constructors are protected to prevent partially-initialized instances.

**Solution**: Always use the static `create()` factory method:
```typescript
// ✅ CORRECT - Fully initialized collection
const collection = await ProductCollection.create({
  db: { type: 'sqlite', url: 'products.db' }
});

// ❌ WRONG - Constructor is protected
const collection = new ProductCollection(options); // Error!
```

The static factory method ensures collections are fully initialized with database connections, AI clients, and file system access before use.

### Collection _itemClass Requirement

**Issue**: Error "Collection must define a static _itemClass property".

**Cause**: Collections require a static `_itemClass` property to know which object type they manage.

**Solution**: Always define the static _itemClass:
```typescript
class DocumentCollection extends SmrtCollection<Document> {
  static readonly _itemClass = Document; // Required!
}
```

### Slug and Context Uniqueness

**Issue**: UNIQUE constraint violation when saving objects.

**Cause**: SMRT enforces a unique constraint on `(slug, context)` pairs.

**Understanding**: Objects can have the same slug if they have different contexts:
```typescript
// These are DIFFERENT objects (different contexts)
const blog = await collection.create({ slug: 'intro', context: '/blog' });
const docs = await collection.create({ slug: 'intro', context: '/docs' });

// This FAILS (same slug + context)
const blog2 = await collection.create({ slug: 'intro', context: '/blog' });
// Error: UNIQUE constraint failed: slug, context
```

**Solution**: Ensure unique slugs within the same context, or use different contexts for objects with the same slug.

## API Reference

See the [API documentation](https://happyvertical.github.io/sdk/modules/_have_smrt.html) for detailed information on all available methods and options.

## License

This package is part of the HAVE SDK and is licensed under the MIT License - see the [LICENSE](../../LICENSE) file for details.
