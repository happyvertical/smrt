# @happyvertical/smrt-core: AI Agent Framework Package

## Purpose and Responsibilities

The `@happyvertical/smrt-core` package is the core framework for building vertical AI agents in the SMRT ecosystem. It provides:

### Core Framework Architecture
- **Object-Relational Mapping**: Automatic schema generation from TypeScript class properties
- **AI-First Design**: Built-in `is()` and `do()` methods for AI-powered operations
- **Collection Management**: Standardized CRUD operations with flexible querying
- **Error Handling System**: Comprehensive error types with automatic retry logic
- **Registry System**: Global object registry for runtime introspection and code generation

### Advanced Code Generation
- **CLI Generators**: Create administrative command-line tools from SMRT objects
- **REST API Generators**: Auto-generate complete REST APIs with OpenAPI documentation
- **MCP Server Generators**: Generate Model Context Protocol servers for AI integration
- **Vite Plugin Integration**: Automatic service generation with virtual modules

### Runtime Environment Support
- **Node.js Only**: Package focused on Node.js for simplified deployment and better performance
- **AST Scanning**: Automatic discovery of SMRT objects via TypeScript AST parsing
- **Virtual Module System**: Dynamic code generation through Vite plugins during development
- **Type Safety**: Automatic TypeScript declaration generation for virtual modules

## TypeScript Types vs Field Helpers

The SMRT framework supports two approaches for defining object properties. Understanding when to use each is critical for effective development.

### TypeScript Types (Primary Pattern)

Use TypeScript types for most properties. The AST scanner automatically converts types to database schema:

```typescript
class Product extends SmrtObject {
  // String → TEXT
  name: string = '';
  description: string = 'No description';

  // Number with 0 vs 0.0 heuristic
  quantity: number = 0;     // → INTEGER (no decimal point)
  price: number = 0.0;      // → DECIMAL (has decimal point)
  rating: number = 4.5;     // → DECIMAL (has decimal point)
  viewCount: number = 42;   // → INTEGER (no decimal point)

  // Boolean → BOOLEAN
  active: boolean = true;
  featured: boolean = false;

  // Arrays → JSON
  tags: string[] = [];
  metadata: Record<string, any> = {};

  // Date → DATETIME
  launchedAt: Date = new Date();
}
```

### The 0 vs 0.0 Heuristic

**Integer Detection**: Numeric literals **without** decimal point become INTEGER columns:
- `count: number = 0` → INTEGER
- `quantity: number = 1` → INTEGER
- `views: number = 42` → INTEGER
- `negativeCount: number = -5` → INTEGER

**Decimal Detection**: Numeric literals **with** decimal point become DECIMAL columns:
- `price: number = 0.0` → DECIMAL
- `rating: number = 4.5` → DECIMAL
- `percentage: number = 0.95` → DECIMAL
- `temperature: number = -3.7` → DECIMAL

