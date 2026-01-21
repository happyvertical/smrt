# SMRT Framework Context

This project uses the SMRT framework. Below are the conventions and patterns for the installed packages.

## Installed Packages

| Package | Version |
|---------|---------|
| @happyvertical/smrt-ads | 0.19.29 |
| @happyvertical/smrt-affiliates | 0.19.29 |
| @happyvertical/smrt-agents | 0.19.29 |
| @happyvertical/smrt-analytics | 0.19.29 |
| @happyvertical/smrt-assets | 0.19.29 |
| @happyvertical/smrt-cli | 0.19.29 |
| @happyvertical/smrt-commerce | 0.19.29 |
| @happyvertical/smrt-config | 0.19.29 |
| @happyvertical/smrt-content | 0.19.29 |
| @happyvertical/smrt-core | 0.19.29 |
| @happyvertical/smrt-dev-mcp | 0.19.29 |
| @happyvertical/smrt-events | 0.19.29 |
| @happyvertical/smrt-gnode | 0.19.29 |
| @happyvertical/smrt-jobs | 0.19.29 |
| @happyvertical/smrt-ledgers | 0.19.29 |
| @happyvertical/smrt-messages | 0.19.29 |
| @happyvertical/smrt-places | 0.19.29 |
| @happyvertical/smrt-products | 0.19.29 |
| @happyvertical/smrt-profiles | 0.19.29 |
| @happyvertical/smrt-projects | 0.19.29 |
| @happyvertical/smrt-properties | 0.19.29 |
| @happyvertical/smrt-scanner | 0.19.29 |
| @happyvertical/smrt-secrets | 0.19.29 |
| @happyvertical/smrt-svelte | 0.19.29 |
| @happyvertical/smrt-tags | 0.19.29 |
| @happyvertical/smrt-template-site-static-json | 0.19.29 |
| @happyvertical/smrt-template-sveltekit | 0.19.29 |
| @happyvertical/smrt-tenancy | 0.19.29 |
| @happyvertical/smrt-types | 0.19.29 |
| @happyvertical/smrt-users | 0.19.29 |
| @happyvertical/smrt-vitest | 0.19.29 |

---

## @happyvertical/smrt-ads

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-affiliates

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-agents

Agent framework for building autonomous actors with lifecycle management, status tracking, and graceful shutdown.

### Features

- **Lifecycle Management**: Initialize, validate, run, and shutdown hooks with automatic orchestration
- **Status Tracking**: Built-in status management (idle, initializing, running, error, shutdown)
- **Database Persistence**: All agent state automatically persisted via SmrtObject inheritance
- **Structured Logging**: Integrated logger with contextual information via `@have/logger`
- **Graceful Shutdown**: Automatic signal handling (SIGTERM, SIGINT) for clean termination
- **Configuration Management**: Abstract config property for agent-specific settings
- **Type-Safe**: Full TypeScript support with comprehensive type definitions
- **Error Handling**: Status-aware error tracking with structured logging

### Patterns

#### Agent lifecycle
Agents have managed lifecycle with init, validate, run, and shutdown hooks.
```typescript
import { Agent } from '@happyvertical/smrt-agents';

class MyAgent extends Agent {
  async onInitialize() {
    // Setup resources
  }

  async onValidate(): Promise<boolean> {
    // Return true if ready to run
    return true;
  }

  async onRun() {
    // Main agent logic
  }

  async onShutdown() {
    // Cleanup resources
  }
}
```

#### Agent status
Built-in status tracking (idle, initializing, running, error, shutdown).
```typescript
const agent = await MyAgent.create({ name: 'worker-1' });
console.log(agent.status);  // 'idle'

await agent.run();
console.log(agent.status);  // 'running'
```

### Pitfalls

- Agents automatically handle SIGTERM/SIGINT for graceful shutdown
- Override onValidate() to prevent run() if preconditions aren't met
- Agent state is persisted to database via SmrtObject inheritance

### Key Exports

`Agent`, `AgentCollection`, `AgentStatus`

---

## @happyvertical/smrt-analytics

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-assets

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-cli

Developer CLI for SMRT framework. Provides introspection, testing, schema management, and project utilities.

### Usage

```bash

### Patterns

#### Running tests
Always use `smrt test` instead of `npx vitest` - it generates the manifest first.
```typescript
# Correct
smrt test

