# @have/smrt

<p align="center">
  <img src="./smrt-homer.png" alt="SMRT Logo" width="400"/>
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Core AI agent framework with standardized collections, object-relational mapping, and code generators in the HAVE SDK.

## Overview

The `@have/smrt` package provides the foundation for building vertical AI agents. It offers a comprehensive framework with object-relational mapping, AI-powered operations, code generation capabilities, and seamless integration with other HAVE SDK packages.

## Key Features

- **AI-First Object Framework**: Objects with built-in AI operations (`is()`, `do()` methods)
- **Object-Relational Mapping**: Automatic database schema generation from TypeScript classes
- **Standardized Collections**: Advanced CRUD operations with flexible querying
- **Code Generation**: CLI tools, REST APIs, and MCP servers generated from objects
- **Field System**: Type-safe field definitions with validation and constraints
- **Vite Plugin Integration**: Virtual modules for automatic service generation
- **AST Scanning**: Automatic discovery of SMRT objects in codebases
- **Cross-Package Integration**: Unified access to AI, files, database, and web capabilities

## Installation

```bash
# Install with npm
npm install @have/smrt

# Or with yarn
yarn add @have/smrt

# Or with bun
bun add @have/smrt
```

## Usage

### Define SMRT Objects with Fields

```typescript
import { SmrtObject } from '@have/smrt';
import { text, integer, boolean, datetime } from '@have/smrt/fields';

// Define a document object with typed fields
class Document extends SmrtObject {
  title = text({ required: true, maxLength: 200 });
  content = text({ required: true });
  wordCount = integer({ min: 0, default: 0 });
  isPublished = boolean({ default: false });
  publishedAt = datetime();

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

### Create and Manage Collections

```typescript
import { SmrtCollection } from '@have/smrt';

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

## Code Generation

Generate CLI tools, REST APIs, and MCP servers automatically from your SMRT objects:

### CLI Generation

```typescript
import { CLIGenerator } from '@have/smrt/generators';

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
import { APIGenerator } from '@have/smrt/generators';

const generator = new APIGenerator({
  collections: [DocumentCollection],
  outputDir: './api',
  includeSwagger: true,
  middleware: ['auth', 'validation']
});

await generator.generate();
// Creates: ./api/documents-routes.js with OpenAPI documentation
```

### MCP Server Generation

```typescript
import { MCPGenerator } from '@have/smrt/generators';

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
import { SmrtObject, type SmrtObjectOptions, smrt } from '@have/smrt';
import { text, decimal } from '@have/smrt/fields';

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
  title = text({ required: true, description: "The title of the book" });
  author = text({ required: true, description: "The author's name" });
  isbn = text({ description: "International Standard Book Number" });
  price = decimal({ description: "Price of the book" });

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
import { smrtPlugin } from '@have/smrt/vite-plugin';

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
  text, integer, decimal, boolean, datetime, json,
  foreignKey, oneToMany, manyToMany
} from '@have/smrt/fields';

class Product extends SmrtObject {
  name = text({ required: true, maxLength: 100 });
  price = decimal({ min: 0, required: true });
  inStock = boolean({ default: true });
  tags = json({ default: [] });
  createdAt = datetime({ required: true });

  // Relationships
  categoryId = foreignKey(Category, { onDelete: 'restrict' });
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

For more details, see the [full CLAUDE.md documentation](./CLAUDE.md#eager-loading-and-n1-query-prevention-phase-5).

### Direct SQL Access

All SMRT objects have public `db` property for direct database access via @have/sql. This enables custom queries, transactions, and advanced database operations:

```typescript
import { SmrtObject, SmrtCollection } from '@have/smrt';

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
- **Full @have/sql power**: Access all DatabaseInterface methods (many, single, pluck, execute)
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
import { getDatabase } from '@have/sql';
const db = await getDatabase({ type: 'postgres', url: 'postgres://...' });
const collection = await ProductCollection.create({ db });
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
import { SmrtObject } from '@have/smrt';
import { text } from '@have/smrt/fields';

class WebScraper extends SmrtObject {
  url = text({ required: true });

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
// With @have/spider for web content
import { SpiderAdapter } from '@have/spider';

class WebDocument extends SmrtObject {
  url = text({ required: true });
  content = text();

  async scrapeContent() {
    const spider = new SpiderAdapter(this.options.spider);
    this.content = await spider.getTextContent(this.url);
    await this.save();
  }
}

// With @have/pdf for document processing
import { PDFProcessor } from '@have/pdf';

class PDFDocument extends SmrtObject {
  filePath = text({ required: true });
  extractedText = text();

  async extractText() {
    const pdf = new PDFProcessor(this.options.pdf);
    this.extractedText = await pdf.extractText(this.filePath);
    await this.save();
  }
}

// With @have/files for file management
class FileDocument extends SmrtObject {
  async saveToFile(filename: string) {
    await this.fs.writeText(filename, this.content);
  }
}
```

## Error Handling

SMRT provides comprehensive error handling with specific error types:

```typescript
import { ValidationError, DatabaseError, RuntimeError } from '@have/smrt';

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

**Learn more**: See the [Performance Considerations](./CLAUDE.md#performance-considerations) section in CLAUDE.md for detailed optimization strategies.

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