**Edge Cases**:
- `number = 1.0` → DECIMAL (has dot, even though it's a whole number)
- `number = 0.` → DECIMAL (trailing dot counts)
- `number = 1e10` → INTEGER (scientific notation without dot)

**Why This Matters**:
- **Storage**: INTEGER columns use less space than DECIMAL
- **Performance**: Integer operations are faster than decimal operations
- **Semantics**: Reflects the intent (counts vs monetary values)

### Field Helpers (When Required)

Field helpers are **only required** for:

#### 1. Relationships
```typescript
class Order extends SmrtObject {
  customerId = foreignKey(Customer);
  items = oneToMany(OrderItem);
  relatedOrders = manyToMany(Order);
}
```

#### 2. Constraints and Validation
```typescript
class User extends SmrtObject {
  username = text({
    required: true,
    unique: true,
    minLength: 3,
    maxLength: 20
  });

  age = integer({
    min: 0,
    max: 150,
    required: true
  });

  email = text({
    required: true,
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  });
}
```

#### 3. Nullable Decimals
```typescript
class Place extends SmrtObject {
  // Optional decimal fields need explicit helper
  latitude = decimal({ nullable: true });
  longitude = decimal({ nullable: true });

  // TypeScript optional syntax isn't enough for decimals
  // latitude?: number;  // ❌ Scanner can't infer decimal from type alone
}
```

### Decision Tree

```
Do you need to define a property?
│
├─ Is it a relationship (foreignKey, oneToMany, manyToMany)?
│  └─ YES → Use field helper: categoryId = foreignKey(Category)
│
├─ Do you need constraints (required, unique, min, max, pattern)?
│  └─ YES → Use field helper: name = text({ required: true })
│
├─ Is it an optional decimal number?
│  └─ YES → Use field helper: latitude = decimal({ nullable: true })
│
└─ NO → Use TypeScript types:
   ├─ Strings: name: string = ''
   ├─ Integers: count: number = 0
   ├─ Decimals: price: number = 0.0
   ├─ Booleans: active: boolean = true
   └─ Arrays/Objects: tags: string[] = []
```

### Type Inference Reference

| TypeScript Pattern | Inferred SQL Type | Example |
|-------------------|-------------------|---------|
| `string = ''` | TEXT | `name: string = ''` |
| `number = 0` | INTEGER | `count: number = 0` |
| `number = 0.0` | DECIMAL | `price: number = 0.0` |
| `boolean = true` | BOOLEAN | `active: boolean = true` |
| `Date = new Date()` | DATETIME | `created: Date = new Date()` |
| `string[] = []` | JSON | `tags: string[] = []` |
| `Record<string, any>` | JSON | `meta: Record<string, any> = {}` |
| `integer()` | INTEGER | `count = integer()` |
| `decimal()` | DECIMAL | `price = decimal()` |
| `text()` | TEXT | `name = text()` |
| `foreignKey(Class)` | TEXT (foreign key) | `categoryId = foreignKey(Category)` |

### Backward Compatibility

**Field helpers still work**: Existing code using field helpers continues to function:

```typescript
// Old style (still works)
class Product extends SmrtObject {
  name = text();
  price = decimal();
  quantity = integer();
}

// New style (preferred)
class Product extends SmrtObject {
  name: string = '';
  price: number = 0.0;
  quantity: number = 0;
}

// Mixed style (also valid)
class Product extends SmrtObject {
  name: string = '';          // TypeScript type
  price: number = 0.0;        // TypeScript type
  categoryId = foreignKey(Category);  // Field helper (required for relationships)
}
```

**Field helpers take priority**: If a field helper is used, it overrides the heuristic:

```typescript
class Product extends SmrtObject {
  // Explicit field helper wins
  quantity = integer();    // → INTEGER (explicit)

  // Heuristic applies when no helper
  count: number = 0;       // → INTEGER (heuristic)
}
```

## Critical Implementation Patterns

### Static Factory Pattern for Collections

Collections use static factory methods for guaranteed initialization:

```typescript
// ✅ CORRECT - Static factory method
const collection = await ProductCollection.create({
  persistence: { type: 'sql', url: 'products.db' },
  ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
});

// ✅ ALSO CORRECT - Pass object options
const product = new Product({ name: 'Widget' });
await product.initialize();
const collection = await ProductCollection.create(product.options);

// ❌ WRONG - Constructor is protected
const collection = new ProductCollection(options); // Error!
```

**Why static factories**:
- Guaranteed initialization: Returns fully initialized instances
- Type flexibility: Accepts broad `SmrtClassOptions`
- No partial state: Eliminates partially-initialized object bugs
- Industry standard: Follows TypeScript async initialization best practices

### AI Provider Configuration

Configure AI providers globally or per-instance:

**Global Configuration**:
```typescript
import { config } from '@happyvertical/smrt-core';

config({
  ai: {
    provider: 'claude-cli',
    model: 'sonnet',
  }
});

// All objects now use claude-cli by default
const product = new Product({ name: 'Widget' });
await product.initialize();
```

**Per-Instance Configuration**:
```typescript
const document = new Document({
  name: 'My Document',
  ai: {
    provider: 'anthropic',
    model: 'claude-3-opus',
    apiKey: process.env.ANTHROPIC_API_KEY
  }
});
await document.initialize();
```

**Environment Variables**:
```bash
export SMRT_AI_PROVIDER=claude-cli
export SMRT_AI_MODEL=sonnet
export SMRT_AI_API_KEY=your-key
```

### Database Adapter Methods

Use semantic database adapter methods for type-safe operations:

```typescript
// Get single record
const record = await db.get(tableName, { id: '123' });

// List records with filtering
const records = await db.list(tableName, {
  where: {
    status: 'active',
    'created_at >': '2024-01-01'
  },
  orderBy: 'created_at DESC',
  limit: 20
});

// Delete records
await db.delete(tableName, {
  'updated_at <': '2023-01-01',
  status: 'archived'
});

// Upsert (insert or update)
await db.upsert(tableName, {
  id: '123',
  name: 'Updated Name',
  status: 'active'
}, ['id']); // Unique columns for conflict resolution
```

**Supported operators**: `=`, `>`, `<`, `>=`, `<=`, `!=`, `in`, `like`

## Key Concepts

### SmrtClass (Foundation)

**Base class providing core framework functionality**:

```typescript
class MyClass extends SmrtClass {
  // Properties
  _ai: AIClient         // AI client instance
  _fs: FilesystemAdapter // Filesystem adapter
  _db: DatabaseInterface // Database interface
  options: SmrtClassOptions // Configuration

  // Must call initialize() after construction
  async initialize() {
    // Sets up database, filesystem, and AI client connections
  }
}
```

**Always call `initialize()`** after creating an instance.

### SmrtObject (Persistent Objects)

**Core properties** (auto-managed):
- `id: string` - UUID identifier (auto-generated)
- `slug: string` - URL-friendly identifier (auto-generated from title → label → id)
- `context: string` - Optional scope for slug (enables duplicate slugs across contexts)
- `created_at: Date` - Creation timestamp (set on first save)
- `updated_at: Date` - Last update timestamp (set on every save)

**Key methods**:
- `save()` - UPSERT on (slug, context)
- `delete()` - Remove from database
- `loadFromId(id)` - Load by ID
- `loadFromSlug(slug, context)` - Load by slug + context
- `is(criteria)` - AI-powered validation (returns boolean)
- `do(instructions)` - AI-powered operation (returns string)

**Example**:
```typescript
@smrt({
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get', 'analyze'] },
  cli: true
})
class Document extends SmrtObject {
  title: string = '';
  content: string = '';
  wordCount: number = 0;
  rating: number = 0.0;

  async beforeSave() {
    this.wordCount = this.content.split(/\s+/).length;
  }

  async analyze(options: any = {}) {
    return {
      action: 'analyze',
      results: await this.ai.message(`Analyze: ${this.content}`),
      wordCount: this.wordCount
    };
  }
}
```

### SmrtCollection (Object Collections)

**Required configuration**:
```typescript
class MyCollection extends SmrtCollection<MyObject> {
  static readonly _itemClass = MyObject; // REQUIRED
}
```

**Key methods**:
- `get(filter)` - Get single object by ID, slug, or custom filter
- `list(options)` - List objects with filtering, pagination, sorting
- `create(options)` - Create new object (calls initialize() automatically)
- `getOrUpsert(data, defaults)` - Get existing or create new
- `count(options)` - Count records matching filters

**Advanced querying**:
```typescript
await collection.list({
  where: {
    'price >': 100,
    'category in': ['A', 'B'],
    'name like': '%product%',
    'deleted_at !=': null
  },
  orderBy: ['price DESC', 'created_at ASC'],
  limit: 20,
  offset: 0,
  include: ['customerId', 'productId'] // Eager load relationships
});
```

### Eager Loading (N+1 Query Prevention)

Pre-load relationships in a single query:

```typescript
// ❌ N+1 queries: 1 + 100 = 101 queries
const orders = await orderCollection.list({ limit: 100 });
for (const order of orders) {
  await order.loadRelated('customerId'); // 100 separate queries!
}

// ✅ Single query with JOINs: 1 query total
const orders = await orderCollection.list({
  limit: 100,
  include: ['customerId', 'productId'] // Pre-load in one query
});

for (const order of orders) {
  const customer = order.getRelated('customerId'); // Already loaded!
  const product = order.getRelated('productId');   // Already loaded!
}
```

**Performance**: 40-70% improvement for relationship-heavy queries

**Limitations**: Only works with `foreignKey` relationships (not `oneToMany` or `manyToMany`)

## Defining SMRT Objects

### Basic Object Definition

```typescript
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'analyze'] },
  cli: true
})
class Product extends SmrtObject {
  // TypeScript types (primary pattern)
  name: string = '';
  description: string = '';
  price: number = 0.0;      // DECIMAL (has dot)
  quantity: number = 0;     // INTEGER (no dot)
  active: boolean = true;
  tags: string[] = [];

  // Field helper (for relationship)
  categoryId = foreignKey(Category);

  // Custom action method
  async analyze(options: any = {}) {
    return {
      action: 'analyze',
      sentiment: await this.is('Product description is positive'),
      recommendation: await this.do('Suggest improvements to description')
    };
  }
}
```

This automatically generates:
- **REST API**: `GET/POST/PUT /products`
- **MCP tools**: `product_list`, `product_get`, `product_analyze`
- **CLI commands**: `products list`, `products analyze <id>`

### Custom Actions

Expose domain-specific methods via API, MCP, and CLI:

```typescript
@smrt({
  mcp: { include: ['list', 'get', 'research', 'report'] },
  api: { include: ['list', 'get', 'research'] }
})
class Agent extends SmrtObject {
  name: string = '';
  source: string = '';

  async research(options: any = {}) {
    return {
      action: 'research',
      results: await this.do(`Research: ${options.query}`),
      timestamp: new Date()
    };
  }

  async report(options: any = {}) {
    return {
      action: 'report',
      content: `Report for ${this.name}`,
      type: options.type || 'summary'
    };
  }
}
```

**Generated**:
- REST: `POST /agents/:id/research`
- MCP: `agent_research` tool
- CLI: `agents research <id> --query="topic"`

## Code Generation

### CLI Generator

```typescript
import { CLIGenerator } from '@happyvertical/smrt-core/generators';

const generator = new CLIGenerator({
  collections: [ProductCollection],
  outputDir: './cli',
  includeAI: true
});

await generator.generate();
// Creates: ./cli/products-cli.js with CRUD + custom actions
```

### API Generator

```typescript
import { APIGenerator } from '@happyvertical/smrt-core/generators';

const generator = new APIGenerator({
  collections: [ProductCollection],
  outputDir: './api',
  includeSwagger: true,
  middleware: ['auth', 'validation']
});

await generator.generate();
// Creates: ./api/products-routes.js with REST endpoints
```

### MCP Server Generator

```typescript
import { MCPGenerator } from '@happyvertical/smrt-core/generators';

const generator = new MCPGenerator({
  collections: [ProductCollection],
  outputDir: './mcp',
  tools: ['list', 'get', 'create', 'analyze']
});

await generator.generate();
// Creates: ./mcp/products-mcp-server.js for AI integration
```

## Vite Plugin Integration

### SMRT Plugin (For Object Creators)

Use when **defining** SMRT objects in your project:

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

// Auto-generated virtual modules:
import { setupRoutes } from '@happyvertical/smrt-routes';
import { createClient } from '@happyvertical/smrt-client';
import { tools } from '@happyvertical/smrt-mcp';
```

### Consumer Plugin (For Package Users)

Use when **consuming** packages with SMRT objects:

```typescript
// vite.config.js
import { smrtConsumer } from '@happyvertical/smrt-core/consumer-plugin';

export default {
  plugins: [
    smrtConsumer({
      packages: ['@my-org/products', '@my-org/content'],
      generateTypes: true,
      typesDir: 'src/types/smrt-generated'
    })
  ]
};

// Resolves virtual modules from consumed packages
import { createClient } from '@happyvertical/smrt-client';
import type { ProductData } from '@happyvertical/smrt-types';
```

### Dual Usage (Both Define and Consume)

```typescript
import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';
import { smrtConsumer } from '@happyvertical/smrt-core/consumer-plugin';

export default {
  plugins: [
    // Generate from local objects
    smrtPlugin({
      include: ['src/lib/models/**/*.ts'],
      generateTypes: true
    }),
    // Consume external packages
    smrtConsumer({
      packages: ['@my-org/shared-models']
    })
  ]
};
```

## Error Handling System

### Error Types

```typescript
// Database errors
DatabaseError.connectionFailed(dbUrl, cause?)
DatabaseError.queryFailed(query, cause?)
DatabaseError.constraintViolation(constraint, value, cause?)

// Validation errors
ValidationError.requiredField(fieldName, objectType)
ValidationError.invalidValue(fieldName, value, expectedType)
ValidationError.uniqueConstraint(fieldName, value)

// AI errors
AIError.providerError(provider, operation, cause?)
AIError.rateLimitExceeded(provider, retryAfter?)
AIError.authenticationFailed(provider)
```

### Automatic Retry

```typescript
// Retries transient failures automatically
await ErrorUtils.withRetry(
  async () => await riskyOperation(),
  maxRetries = 3,
  delay = 1000,
  backoffMultiplier = 2
);

// Check if error is retryable
if (ErrorUtils.isRetryable(error)) {
  // Network, AI errors are retryable
}
```

## Common Gotchas

### 1. Static _itemClass Required

```typescript
// ✅ CORRECT
class ProductCollection extends SmrtCollection<Product> {
  static readonly _itemClass = Product;
}

// ❌ WRONG - Missing _itemClass
class ProductCollection extends SmrtCollection<Product> {
  // Error: "Collection must define static _itemClass"
}
```

### 2. Initialize Pattern

```typescript
// ✅ CORRECT
const product = new Product({ name: 'Widget' });
await product.initialize(); // Required!

// ✅ ALSO CORRECT (collection.create calls initialize)
const product = await collection.create({ name: 'Widget' });

// ❌ WRONG - Missing initialize
const product = new Product({ name: 'Widget' });
await product.save(); // Error: db is undefined
```

### 3. Slug and Context Uniqueness

UNIQUE constraint is on **(slug, context)** pair:

```typescript
// Different contexts = OK
const blog = new Post({ slug: 'hello', context: '/blog' });
const doc = new Post({ slug: 'hello', context: '/docs' });

// Same slug + context = UNIQUE violation
const blog2 = new Post({ slug: 'hello', context: '/blog' }); // Error!
```

### 4. Query Operators in Field Name

```typescript
// ✅ CORRECT
await collection.list({
  where: {
    'price >': 100,        // Operator in field name
    'status in': ['A', 'B']
  }
});

// ❌ WRONG
await collection.list({
  where: {
    price: '> 100',        // Won't work
    status: ['A', 'B']     // Need 'in' operator
  }
});
```

### 5. Virtual Modules Need Vite Plugin

```typescript
// ✅ WORKS - With smrtPlugin in vite.config.js
import { setupRoutes } from '@happyvertical/smrt-routes';

// ❌ DOESN'T WORK - Without Vite plugin
// Error: "Cannot find module '@happyvertical/smrt-routes'"
```

### 6. Collection Static Factory Required

```typescript
// ✅ CORRECT
const collection = await MyCollection.create(options);

// ❌ WRONG - Constructor is protected
const collection = new MyCollection(options); // Error!
```

### 7. Eager Loading Only for ForeignKey

```typescript
class Order extends SmrtObject {
  customerId = foreignKey(Customer);  // ✅ Can eager load
  items = oneToMany(OrderItem);       // ❌ Cannot eager load
}

// Works
const orders = await orderCollection.list({
  include: ['customerId']
});

// Silently ignored (oneToMany not supported)
const orders = await orderCollection.list({
  include: ['items']
});
```

### 8. Integer vs Decimal with 0 vs 0.0

```typescript
class Product extends SmrtObject {
  // ✅ CORRECT - Integer with 0
  count: number = 0;      // INTEGER column

  // ✅ CORRECT - Decimal with 0.0
  price: number = 0.0;    // DECIMAL column

  // ⚠️ UNEXPECTED - Whole number but DECIMAL
  quantity: number = 1.0; // DECIMAL (has dot!)

  // ✅ CORRECT - Nullable decimal needs helper
  latitude = decimal({ nullable: true });
}
```

### 9. Field Helpers Take Priority

```typescript
// Field helper overrides heuristic
class Product extends SmrtObject {
  quantity = integer();   // Explicit helper wins
  count: number = 0;      // Heuristic applies
}
```

### 10. Retry Logic by Error Type

- **Retried**: `NetworkError`, `AIError`, transient database failures
- **NOT retried**: `ValidationError`, `ConfigurationError` (permanent failures)

## Performance Optimization

### Collection Instance Caching

Collections are cached globally by configuration:

```typescript
// First call creates and caches
const c1 = await ObjectRegistry.getCollection('Product', options);

// Same options returns cached instance
const c2 = await ObjectRegistry.getCollection('Product', options);
console.log(c1 === c2); // true

// Different options creates new instance
const c3 = await ObjectRegistry.getCollection('Product', differentOptions);
console.log(c1 === c3); // false
```

**Benefit**: 60-80% reduction in collection initialization overhead

### Eager Loading with JOINs

Use `include` to avoid N+1 queries:

```typescript
// 40-70% faster with eager loading
const orders = await orderCollection.list({
  limit: 100,
  include: ['customerId', 'productId'] // Single JOIN query
});
```

### Bulk Operations

Use transactions for inserting many objects:

```typescript
// ❌ SLOW
for (const data of items) {
  const obj = await collection.create(data);
  await obj.save();
}

// ✅ FAST
await db.transaction(async () => {
  for (const data of items) {
    const obj = await collection.create(data);
    await obj.save();
  }
});
```

## Development Guidelines

### Testing

```bash
npm test                    # Run all tests
npm run test:watch         # Watch mode
npm run test:integration   # Integration tests
```

### Building

```bash
npm run build             # Production build
npm run build:watch       # Development watch mode
npm run clean             # Clean build artifacts
```

### Code Style

- Spaces (2) for indentation
- Single quotes for strings
- Line width of 80 characters
- ESM module format exclusively
- camelCase for variables/functions, PascalCase for classes
- Conventional commits

## Dependencies

### Internal SMRT Dependencies
- **@happyvertical/smrt-types**: Shared TypeScript type definitions
- **@happyvertical/smrt-config**: Configuration management with cosmiconfig

### External SDK Dependencies
- **@happyvertical/ai**: Multi-provider AI client (OpenAI, Anthropic, Google, AWS)
- **@happyvertical/files**: File system operations and utilities
- **@happyvertical/sql**: Database operations (SQLite, Postgres, DuckDB)
- **@happyvertical/utils**: Shared utility functions

## Documentation Links

Always reference the latest documentation when developing:

- **@langchain/community**: [LangChain.js Documentation](https://js.langchain.com/docs/introduction/)
- **cheerio**: [Official Documentation](https://cheerio.js.org/)
- **yaml**: [Documentation](https://eemeli.org/yaml/)

## API Documentation

Generate comprehensive API documentation:

```bash
npm run docs              # Generate HTML + Markdown
npm run docs:watch        # Watch mode
npm run dev               # Serve at http://localhost:3030/
```

Documentation includes:
- Complete API reference
- Cross-linked type definitions
- Usage examples
- Integration with IDE (markdown format)