# Wrong - will fail with 'unregistered class' errors
npx vitest
```

#### Project introspection
Use introspect command to discover all SMRT objects in your project.
```typescript
smrt introspect
smrt introspect --verbose  # detailed info
```

### Pitfalls

- Never use `npx vitest` directly - always use `smrt test` to ensure manifest generation
- Run `smrt introspect` to verify your SMRT objects are being discovered correctly

### Key Exports

`CLIGenerator`, `main`

---

## @happyvertical/smrt-commerce

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-config

Configuration management for SMRT modules with support for multiple formats (JS, TS, JSON, YAML), environment variables, and type-safe configuration.

### Features

- 🎯 **Multiple formats** - JS, TS, JSON, YAML, TOML with auto-detection
- 🔐 **Secure** - Environment variable integration and async secrets management
- 🌐 **Remote config** - Load from APIs, feature flags, service discovery
- 🔄 **Hot reload** - Watch for config changes in development
- ✨ **Type-safe** - Full TypeScript support with auto-completion
- 🎭 **Orchestration** - Top-level await enables powerful composition patterns
- 📦 **Scoped** - Global, package, and module-level configuration
- ✅ **Validated** - Schema validation with Zod

### Patterns

#### Package configuration
Get configuration for a specific SMRT package with defaults.
```typescript
import { getPackageConfig } from '@happyvertical/smrt-config';

const config = getPackageConfig('cli', {
  database: { type: 'sqlite', url: ':memory:' }
});
```

#### Config file
Create smrt.config.js in project root for framework-wide configuration.
```typescript
// smrt.config.js
export default {
  packages: {
    cli: {
      database: { type: 'sqlite', url: 'app.db' }
    }
  }
};
```

### Pitfalls

- Config files are auto-detected from project root - ensure smrt.config.js is in the right location
- Environment variables override config file values

### Key Exports

`getPackageConfig`, `loadConfig`, `defineConfig`

---

## @happyvertical/smrt-content

Content processing module for SMRT - handles documents, PDFs, web content, and media with AI-powered analysis capabilities.

### Features

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

### Patterns

#### Content object
Base content class for managing documents with metadata and AI analysis.
```typescript
import { Content, ContentCollection } from '@happyvertical/smrt-content';

const collection = await ContentCollection.create({ db: 'content.db' });
const doc = await collection.create({
  title: 'My Document',
  body: 'Document content...',
  sourceUrl: 'https://example.com'
});

// AI-powered analysis
const summary = await doc.do('Summarize this content');
```

#### Web content mirroring
Download and cache content from remote URLs with automatic text extraction.
```typescript
const content = await collection.createFromUrl('https://example.com/article');
console.log(content.body);  // Extracted text
```

### Pitfalls

- Content uses Single Table Inheritance (STI) - extend Content for custom content types
- Web content extraction may require @happyvertical/spider for complex pages

### Key Exports

`Content`, `ContentCollection`

---

## @happyvertical/smrt-core

Core AI agent framework with ORM, code generation, AI-powered operations, and automatic API/CLI/MCP server generation.

### Key Features

- **AI-First Object Framework**: Objects with built-in AI operations (`is()`, `do()` methods)
- **Object-Relational Mapping**: Automatic database schema generation from TypeScript classes
- **Standardized Collections**: Advanced CRUD operations with flexible querying
- **Code Generation**: CLI tools, REST APIs, and MCP servers generated from objects
- **Field System**: Type-safe field definitions with validation and constraints
- **Vite Plugin Integration**: Virtual modules for automatic service generation
- **AST Scanning**: Automatic discovery of SMRT objects in codebases
- **Cross-Package Integration**: Unified access to AI, files, database, and web capabilities

### Advanced Querying

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

### Troubleshooting

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

### Patterns

#### @smrt() decorator
Registers class for automatic API/CLI/MCP generation. Configure which endpoints, tools, and commands to generate.
```typescript
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'analyze'] },
  cli: true
})
class Product extends SmrtObject {
  name: string = '';
  price: number = 0.0;
}
```

#### TypeScript types for schema
Use TypeScript types for automatic database schema generation. The AST scanner infers column types from default values.
```typescript
class Product extends SmrtObject {
  name: string = '';        // TEXT
  quantity: number = 0;     // INTEGER (no decimal)
  price: number = 0.0;      // DECIMAL (has decimal)
  active: boolean = true;   // BOOLEAN
  tags: string[] = [];      // JSON
}
```

#### Static factory for collections
Collections use static create() method for guaranteed initialization. Never use 'new' directly.
```typescript
// Correct
const collection = await ProductCollection.create({
  db: { type: 'sqlite', url: 'products.db' }
});

// Wrong - constructor is protected
const collection = new ProductCollection(options); // Error!
```

#### AI-powered operations
Built-in is() and do() methods for AI-powered validation and transformation on every object.
```typescript
class Document extends SmrtObject {
  content: string = '';

  async isHighQuality(): Promise<boolean> {
    return await this.is('Content is well-written and professional');
  }

  async generateSummary(): Promise<string> {
    return await this.do('Create a 2-sentence summary');
  }
}
```

#### Custom action methods
Define custom methods on SMRT objects and expose them via API, MCP, or CLI by including them in the decorator config.
```typescript
@smrt({
  mcp: { include: ['list', 'get', 'research'] }
})
class Agent extends SmrtObject {
  async research(options: { query: string }) {
    return {
      action: 'research',
      results: await this.do(`Research: ${options.query}`)
    };
  }
}
```

### Pitfalls

- Always use `smrt test` instead of `npx vitest` directly - tests require manifest generation first
- Never override toJSON() without calling super.toJSON() - breaks STI and meta fields
- Collections require static _itemClass property: `static readonly _itemClass = Product;`
- Always call initialize() after creating objects with 'new', or use collection.create() which calls it automatically
- UNIQUE constraint is on (slug, context) pair - same slug allowed in different contexts
- Query operators go in field name: `{ 'price >': 100 }` not `{ price: '> 100' }`
- Use 0 for integers (INTEGER) and 0.0 for decimals (DECIMAL) in default values

### Key Exports

`SmrtObject`, `SmrtCollection`, `SmrtClass`, `smrt`, `ObjectRegistry`, `CLIGenerator`, `APIGenerator`, `MCPGenerator`, `createDispatchBus`

---

## @happyvertical/smrt-dev-mcp

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-events

Hierarchical event management with participant tracking, event series, and infinitely nestable event structures.

### Features

- **Hierarchical Events**: Infinitely nestable event structures (e.g., Game → Period → Goal → Assist)
- **Event Series**: Group related events with recurring patterns (daily, weekly, monthly, yearly)
- **Event Types**: Define schemas and templates for different event categories
- **Participant Tracking**: Link profiles to events with roles, placement, and grouping
- **Place Integration**: Connect events to locations via `@happyvertical/smrt-places`
- **Profile Integration**: Track participants via `@happyvertical/smrt-profiles`
- **Status Lifecycle**: Managed transitions (scheduled → in_progress → completed)
- **Recurrence Patterns**: Complex recurring event schedules with count and date limits
- **Metadata Support**: Store custom JSON data on all entities
- **External System Sync**: Track external IDs and source systems
- **Utility Functions**: Date formatting, conflict detection, duration calculation
- **Auto-Generated APIs**: REST endpoints, CLI commands, and MCP tools via SMRT framework
- **Type-Safe**: Full TypeScript support with comprehensive type definitions

### Patterns

#### Hierarchical events
Events can be infinitely nested (Game -> Period -> Goal -> Assist).
```typescript
const game = await eventCollection.create({
  _meta_type: 'Game',
  title: 'Championship Final',
  startDate: new Date()
});

const period = await eventCollection.create({
  _meta_type: 'Period',
  title: 'First Period',
  parentId: game.id
});
```

#### Event series
Group related events with recurring patterns.
```typescript
const series = await seriesCollection.create({
  title: '2024 NBA Finals',
  recurrencePattern: 'daily'
});

const game1 = await eventCollection.create({
  title: 'Game 1',
  seriesId: series.id
});
```

### Pitfalls

- Events use STI - always specify _meta_type when creating event subtypes
- Integrates with smrt-places for locations and smrt-profiles for participants

### Key Exports

`Event`, `EventCollection`, `EventSeries`, `EventParticipant`

---

## @happyvertical/smrt-gnode

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-jobs

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-ledgers

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-messages

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-places

Hierarchical place management with geocoding integration, spatial queries, and support for both real-world and abstract locations.

### Features

- **Place Hierarchy Management**: Parent-child relationships with recursive ancestor/descendant traversal
- **Place Types**: Categorize places (country, city, building, zone, room, etc.) with slug-based lookup
- **Geo Integration**: Seamless integration with `@have/geo` for geocoding and reverse geocoding
- **Coordinate Validation**: Validate and normalize geographic coordinates
- **Distance Calculations**: Haversine formula for accurate distance calculations
- **Proximity Search**: Find places within a radius of given coordinates
- **Metadata Storage**: JSON metadata support for additional place information
- **Auto-Generated APIs**: REST endpoints, CLI commands, and MCP tools via `@smrt()` decorator
- **Type Safety**: Full TypeScript support with comprehensive type definitions

### Patterns

#### Place hierarchy
Model places as trees with parent-child relationships.
```typescript
const country = await placeCollection.create({
  name: 'Canada',
  placeType: 'country'
});

const city = await placeCollection.create({
  name: 'Toronto',
  placeType: 'city',
  parentId: country.id,
  latitude: 43.6532,
  longitude: -79.3832
});
```

#### Geocoding lookup
Automatically create places from addresses using geocoding.
```typescript
// Checks local DB first, then geocodes if not found
const place = await placeCollection.lookupOrCreate(
  '123 Main St, Toronto, ON'
);
```

### Pitfalls

- Geocoding requires @happyvertical/geo package and API keys configured
- Latitude/longitude are optional - supports abstract places without coordinates

### Key Exports

`Place`, `PlaceCollection`, `PlaceType`

---

## @happyvertical/smrt-products

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-profiles

Profile management system with relationships, metadata, and reciprocal associations for people, organizations, and entities.

### Features

As a SMRT package, `@happyvertical/smrt-profiles` automatically generates:

### REST API Endpoints
- `GET /api/profiles` - List profiles
- `GET /api/profiles/:id` - Get profile
- `POST /api/profiles` - Create profile
- `PUT /api/profiles/:id` - Update profile
- `DELETE /api/profiles/:id` - Delete profile

Similar endpoints for all models (ProfileType, ProfileMetadata, etc.)

### CLI Commands
```bash

### Patterns

#### Profile types
Create profiles of different types (human, organization, robot).
```typescript
const profile = await profileCollection.create({
  name: 'John Doe',
  profileType: 'human',
  metadata: {
    email: 'john@example.com',
    title: 'Software Engineer'
  }
});
```

#### Profile relationships
Create directional or reciprocal relationships between profiles.
```typescript
await profileRelationshipCollection.create({
  fromProfileId: employeeProfile.id,
  toProfileId: companyProfile.id,
  relationshipType: 'employed_by',
  reciprocalType: 'employs'  // Auto-creates reverse relationship
});
```

### Pitfalls

- Profile types should be defined in your ProfileType collection first
- Reciprocal relationships automatically create the reverse association

### Key Exports

`Profile`, `ProfileCollection`, `ProfileRelationship`, `ProfileType`

---

## @happyvertical/smrt-projects

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-properties

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-scanner

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-secrets

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-svelte

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-tags

Hierarchical tagging system with contexts, multi-language aliases, and flexible metadata for organizing content.

### Features

- **Hierarchical Structure**: Parent-child relationships with automatic level tracking
- **Context Scoping**: Namespace isolation for multi-tenant or domain-specific tags
- **Multi-Language Support**: Tag aliases with language codes (ISO 639-1)
- **Flexible Metadata**: JSON storage for custom properties (colors, icons, statistics)
- **Slug-Based Identification**: URL-friendly unique identifiers
- **Relationship Traversal**: Query ancestors, descendants, children, and parents
- **Circular Reference Prevention**: Validates hierarchy integrity
- **Auto-Generated APIs**: REST endpoints, CLI commands, and MCP tools included
- **Type-Safe Operations**: Full TypeScript support with comprehensive types

### Patterns

#### Hierarchical tags
Create nested tag structures with parent-child relationships.
```typescript
const techTag = await tagCollection.create({
  name: 'Technology',
  context: 'blog'
});

const aiTag = await tagCollection.create({
  name: 'AI',
  parentId: techTag.id,
  context: 'blog'
});
```

#### Multi-language aliases
Provide localized tag names for internationalization.
```typescript
await tagAliasCollection.create({
  tagId: aiTag.id,
  alias: 'Intelligence Artificielle',
  language: 'fr'
});
```

### Pitfalls

- Tags are scoped by 'context' - same tag name can exist in different contexts
- Use the TagAlias class for multi-language support, not the main Tag class

### Key Exports

`Tag`, `TagCollection`, `TagAlias`

---

## @happyvertical/smrt-template-site-static-json

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-template-sveltekit

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-tenancy

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-types

Shared TypeScript type definitions for the SMRT framework. Prevents circular dependencies by centralizing types.

### Patterns

#### Import types
Import shared types from this package to avoid circular dependencies.
```typescript
import type { SmrtObjectOptions, FieldDefinition } from '@happyvertical/smrt-types';
```

### Pitfalls

- This package has zero runtime dependencies - only type definitions
- Use 'import type' for types to avoid runtime imports

### Key Exports

`SmrtObjectOptions`, `SmrtClassOptions`, `FieldDefinition`, `CollectionOptions`, `SignalType`

---

## @happyvertical/smrt-users

*No .claude-meta.json found for this package.*

---

## @happyvertical/smrt-vitest

*No .claude-meta.json found for this package.*

---
*Generated by `smrt docs:claude` — regenerate after dependency updates*
