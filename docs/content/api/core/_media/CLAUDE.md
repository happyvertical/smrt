# @smrt/core: AI Agent Framework Package

## Purpose and Responsibilities

The `@smrt/core` package is the core framework for building vertical AI agents in the HAVE SDK. It provides a comprehensive foundation for creating intelligent agents with persistent storage, cross-package integration, and automatic code generation capabilities.

### Core Framework Architecture
- **Object-Relational Mapping**: Automatic schema generation from TypeScript class properties with application-level timestamp management
- **AI-First Design**: Built-in `is()` and `do()` methods for AI-powered validation and operations
- **Collection Management**: Standardized CRUD operations with flexible querying (operators: =, >, <, >=, <=, !=, in, like)
- **Error Handling System**: Comprehensive error types (DatabaseError, ValidationError, AIError, etc.) with retry logic
- **Registry System**: Global object registry for runtime introspection and code generation

### Advanced Code Generation
- **CLI Generators**: Create administrative command-line tools from SMRT objects
- **REST API Generators**: Auto-generate complete REST APIs with OpenAPI documentation
- **MCP Server Generators**: Generate Model Context Protocol servers for AI integration
- **Vite Plugin Integration**: Automatic service generation with virtual modules (@smrt/routes, @smrt/client, @smrt/mcp)

### Runtime Environment Support
- **Node.js Only**: Package now focused on Node.js for simplified deployment and better performance
- **AST Scanning**: Automatic discovery of SMRT objects via TypeScript AST parsing
- **Virtual Module System**: Dynamic code generation through Vite plugins during development
- **Type Safety**: Automatic TypeScript declaration generation for virtual modules

**Expert Agent Expertise**: When working with this package, always proactively check the latest documentation using WebFetch for foundational libraries (@langchain/community, cheerio, yaml) as they frequently add new features that can enhance agent capabilities. Recent updates include:
- **@langchain/community**: Advanced retrieval strategies, multimodal tool calling, streaming events, and LangGraph for stateful multi-actor applications
- **cheerio**: Blazingly fast HTML parsing with jQuery-like syntax for server-side content processing
- **yaml**: Full YAML 1.1/1.2 support with AST manipulation and custom tag resolution for flexible configuration management

The SMRT framework is designed to leverage the latest capabilities from its dependencies for optimal agent performance.

## Critical Implementation Patterns

### Static Factory Pattern for Collections (IMPORTANT)

The framework uses **static factory methods** for creating collections, following industry best practices for async initialization:

```typescript
// ✅ CORRECT - Static factory method (current pattern)
const collection = await ProductCollection.create({
  persistence: { type: 'sql', url: 'products.db' },
  ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
});

// ✅ ALSO CORRECT - Pass object options directly
const product = new Product({ name: 'Widget' });
await product.initialize();
const collection = await ProductCollection.create(product.options);

// ❌ WRONG - Direct constructor access (now protected)
const collection = new ProductCollection(options); // Error: constructor is protected
await collection.initialize();
```

**Why static factories**:
- **Guaranteed initialization**: Returns fully initialized, ready-to-use instances
- **Type flexibility**: Accepts broad `SmrtClassOptions` and extracts compatible options internally
- **No partial state**: Eliminates "partially-initialized" object bugs
- **Industry standard**: Follows TypeScript best practices for async initialization

**Constructor vs Factory**:
- **Collections**: Use `await Collection.create()` - constructor is protected
- **Objects**: Use `new Object()` + `await object.initialize()` - constructor pattern remains

**Symmetry**: `Collection.create()` (static factory) creates collections, `collection.create()` (instance method) creates objects.

### Field System (packages/smrt/src/fields/index.ts)

The framework provides a typed field definition system for schema generation:

```typescript
import { text, integer, decimal, boolean, datetime, json, foreignKey } from '@smrt/core/fields';

class Product extends SmrtObject {
  name = text({ required: true, maxLength: 100 });
  price = decimal({ min: 0, required: true });
  active = boolean({ default: true });
  categoryId = foreignKey(Category, { onDelete: 'restrict' });
}
```

**Field Types**:
- `text(options)` - TEXT column with optional maxLength, minLength, pattern validation
- `integer(options)` - INTEGER column with optional min/max constraints
- `decimal(options)` - REAL column for floating point numbers
- `boolean(options)` - INTEGER column (0/1) for boolean values
- `datetime(options)` - DATETIME column for timestamps
- `json(options)` - TEXT column with JSON serialization
- `foreignKey(relatedClass, options)` - TEXT column for foreign key relationships with onDelete behavior
- `oneToMany(relatedClass, options)` - One-to-many relationship (doesn't create column)
- `manyToMany(relatedClass, options)` - Many-to-many relationship (doesn't create column)

**Field Options** (all types):
- `required: boolean` - NOT NULL constraint
- `default: any` - Default value
- `unique: boolean` - UNIQUE constraint
- `index: boolean` - Create database index
- `description: string` - Documentation

### Object Registry System (packages/smrt/src/registry.ts)

**Global registry for runtime introspection and code generation**

The `@smrt()` decorator automatically registers classes:

```typescript
import { smrt } from '@smrt/core';

@smrt({
  api: { exclude: ['delete'] },
  mcp: { include: ['list', 'get', 'analyze'] },
  cli: true
})
class Document extends SmrtObject {
  title = text({ required: true });
  content = text();

  // Custom action methods are automatically discovered
  async analyze(options: any) {
    return { results: await this.ai.message(`Analyze: ${this.content}`) };
  }
}
```

**Registry API**:
- `ObjectRegistry.register(constructor, config)` - Manually register a class
- `ObjectRegistry.registerCollection(objectName, collectionConstructor)` - Register collection for object
- `ObjectRegistry.getClass(name)` - Get registered class metadata
- `ObjectRegistry.getAllClasses()` - Get all registered classes
- `ObjectRegistry.getFields(name)` - Get field definitions for class
- `ObjectRegistry.getConfig(name)` - Get configuration for class
- `ObjectRegistry.getCollection(className, options)` - Get cached or create new collection instance

**Auto-registration**: Objects automatically register when instantiated (unless `_skipRegistration: true` in options)

#### Singleton Collection Management (Phase 4)

The ObjectRegistry implements a singleton pattern for collection instances, providing significant performance improvements by eliminating redundant initialization overhead.

**How It Works**:
- Collections are cached with an intelligent key based on `className` + persistence configuration
- Cache key format: `${className}:${JSON.stringify({persistence, db, ai})}`
- First call creates and initializes the collection
- Subsequent calls with same configuration return the cached instance
- Different persistence configurations create separate cached instances

**Performance Benefits**:
- **60-80% reduction** in collection initialization overhead
- Eliminates repeated database connection setup
- Reduces memory footprint for relationship-heavy operations
- Automatic in relationship loading (internal usage)

**API Usage**:
```typescript
// Get or create cached collection
const productCollection = await ObjectRegistry.getCollection<Product>(
  'Product',
  {
    persistence: { type: 'sql', url: 'products.db' },
    ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
  }
);

// Same configuration returns cached instance
const sameCollection = await ObjectRegistry.getCollection<Product>(
  'Product',
  {
    persistence: { type: 'sql', url: 'products.db' },
    ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
  }
);

console.log(productCollection === sameCollection); // true (same instance)

// Different configuration creates new instance
const differentCollection = await ObjectRegistry.getCollection<Product>(
  'Product',
  {
    persistence: { type: 'rest', baseUrl: 'https://api.example.com' }
  }
);

console.log(productCollection === differentCollection); // false (different config)
```

**Automatic Usage in Relationship Loading**:
```typescript
class Order extends SmrtObject {
  customerId = foreignKey(Customer);
}

const order = await orderCollection.get('order-123');

// Internally uses ObjectRegistry.getCollection() - no manual caching needed
const customer = await order.loadRelated('customerId');
// Reuses cached CustomerCollection instance across all relationship loads
```

**Cache Management**:
- Cache persists for the lifetime of the application
- Cleared when `ObjectRegistry.clear()` is called
- Collections share resources efficiently (database connections, AI clients)
- Thread-safe for concurrent access

### Error Handling System (packages/smrt/src/errors.ts)

**Comprehensive error types with retry logic**

Error Classes:
- `DatabaseError` - Database operations (connection, queries, schema, constraints)
- `ValidationError` - Data validation (required fields, types, uniqueness, ranges)
- `AIError` - AI provider operations (rate limits, authentication, invalid responses)
- `FilesystemError` - File operations (not found, permissions, disk space)
- `NetworkError` - Network requests (timeouts, service unavailable)
- `ConfigurationError` - Setup and configuration (missing config, invalid values)
- `RuntimeError` - Runtime execution (operation failures, invalid state)

**Static Factory Methods**:
```typescript
// Database errors
DatabaseError.connectionFailed(dbUrl, cause?)
DatabaseError.queryFailed(query, cause?)
DatabaseError.schemaError(tableName, operation, cause?)
DatabaseError.constraintViolation(constraint, value, cause?)

// Validation errors
ValidationError.requiredField(fieldName, objectType)
ValidationError.invalidValue(fieldName, value, expectedType)
ValidationError.uniqueConstraint(fieldName, value)
ValidationError.rangeError(fieldName, value, min?, max?)

// AI errors
AIError.providerError(provider, operation, cause?)
AIError.rateLimitExceeded(provider, retryAfter?)
AIError.invalidResponse(provider, response)
AIError.authenticationFailed(provider)
```

**Error Utilities**:
```typescript
// Automatic retry with exponential backoff
await ErrorUtils.withRetry(
  async () => await riskyOperation(),
  maxRetries = 3,
  delay = 1000,
  backoffMultiplier = 2
);

// Check if error is retryable (network, AI errors)
ErrorUtils.isRetryable(error)

// Sanitize error for logging (removes sensitive fields)
ErrorUtils.sanitizeError(error)
```

**All SmrtError instances include**:
- `code: string` - Machine-readable error code
- `category: string` - Error category (database, ai, validation, etc.)
- `details: Record<string, any>` - Additional context
- `cause: Error` - Original error that caused this
- `toJSON()` - Serialization for logging

## Key Concepts

### SmrtClass (packages/smrt/src/class.ts)

**Foundation class providing core functionality for the SMRT framework**

Properties:
- `_ai: AIClient` - AI client instance for model interactions
- `_fs: FilesystemAdapter` - Filesystem adapter for file operations
- `_db: DatabaseInterface` - Database interface for data persistence
- `_className: string` - Class name for identification
- `options: SmrtClassOptions` - Configuration options

Key Methods:
- `initialize()` - Sets up database, filesystem, and AI client connections (must be called before using services)
- Getters: `ai`, `db`, `fs` - Access to initialized services

**Important**: Always call `initialize()` after creating an instance to set up service connections.

### SmrtObject (packages/smrt/src/object.ts)

**Persistent object with unique identifiers and database storage**

Core Properties:
- `id: string` - Unique UUID identifier (auto-generated if not provided)
- `slug: string` - URL-friendly identifier (auto-generated from name, or ID as fallback if name not provided)
- `context: string` - Optional context to scope the slug (enables multiple objects with same slug in different contexts)
- `name: string` - Human-readable name, primarily for display (optional - ID will be used for slug if omitted)
- `created_at: Date` - Creation timestamp (auto-managed by application on first save)
- `updated_at: Date` - Last update timestamp (auto-managed by application on each save)

Key Methods:
- `save()` - Saves object to database with UPSERT on (slug, context) constraint
- `delete()` - Deletes object from database with lifecycle hooks
- `loadFromId()` - Loads data by ID
- `loadFromSlug()` - Loads data by slug and context
- `getSlug()` - Gets or generates slug from name (converts to lowercase, replaces non-alphanumeric with hyphens)
- `is(criteria: string, options?)` - AI-powered validation against criteria (returns boolean)
- `do(instructions: string, options?)` - AI-powered operation based on instructions (returns string result)

**Schema Generation**: All non-function, non-private properties are automatically converted to database schema:
- `string` → TEXT
- `number` → INTEGER
- `Date` → DATETIME
- Properties ending with `_at` or `_date` → DATETIME

**Timestamp Management**:
- `created_at` and `updated_at` are automatically set by the `save()` method
- `created_at` is set only on the first save (when the field is null/undefined)
- `updated_at` is set on every save
- Timestamps are managed at the application level for database-agnostic compatibility

**Lifecycle Hooks** (via ObjectRegistry):
- `beforeSave`, `afterSave`, `beforeDelete`, `afterDelete`

**Error Handling**:
- Automatic retry logic for transient database failures (3 retries, 500ms initial delay with backoff)
- Comprehensive error types: `ValidationError`, `DatabaseError`, `RuntimeError`
- Constraint violation detection (UNIQUE, NOT NULL) with user-friendly messages

### SmrtCollection (packages/smrt/src/collection.ts)

**Collection interface for managing sets of SmrtObjects**

Required Configuration:
```typescript
class MyCollection extends SmrtCollection<MyObject> {
  static readonly _itemClass = MyObject; // REQUIRED
}
```

Key Methods:
- `get(filter)` - Retrieves single object by ID (UUID), slug (string), or custom filter object
- `list(options)` - Lists objects with flexible filtering, pagination, and sorting
- `create(options)` - Creates new object instance (automatically calls initialize())
- `getOrUpsert(data, defaults)` - Gets existing or creates new object
- `count(options)` - Counts records matching filters
- `setupDb()` - Sets up database schema and indexes (called automatically during initialize)

**Advanced Querying** (list method):
Supports operators in field names:
- `'price >'`: 100 - Greater than
- `'price <='`: 200 - Less than or equal
- `'status in'`: ['active', 'pending'] - IN operator
- `'name like'`: '%search%' - LIKE pattern matching
- `'deleted_at !='`: null - Not equal

Example:
```typescript
await collection.list({
  where: {
    'price >': 100,
    'category in': ['A', 'B'],
    'name like': '%product%'
  },
  orderBy: ['price DESC', 'created_at ASC'],
  limit: 20,
  offset: 0
});
```

**Schema Management**:
- Automatic table creation with proper indexes
- Composite unique constraint on (slug, context)
- Application-level timestamp management (created_at, updated_at set during save())
- Deferred setup with promise caching to avoid race conditions

#### Eager Loading and N+1 Query Prevention (Phase 5)

Eager loading solves the "N+1 query problem" by pre-loading related objects in a single efficient query instead of making separate queries for each relationship.

**The N+1 Query Problem**:
```typescript
// ❌ BAD: N+1 queries (1 + 100 additional queries)
const orders = await orderCollection.list({ limit: 100 });
for (const order of orders) {
  const customer = await order.loadRelated('customerId'); // 100 separate queries!
  console.log(customer.name);
}
```

**Solution with Eager Loading**:
```typescript
// ✅ GOOD: Single query with JOINs
const orders = await orderCollection.list({
  limit: 100,
  include: ['customerId'] // Pre-load customer relationship
});

for (const order of orders) {
  const customer = order.getRelated('customerId'); // Already loaded, no query!
  console.log(customer.name);
}
```

**Performance Benefits**:
- **40-70% performance improvement** for relationship-heavy queries
- Reduces database round trips from N+1 to 1
- Lower latency for list operations with relationships
- More efficient database resource utilization

**How It Works**:

1. **SQL Adapters** (Optimal Performance):
   - Generates `LEFT JOIN` queries dynamically based on `include` array
   - Uses table aliasing (`t0`, `t1`, `t2`) to prevent column name collisions
   - Prefixes columns with table alias (`t0_id`, `t0_name`, `t1_id`, `t1_name`)
   - Hydrates flat JOIN result set into nested object graph
   - All relationships loaded in **single database query**

2. **REST Adapters** (Batch Optimization):
   - Falls back to batch loading strategy
   - Collects all foreign key IDs from main query
   - Fetches related objects in batched requests
   - More efficient than individual requests per object

**Table Aliasing Strategy**:
```sql
-- Generated SQL for: include: ['customerId', 'shippingAddressId']
SELECT
  t0.id as t0_id,
  t0.customer_id as t0_customer_id,
  t0.shipping_address_id as t0_shipping_address_id,
  t1.id as t1_id,
  t1.name as t1_name,
  t1.email as t1_email,
  t2.id as t2_id,
  t2.street as t2_street,
  t2.city as t2_city
FROM orders t0
LEFT JOIN customers t1 ON t0.customer_id = t1.id
LEFT JOIN addresses t2 ON t0.shipping_address_id = t2.id
WHERE t0.status = 'pending'
LIMIT 50;
```

**ListOptions Interface**:
```typescript
interface ListOptions {
  where?: Record<string, any>;
  limit?: number;
  offset?: number;
  orderBy?: string | string[];

  /**
   * Relationships to eagerly load (avoids N+1 query problem)
   * Only works with foreignKey relationships
   * SQL adapters use JOIN queries, REST adapters use batched queries
   */
  include?: string[];
}
```

**Usage Examples**:

```typescript
// Single relationship
const orders = await orderCollection.list({
  where: { status: 'pending' },
  include: ['customerId'],
  limit: 50
});

// Multiple relationships
const orders = await orderCollection.list({
  where: { status: 'pending' },
  include: ['customerId', 'shippingAddressId', 'productId'],
  limit: 50
});

// Access pre-loaded relationships
for (const order of orders) {
  const customer = order.getRelated('customerId');
  const address = order.getRelated('shippingAddressId');
  const product = order.getRelated('productId');

  console.log(`Order for ${customer?.name} shipping to ${address?.city}`);
}

// Combine with other query options
const recentOrders = await orderCollection.list({
  where: {
    'created_at >': '2024-01-01',
    'total >': 100
  },
  include: ['customerId', 'productId'],
  orderBy: 'created_at DESC',
  limit: 20
});
```

**Important Limitations**:
- **Only foreignKey relationships** can be eagerly loaded
- `oneToMany` and `manyToMany` relationships require separate queries
- Nested eager loading (loading relationships of relationships) not yet supported
- `include` field names must exactly match the property name with foreign key

**When to Use Eager Loading**:
- ✅ Loading lists where you'll access relationships for most/all items
- ✅ API responses that include related object data
- ✅ Reports and exports that need relationship data
- ❌ Loading lists where relationships are rarely accessed
- ❌ Simple queries without relationship access
- ❌ When only a few items need relationships (use lazy loading)

**Performance Comparison**:
```typescript
// Without eager loading: ~5000ms for 100 orders (N+1 queries)
const orders = await orderCollection.list({ limit: 100 });
for (const order of orders) {
  await order.loadRelated('customerId');       // 100 queries
  await order.loadRelated('shippingAddressId'); // 100 queries
}

// With eager loading: ~1500ms for 100 orders (single query)
const orders = await orderCollection.list({
  limit: 100,
  include: ['customerId', 'shippingAddressId'] // 1 JOIN query
});
// 70% performance improvement!
```

## Key APIs

### Defining Custom SMRT Objects with Custom Actions

```typescript
import { SmrtObject } from '@smrt/core';
import { Field } from '@smrt/core/fields';

@smrt({
  api: {
    include: ['list', 'get', 'create', 'update'],
    exclude: ['delete'] // Don't expose delete via REST API
  },
  mcp: {
    include: ['list', 'get', 'create', 'analyze', 'summarize', 'transform'],
    exclude: ['update', 'delete'] // AI can't modify or delete content
  },
  cli: true
})
class Document extends SmrtObject<any> {
  // Schema properties with Field definitions
  title: string = '';
  content: string = '';
  category: string = '';
  tags: string[] = [];
  isPriority: boolean = false;
  wordCount: number = 0;

  constructor(options: any) {
    super(options);
    Object.assign(this, options);
  }

  // Custom Action: AI-powered content analysis
  async analyze(options: any = {}) {
    if (this.ai && this.content) {
      const analysisType = options.type || 'general';
      const prompt = `Analyze this document for ${analysisType} insights: ${this.content.substring(0, 2000)}`;
      return {
        action: 'analyze',
        type: analysisType,
        results: await this.ai.message(prompt),
        wordCount: this.wordCount,
        timestamp: new Date()
      };
    }
    return { error: 'AI service not available' };
  }

  // Custom Action: Document summarization
  async summarize(options: any = {}) {
    if (this.ai && this.content) {
      const length = options.length || 'medium';
      const sentences = length === 'short' ? '1-2' : length === 'long' ? '4-5' : '2-3';
      return {
        action: 'summarize',
        summary: await this.ai.message(
          `Summarize this document in ${sentences} sentences: ${this.content.substring(0, 2000)}`
        ),
        length,
        timestamp: new Date()
      };
    }
    return null;
  }

  // Custom Action: Content transformation
  async transform(options: any = {}) {
    if (this.ai && options.instructions) {
      return {
        action: 'transform',
        original: this.content.substring(0, 500),
        transformed: await this.do(options.instructions),
        instructions: options.instructions,
        timestamp: new Date()
      };
    }
    throw new Error('Instructions required for content transformation');
  }

  // Smart content validation using AI
  async isValid(criteria: string) {
    return await this.is(criteria);
  }

  // Lifecycle hooks
  async beforeSave() {
    this.wordCount = this.content.split(/\s+/).length;
    if (!this.slug && this.title) {
      this.slug = await this.getSlug();
    }
  }
}
```

This automatically generates:
- **REST API endpoints**: `GET/POST /documents` (list, get, create, update)
- **MCP tools for AI**: `document_list`, `document_get`, `document_create`, `document_analyze`, `document_summarize`, `document_transform`
- **CLI commands**: `documents list`, `documents create`, `documents analyze`, etc.

### Advanced Collection Management

```typescript
import { SmrtCollection } from '@smrt/core';
import { Document } from './document';

class DocumentCollection extends SmrtCollection<Document> {
  static readonly _itemClass = Document;
  
  // Advanced querying with AI assistance
  async findSimilar(documentId: string, threshold: number = 0.8) {
    const document = await this.get(documentId);
    if (!document) return [];
    
    // Use vector similarity or AI-based classification
    return this.list({
      where: { 
        category: document.category,
        'wordCount >': document.wordCount * 0.5,
        'wordCount <': document.wordCount * 1.5
      },
      limit: 5,
      orderBy: 'created_at DESC'
    });
  }
  
  // Bulk operations with AI processing
  async bulkAnalyze(criteria: string) {
    const documents = await this.list({ limit: 100 });
    const results = await Promise.all(
      documents.map(async (doc) => ({
        id: doc.id,
        title: doc.title,
        meetscriteria: await doc.isValid(criteria)
      }))
    );
    return results.filter(r => r.meetsCategories);
  }
  
  // Advanced filtering with AI
  async searchBySemantics(query: string) {
    // Use AI to enhance search beyond simple text matching
    const allDocs = await this.list({});
    const relevantDocs = [];
    
    for (const doc of allDocs) {
      const relevance = await doc.do(`Rate the relevance of this content to "${query}" on a scale of 1-10. Respond with only the number.`);
      if (parseInt(relevance) >= 7) {
        relevantDocs.push(doc);
      }
    }
    
    return relevantDocs;
  }
}
```

### AI Function Calling

The SMRT framework supports automatic AI function calling, allowing LLMs to invoke methods on your objects during `is()` and `do()` operations. This enables AI to gather additional context, perform calculations, or execute domain-specific logic before providing responses.

#### Configuration

Configure which methods AI can call using the `ai` configuration in the `@smrt()` decorator:

```typescript
import { smrt, SmrtObject } from '@smrt/core';

@smrt({
  ai: {
    // Specify which methods AI can call
    callable: ['analyze', 'getMetrics', 'validateStructure'],
    // Or use shortcuts:
    // callable: 'public-async',  // All public async methods
    // callable: 'all',            // All public methods (not recommended)

    // Exclude specific methods (higher priority than callable)
    exclude: ['delete', 'reset'],

    // Custom tool descriptions (override JSDoc)
    descriptions: {
      analyze: 'Performs deep content analysis with configurable depth',
      getMetrics: 'Calculates and returns document metrics and statistics'
    }
  }
})
class Document extends SmrtObject {
  title: string = '';
  content: string = '';

  // This method can be called by AI
  async analyze(options: { depth?: 'shallow' | 'deep' } = {}) {
    const depth = options.depth || 'shallow';
    // Perform analysis
    return {
      sentiment: 'positive',
      topics: ['technology', 'innovation'],
      complexity: depth === 'deep' ? 0.85 : 0.6
    };
  }

  // This method can be called by AI
  async getMetrics() {
    return {
      wordCount: this.content.split(/\s+/).length,
      readingTime: Math.ceil(this.content.split(/\s+/).length / 200),
      paragraphs: this.content.split('\n\n').length
    };
  }

  // This method is excluded from AI calling
  async delete() {
    // Dangerous operation, not exposed to AI
  }
}
```

#### How It Works

When you call `is()` or `do()` on a SMRT object, the framework automatically:
1. Retrieves available tools from the object's manifest
2. Passes tools to the AI along with your prompt
3. If AI needs additional context, it calls the appropriate methods
4. AI receives the results and uses them to formulate its response

**Example with `is()` method:**
```typescript
const document = await documents.get('doc-123');

// AI can call analyze() and getMetrics() to verify criteria
const isHighQuality = await document.is(`
  - Document has more than 1000 words
  - Reading time is less than 10 minutes
  - Content complexity is appropriate for general audience
  - Sentiment is positive or neutral
`);

// Behind the scenes, AI might:
// 1. Call getMetrics() to check word count and reading time
// 2. Call analyze({ depth: 'deep' }) to check complexity and sentiment
// 3. Use those results to evaluate the criteria
```

**Example with `do()` method:**
```typescript
const summary = await document.do(`
  Create a 2-sentence summary that highlights:
  - Main topics covered
  - Overall sentiment
  - Target reading level
`);

// AI can call analyze() and getMetrics() to gather the information
// it needs before generating the summary
```

#### Build-Time Tool Generation

Tools are generated at build time from your TypeScript method definitions:

1. **AST Scanner** analyzes your class methods
2. **Type Converter** converts TypeScript types to JSON Schema
3. **Tool Generator** creates OpenAI-compatible function definitions
4. **Manifest** stores tools for runtime access

**Method to Tool Conversion:**
```typescript
// Your TypeScript method:
async analyze(options: {
  depth?: 'shallow' | 'deep',
  includeTopics?: boolean
} = {}) {
  // implementation
}

// Generated AI tool:
{
  type: 'function',
  function: {
    name: 'analyze',
    description: 'Performs deep content analysis with configurable depth',
    parameters: {
      type: 'object',
      properties: {
        depth: {
          type: 'string',
          enum: ['shallow', 'deep']
        },
        includeTopics: {
          type: 'boolean'
        }
      }
    }
  }
}
```

#### Runtime Tool Execution

Execute tool calls manually using the `executeToolCall()` method:

```typescript
import type { ToolCall } from '@smrt/core';

const document = await documents.get('doc-123');

// Get available tools
const tools = document.getAvailableTools();
console.log(`${tools.length} AI-callable methods available`);

// Execute a tool call manually
const toolCall: ToolCall = {
  id: 'call_123',
  type: 'function',
  function: {
    name: 'analyze',
    arguments: '{"depth": "deep", "includeTopics": true}'
  }
};

const result = await document.executeToolCall(toolCall);

if (result.success) {
  console.log('Analysis:', result.result);
  console.log('Execution time:', result.duration, 'ms');
} else {
  console.error('Error:', result.error);
}
```

#### Security Considerations

**Method Access Control:**
- Only `public` methods can be made callable
- `static` methods are never callable (tools operate on instances)
- `private` methods are never callable
- `exclude` list takes priority over `callable`

**Best Practices:**
```typescript
@smrt({
  ai: {
    // ✅ GOOD: Explicit whitelist of safe methods
    callable: ['analyze', 'summarize', 'getMetrics'],

    // ❌ RISKY: 'all' exposes everything
    // callable: 'all',

    // ✅ GOOD: Exclude dangerous operations
    exclude: ['delete', 'update', 'save', 'reset']
  }
})
class Document extends SmrtObject {
  // Safe: Read-only analysis
  async analyze() { /* ... */ }

  // Dangerous: Modifies data (should be excluded)
  async delete() { /* ... */ }
}
```

#### Type Conversion Reference

The tool generator converts TypeScript types to JSON Schema:

| TypeScript Type | JSON Schema |
|----------------|-------------|
| `string` | `{ type: 'string' }` |
| `number` | `{ type: 'number' }` |
| `boolean` | `{ type: 'boolean' }` |
| `string[]` | `{ type: 'array', items: { type: 'string' } }` |
| `Array<number>` | `{ type: 'array', items: { type: 'number' } }` |
| `'a' \| 'b'` | `{ type: 'string', enum: ['a', 'b'] }` |
| `{ foo: string }` | `{ type: 'object' }` |
| `Record<string, any>` | `{ type: 'object' }` |
| `any` | `{}` (no constraint) |

#### Advanced Usage

**Conditional Tool Availability:**
```typescript
// Tools are only available if AI config is defined
const tools = document.getAvailableTools();
if (tools.length > 0) {
  console.log('AI can call:', tools.map(t => t.function.name).join(', '));
}
```

**Tool Call Batching:**
```typescript
import { executeToolCalls } from '@smrt/core';

const toolCalls = [
  { id: '1', type: 'function', function: { name: 'analyze', arguments: '{}' } },
  { id: '2', type: 'function', function: { name: 'getMetrics', arguments: '{}' } }
];

const results = await executeToolCalls(document, toolCalls, ['analyze', 'getMetrics']);
console.log(`Executed ${results.length} tool calls`);
```

**Custom Tool Descriptions:**
```typescript
@smrt({
  ai: {
    callable: ['analyze'],
    descriptions: {
      // Override method JSDoc with custom description for AI
      analyze: `
        Analyzes document content with the following capabilities:
        - Sentiment analysis (positive/negative/neutral)
        - Topic extraction using NLP
        - Complexity scoring (0-1 scale)
        - Language detection
        Use 'depth: deep' for comprehensive analysis.
      `.trim()
    }
  }
})
```

### Code Generation and Automation

```typescript
import { CLIGenerator, APIGenerator, MCPGenerator } from '@smrt/core/generators';
import { DocumentCollection } from './documentCollection';

// Generate CLI tools automatically
const cliGenerator = new CLIGenerator({
  collections: [DocumentCollection],
  outputDir: './cli',
  includeAI: true
});

await cliGenerator.generate();
// Creates: ./cli/documents-cli.js with CRUD operations

// Generate REST API server
const apiGenerator = new APIGenerator({
  collections: [DocumentCollection],
  outputDir: './api',
  includeSwagger: true,
  middleware: ['auth', 'validation']
});

await apiGenerator.generate();
// Creates: ./api/documents-routes.js with full REST endpoints

// Generate MCP server for AI integration
const mcpGenerator = new MCPGenerator({
  collections: [DocumentCollection],
  outputDir: './mcp',
  tools: ['list', 'get', 'create', 'update', 'delete', 'search']
});

await mcpGenerator.generate();
// Creates: ./mcp/documents-mcp-server.js for Claude/AI integration
```

### Vite Plugin Integration

The SMRT framework provides two Vite plugins for different use cases:

#### SMRT Plugin (for SMRT Object Creators)

Use `smrtPlugin` when creating SMRT objects in your project:

```typescript
// vite.config.js - For projects defining SMRT objects
import { smrtPlugin } from '@smrt/core/vite-plugin';

export default {
  plugins: [
    smrtPlugin({
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      generateTypes: true,
      hmr: true,
      baseClasses: ['SmrtObject', 'SmartObject']
    })
  ]
};

// Auto-generated virtual modules available:
import { setupRoutes } from '@smrt/routes';        // REST routes
import { createClient } from '@smrt/client';       // API client
import { tools } from '@smrt/mcp';                 // MCP tools
import { manifest } from '@smrt/manifest';         // Object manifest
```

#### Consumer Plugin (for SMRT Package Users)

Use `smrtConsumer` when consuming packages that contain SMRT objects:

```typescript
// vite.config.js - For projects consuming SMRT packages
import { smrtConsumer } from '@smrt/core/consumer-plugin';

export default {
  plugins: [
    smrtConsumer({
      packages: ['@my-org/products', '@my-org/content'], // SMRT packages to scan
      generateTypes: true,
      typesDir: 'src/types/smrt-generated',
      projectRoot: process.cwd(),
      disableScanning: false
    })
  ]
};

// Resolves virtual modules from consumed SMRT packages:
import { createClient } from '@smrt/client';       // Generated from consumed packages
import { setupRoutes } from '@smrt/routes';        // Combined routes from all packages
import type { ProductData } from '@smrt/types';    // Generated TypeScript types
```

#### Dual Plugin Usage

For projects that both define and consume SMRT objects:

```typescript
// vite.config.js - Using both plugins together
import { smrtPlugin } from '@smrt/core/vite-plugin';
import { smrtConsumer } from '@smrt/core/consumer-plugin';

export default {
  plugins: [
    // Generate from local SMRT objects
    smrtPlugin({
      include: ['src/lib/models/**/*.ts'],
      exclude: ['**/*.test.ts'],
      baseClasses: ['SmrtObject', 'SmrtCollection'],
      generateTypes: true,
      watch: true,
      hmr: true,
    }),
    // Consume external SMRT packages
    smrtConsumer({
      packages: ['@my-org/shared-models'],
      generateTypes: true,
      typesDir: 'src/types/smrt-generated',
    }),
  ]
};

// Access both local and external virtual modules:
import { setupRoutes as localRoutes } from '@smrt/routes';    // From local objects
import { createClient } from '@smrt/client';                   // Combined client
import type { LocalModel, ExternalModel } from '@smrt/types'; // All types
```

### Advanced Querying and Relationships

```typescript
// Complex queries with multiple operators
const results = await collection.list({
  where: {
    'created_at >': '2023-01-01',
    'wordCount >=': 1000,
    'category in': ['research', 'analysis'],
    'title like': '%AI%',
    'isPriority': true
  },
  orderBy: ['wordCount DESC', 'created_at DESC'],
  limit: 20,
  offset: 0
});

// Relationship management
class Author extends SmrtObject<any> {
  name: string = '';
  email: string = '';
  
  async getDocuments() {
    const docCollection = await DocumentCollection.create(this.options);
    return docCollection.list({
      where: { authorId: this.id }
    });
  }
}

// Cross-collection operations
const authorDocs = await author.getDocuments();
const summaries = await Promise.all(
  authorDocs.map(doc => doc.summarize())
);

// Eager loading relationships (Phase 5)
// Define models with relationships
class Order extends SmrtObject {
  customerId = foreignKey(Customer);
  productId = foreignKey(Product);
  shippingAddressId = foreignKey(Address);
  status: string = 'pending';
  total: number = 0;
}

class Customer extends SmrtObject {
  name: string = '';
  email: string = '';
}

class Product extends SmrtObject {
  name: string = '';
  price: number = 0;
}

class Address extends SmrtObject {
  street: string = '';
  city: string = '';
  country: string = '';
}

// ❌ WITHOUT eager loading: N+1 query problem
const orders1 = await orderCollection.list({ limit: 50 });
for (const order of orders1) {
  // Each of these is a separate database query!
  const customer = await order.loadRelated('customerId');    // Query 1-50
  const product = await order.loadRelated('productId');      // Query 51-100
  const address = await order.loadRelated('shippingAddressId'); // Query 101-150

  console.log(`${customer?.name} ordered ${product?.name}`);
}
// Total: 151 database queries! (1 main + 50*3 relationships)

// ✅ WITH eager loading: Single efficient query
const orders2 = await orderCollection.list({
  limit: 50,
  include: ['customerId', 'productId', 'shippingAddressId']
});

for (const order of orders2) {
  // All relationships already loaded, no additional queries!
  const customer = order.getRelated('customerId');
  const product = order.getRelated('productId');
  const address = order.getRelated('shippingAddressId');

  console.log(`${customer?.name} ordered ${product?.name}`);
}
// Total: 1 database query with JOINs!
// Performance: ~70% faster

// Complex eager loading with filtering and sorting
const priorityOrders = await orderCollection.list({
  where: {
    'status': 'pending',
    'total >': 100,
    'created_at >': '2024-01-01'
  },
  include: ['customerId', 'productId'],
  orderBy: ['total DESC', 'created_at DESC'],
  limit: 20
});

// Generate invoice data with pre-loaded relationships
const invoices = priorityOrders.map(order => ({
  orderNumber: order.id,
  customerName: order.getRelated('customerId')?.name || 'Unknown',
  customerEmail: order.getRelated('customerId')?.email || '',
  productName: order.getRelated('productId')?.name || 'Unknown',
  productPrice: order.getRelated('productId')?.price || 0,
  total: order.total,
  status: order.status
}));

// Conditional relationship access
for (const order of priorityOrders) {
  const customer = order.getRelated('customerId');

  if (customer) {
    console.log(`Notify ${customer.email} about order ${order.id}`);
  } else {
    console.warn(`Order ${order.id} has no associated customer`);
  }
}
```

### AI-Powered Object Operations

```typescript
// Use built-in AI methods for smart operations
const document = await documents.get('doc-123');

// Validate against complex criteria
const isHighQuality = await document.is(`
  - Contains more than 1000 words
  - Has clear structure with headings
  - Includes references or citations
  - Uses professional language
`);

// Transform content based on instructions
const summary = await document.do(`
  Create a 3-sentence executive summary of this document.
  Focus on key findings and actionable insights.
  Use business-appropriate language.
`);

// Batch AI operations
const qualityCheck = await documents.bulkAnalyze(`
  Document meets publication standards:
  - Proper grammar and spelling
  - Clear argument structure
  - Adequate supporting evidence
`);
```

## Consumer Plugin for Downstream Projects

The `smrtConsumer` plugin enables projects to consume SMRT packages without defining their own SMRT objects. It automatically discovers and resolves virtual modules from installed SMRT packages.

### Consumer Plugin Options

```typescript
import { smrtConsumer, type SmrtConsumerOptions } from '@smrt/core/consumer-plugin';

interface SmrtConsumerOptions {
  /** SMRT packages to scan (e.g., ['@my-org/products', '@my-org/content']) */
  packages?: string[];
  /** Generate TypeScript declarations (default: true) */
  generateTypes?: boolean;
  /** Output directory for generated types (default: 'src/types/smrt-generated') */
  typesDir?: string;
  /** Project root path (default: process.cwd()) */
  projectRoot?: string;
  /** SvelteKit integration mode (default: false) */
  svelteKit?: boolean;
  /** Use static types only for federation builds (default: false) */
  staticTypes?: boolean;
  /** Disable file scanning (default: false) */
  disableScanning?: boolean;
}
```

### Automatic Package Discovery

The consumer plugin automatically scans `node_modules` for packages containing SMRT manifests:

```typescript
// Automatically finds and processes all installed SMRT packages
smrtConsumer({
  generateTypes: true,
  typesDir: 'src/types/smrt-generated'
})

// Or explicitly specify which packages to process
smrtConsumer({
  packages: ['@my-org/products', '@my-org/analytics'],
  generateTypes: true
})
```

### Generated Type Declarations

The plugin generates comprehensive TypeScript declarations for consumed SMRT packages:

```typescript
// Generated in src/types/smrt-generated/
├── smrt-client.d.ts      // API client interfaces
├── smrt-manifest.d.ts    // Manifest metadata
├── smrt-mcp.d.ts        // MCP tool definitions
├── smrt-routes.d.ts     // Route handler types
├── smrt-types.d.ts      // Object type definitions
└── smrt-objects.d.ts    // Individual object interfaces

// Auto-imported virtual modules:
import { createClient } from '@smrt/client';
import { setupRoutes } from '@smrt/routes';
import { tools } from '@smrt/mcp';
import type { ProductData, CategoryData } from '@smrt/types';
```

### Pre-build Type Generation

For projects requiring standalone TypeScript compilation (without Vite), use the pre-build system:

```bash
# Generate types before TypeScript compilation
npx smrt-prebuild generate-types ./manifest.json src/types

# Alternative using the main CLI
npx smrt generate-types ./manifest.json src/types

# Or via package.json script
{
  "scripts": {
    "prebuild": "smrt-prebuild generate-types ./static-manifest.js src/types/generated",
    "build": "npm run prebuild && tsc"
  }
}
```

### Federation and Library Builds

For module federation or library builds that require static types:

```typescript
smrtConsumer({
  packages: ['@my-org/shared-models'],
  staticTypes: true,        // Use static manifest only
  disableScanning: true,    // Skip dynamic scanning
  typesDir: 'src/types/smrt-static'
})
```

### Integration Patterns

#### SvelteKit Projects
```typescript
// vite.config.js for SvelteKit
import { sveltekit } from '@sveltejs/kit/vite';
import { smrtConsumer } from '@smrt/core/consumer-plugin';

export default {
  plugins: [
    sveltekit(),
    smrtConsumer({
      svelteKit: true,
      typesDir: 'src/lib/types/smrt-generated'
    })
  ]
};
```

#### Micro-frontend Architecture
```typescript
// Host application consuming multiple SMRT microservices
smrtConsumer({
  packages: [
    '@company/products-service',
    '@company/users-service',
    '@company/analytics-service'
  ],
  generateTypes: true,
  typesDir: 'src/types/microservices'
})

// Access combined APIs from all services
import { createClient } from '@smrt/client';
const client = createClient('/api/v1');

// Type-safe access to all service APIs
const products = await client.products.list();
const users = await client.users.list();
const analytics = await client.analytics.query({});
```

#### Library Development
```typescript
// Creating a library that extends SMRT functionality
smrtConsumer({
  packages: ['@smrt/core-core-models'],
  staticTypes: true,
  typesDir: 'src/types/core',
  disableScanning: true  // Faster builds for libraries
})
```

## Package Distribution and Local Development

### Built Artifact Distribution

The SMRT package follows industry standards (like AWS SDK) for distributing built artifacts. This ensures consuming applications don't need to build the entire SDK:

**Published Package Structure:**
```
@smrt/core/
├── dist/                           # Built artifacts (gitignored in development)
│   ├── consumer-plugin/index.js    # Vite plugin for consumers
│   ├── vite-plugin/index.js        # Vite plugin for SMRT creators
│   ├── generators/                 # Code generation tools
│   └── ...                         # Other built modules
├── package.json                    # Exports point to dist/ files
└── src/                            # Source code for reference
```

**Package.json Exports:**
```json
{
  "exports": {
    "./consumer-plugin": "./dist/consumer-plugin/index.js",
    "./vite-plugin": "./dist/vite-plugin/index.js",
    "./generators": "./dist/generators/index.js"
  }
}
```

### Local vs Published Usage

**Published Package Usage** (Standard):
```typescript
// Consuming from published npm package
import { smrtConsumer } from '@smrt/core/consumer-plugin';

export default defineConfig({
  plugins: [smrtConsumer({ packages: ['@my-org/products'] })]
});
```

**Local Development** (SDK Contributors):
```bash
# 1. Build the package to generate dist/ artifacts
npm run build

# 2. Then use in consuming applications
npm link @smrt/core  # or workspace linking
```

**Key Points:**
- **Users never build the SDK** - they consume pre-built artifacts
- **Gitignore excludes dist/** in development, includes in published packages
- **CI/CD builds and publishes** the complete package with dist/ artifacts
- **Local development requires build step** before testing consumer applications

### Development Workflow

**For SMRT Package Development:**
```bash
# Clean build to ensure fresh artifacts
npm run clean
npm run build

# Test consumer plugin import
node -e "console.log(require('./dist/consumer-plugin/index.js'))"

# Link for local testing
npm link
```

**For Consumer Application Development:**
```bash
# Link to local SMRT package (if developing SDK)
npm link @smrt/core

# Or install published version (standard usage)
npm install @smrt/core

# Use consumer plugin in vite.config.js
import { smrtConsumer } from '@smrt/core/consumer-plugin';
```

### Tree-Shaking and Subpath Exports

The package supports efficient tree-shaking through granular exports:

```typescript
// Import only what you need
import { smrtConsumer } from '@smrt/core/consumer-plugin';        // ~8KB
import { CLIGenerator } from '@smrt/core/generators/cli';         // ~22KB
import { SmrtObject } from '@smrt/core';                          // Core framework
```

**Vite Configuration for Tree-Shaking:**
- Uses `preserveModules: (id) => boolean` for selective bundling
- Entry points are bundled for distribution
- Internal modules preserved for optimal tree-shaking
- Source maps included for debugging

## Internal Architecture

The package uses:
- Schema generation based on class properties
- SQLite triggers for automatic timestamp management
- A consistent pattern for database operations
- Integration with AI models via the `@have/ai` package

## Dependencies

The SMRT framework integrates with multiple packages to provide comprehensive agent capabilities:

### Internal HAVE SDK Dependencies
- **@have/ai**: AI model interactions and completions across multiple providers
- **@have/files**: File system operations and content management
- **@have/pdf**: PDF document processing and text extraction
- **@have/sql**: Database operations with SQLite and PostgreSQL support
- **@have/spider**: Web content extraction and processing
- **@have/utils**: Shared utility functions and type definitions

### External Dependencies
- **@langchain/community**: Third-party integrations for LLM applications
  - Tools, chains, and retrieval strategies
  - Modular building blocks for AI applications
  - Extensive ecosystem integrations
- **cheerio**: Server-side HTML parsing and manipulation
  - jQuery-like syntax for content processing
  - Blazingly fast HTML/XML parsing
  - Removes browser inconsistencies for clean server-side processing
- **yaml**: Configuration management and data serialization
  - Full YAML 1.1 and 1.2 standard support
  - AST manipulation capabilities
  - Schema flexibility with custom tags

## Custom Action Configuration

The SMRT framework supports custom actions beyond standard CRUD operations (list, get, create, update, delete). Custom actions allow you to expose domain-specific methods as REST API endpoints, MCP tools for AI integration, and CLI commands.

### Configuration Options

```typescript
@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'analyze', 'transform'],
    exclude: ['delete'] // Hide dangerous operations
  },
  mcp: {
    include: ['list', 'get', 'analyze', 'summarize', 'research'],
    exclude: ['create', 'update', 'delete'] // AI read-only access
  },
  cli: true // Enable all actions via CLI
})
class MyAgent extends SmrtObject {
  // Custom action methods
  async analyze(options: any = {}) {
    return {
      action: 'analyze',
      results: await this.performAnalysis(options),
      timestamp: new Date()
    };
  }

  async research(options: any = {}) {
    return {
      action: 'research',
      findings: await this.conductResearch(options.query),
      confidence: 0.85
    };
  }
}
```

### Generated Endpoints

For the configuration above, SMRT automatically generates:

**REST API Endpoints:**
- `GET /myagents` → list action
- `GET /myagents/:id` → get action
- `POST /myagents` → create action
- `PUT /myagents/:id` → update action
- `POST /myagents/:id/analyze` → **custom analyze action**
- `POST /myagents/:id/transform` → **custom transform action**

**MCP Tools for AI:**
- `myagent_list` → AI can list agents
- `myagent_get` → AI can get specific agents
- `myagent_analyze` → **AI can analyze agents**
- `myagent_summarize` → **AI can summarize agents**
- `myagent_research` → **AI can research topics**

**CLI Commands:**
- `myagents list` → list all agents
- `myagents get <id>` → get specific agent
- `myagents analyze <id>` → **run analysis**
- `myagents research --query="topic"` → **conduct research**

### Method Validation

SMRT automatically validates that custom action methods exist on your class:

```typescript
// ✅ Valid - method exists
@smrt({ mcp: { include: ['research'] } })
class Agent extends SmrtObject {
  async research(options: any) { /* implementation */ }
}

// ❌ Invalid - warns and skips
@smrt({ mcp: { include: ['nonexistent'] } })
class Agent extends SmrtObject {
  // Warning: Custom action 'nonexistent' specified but method not found
}
```

### Custom Action Arguments

Custom actions receive arguments from API calls, MCP tool calls, or CLI parameters:

```typescript
async analyze(options: any = {}) {
  // From REST API: POST /agents/123/analyze { "type": "detailed" }
  // From MCP: myagent_analyze with arguments { id: "123", options: { type: "detailed" } }
  // From CLI: agents analyze 123 --type detailed

  const analysisType = options.type || 'general';
  const criteria = options.criteria || [];

  return {
    action: 'analyze',
    type: analysisType,
    results: await this.performAnalysis(analysisType, criteria),
    timestamp: new Date()
  };
}
```

### Best Practices

**Method Design:**
- Always provide default values for options: `async method(options: any = {})`
- Return structured objects with action metadata
- Include timestamps for audit trails
- Handle errors gracefully with try/catch

**Security Considerations:**
- Use `exclude` to hide sensitive operations from AI access
- Validate input parameters within custom methods
- Implement proper authentication in generated APIs
- Consider rate limiting for expensive operations

**Documentation:**
- Add JSDoc comments to custom methods for auto-generated API docs
- Describe expected options and return formats
- Include usage examples in method comments

## Development Guidelines

### Framework Architecture Patterns

**Object-Relational Mapping**
- Properties automatically generate database schema with TypeScript types
- Use Field decorators for advanced schema configuration
- Implement lifecycle hooks (beforeSave, afterDelete) for data validation
- Leverage automatic timestamp management and indexing

**AI-First Development**
- Design objects with AI interaction as primary consideration
- Use built-in `is()` and `do()` methods for intelligent operations
- Implement semantic search and content analysis methods
- Cache AI responses for performance optimization

**Collection Patterns**
- Use collections for standardized CRUD operations
- Implement custom query methods for domain-specific searches
- Apply bulk operations for efficiency at scale
- Design relationships through collection methods

### Code Generation Workflows

**CLI Development**
```bash
# Generate CLI tools from SMRT objects
import { CLIGenerator } from '@smrt/core/generators';
const generator = new CLIGenerator({
  collections: [MyCollection],
  outputDir: './cli'
});
await generator.generate();
```

**API Generation**
```bash
# Create REST APIs with OpenAPI documentation
import { APIGenerator } from '@smrt/core/generators';
const generator = new APIGenerator({
  collections: [MyCollection],
  includeSwagger: true,
  middleware: ['auth', 'validation']
});
await generator.generate();
```

**MCP Server Generation**
```bash
# Generate Model Context Protocol servers
import { MCPGenerator } from '@smrt/core/generators';
const generator = new MCPGenerator({
  collections: [MyCollection],
  tools: ['list', 'search', 'analyze']
});
await generator.generate();
```

### Runtime Environment Considerations

**Universal Deployment**
- Use conditional imports for Node.js vs browser environments
- Leverage static manifests for client-side builds
- Implement proper error handling for missing dependencies
- Design for both SSR and CSR scenarios

**Performance Optimization**
- Use database indexes for frequently queried fields
- Implement pagination for large datasets
- Cache AI responses and computed values
- Apply lazy loading for related objects

**Schema Evolution**
- Plan for database migrations with schema changes
- Use backward-compatible field additions
- Implement proper validation for data integrity
- Handle legacy data gracefully

### Testing Strategies

```bash
npm test                    # Run all tests
npm run test:watch         # Watch mode for development
npm run test:integration   # Integration tests with dependencies
npm run test:generators    # Test code generation functionality
```

**Testing Patterns**
- Mock AI responses for consistent testing
- Use in-memory databases for unit tests
- Test generated code with actual runtime scenarios
- Validate schema generation and migration scripts

### Building and Development

```bash
npm run build             # Production build
npm run build:watch       # Development watch mode
npm run dev               # Combined build and test watch
npm run clean             # Clean build artifacts
npm run docs              # Generate API documentation
```

### Agent Framework Best Practices

**Object Design**
- Initialize all properties with appropriate defaults
- Use descriptive property names that generate good schemas
- Implement domain-specific validation logic
- Design for AI interaction patterns

**Collection Management**
- Keep collections focused on single entity types
- Implement efficient querying with proper indexing
- Use bulk operations for performance at scale
- Design clear relationships between objects

**AI Integration**
- Write clear, specific prompts for consistent results
- Implement proper error handling for AI failures
- Use structured response formats when possible
- Cache expensive AI operations appropriately

**Cross-Package Integration**
- Leverage @have/spider for content ingestion
- Use @have/pdf for document processing workflows
- Integrate @have/files for asset management
- Apply @have/sql for complex querying needs

**Code Generation**
- Use AST scanning for automatic service discovery
- Implement proper TypeScript declaration generation
- Design for hot module replacement in development
- Generate comprehensive API documentation

### Expert Agent Development

When building agents with the SMRT framework:

1. **Design AI-First**: Plan object methods with AI capabilities in mind
2. **Use Code Generation**: Leverage generators for boilerplate reduction
3. **Implement Proper Schema**: Design database schemas for efficient querying
4. **Plan for Scale**: Use collections and bulk operations for large datasets
5. **Test Thoroughly**: Validate both generated code and runtime behavior
6. **Monitor Performance**: Track AI usage and database query efficiency

## API Documentation

The @smrt/core package generates comprehensive API documentation in both HTML and markdown formats using TypeDoc:

### Generated Documentation Formats

**HTML Documentation** (recommended for browsing):
- Generated in `docs/` directory for public website
- Full API reference with interactive navigation
- Cross-linked type definitions and examples
- Accessible via development server at `http://localhost:3030/`

**Markdown Documentation** (great for development):
- Generated in `packages/smrt/docs/` directory
- Markdown format perfect for IDE integration
- Accessible via development server at `http://localhost:3030/packages/smrt/`

### Generating Documentation

```bash
# Generate documentation for this package
npm run docs

# Generate and watch for changes during development
npm run docs:watch

# Start development server to browse documentation
npm run dev  # Serves docs at http://localhost:3030
```

### Development Workflow

Documentation is automatically generated during the build process and can be viewed alongside development:

1. **During Development**: Use `npm run docs:watch` to regenerate docs as you code
2. **Local Browsing**: Access HTML docs at `http://localhost:3030/` or markdown at `http://localhost:3030/packages/smrt/`
3. **IDE Integration**: Point your editor to `packages/smrt/docs/` for offline markdown reference

The documentation includes complete API coverage, usage examples, and cross-references to related HAVE SDK packages.

## Documentation Links

Always reference the latest documentation when developing AI agents with the SMRT framework, as foundational libraries frequently add new features that can enhance agent capabilities:

### Core Agent Libraries
- **@langchain/community**: [LangChain.js Documentation](https://js.langchain.com/docs/introduction/)
  - Third-party integrations for LLM applications
  - Tools, chains, and retrieval strategies for building stateful agents
  - Check for new modules and platform integrations regularly

- **cheerio**: [Official Documentation](https://cheerio.js.org/)
  - Server-side jQuery implementation for HTML processing
  - Review for new selectors, traversal methods, and parsing optimizations
  - Essential for web content processing in agent workflows

- **yaml**: [Documentation](https://eemeli.org/yaml/)
  - YAML parsing and manipulation with AST support
  - Monitor for schema enhancements and parsing improvements
  - Critical for configuration management in agent deployments

### HAVE SDK Integration Points
- **@have/ai**: AI model interactions and completions
- **@have/files**: File system operations and content management
- **@have/pdf**: PDF processing and document analysis
- **@have/sql**: Database operations and schema management
- **@have/spider**: Web content extraction and processing
- **@have/utils**: Utility functions and type definitions

### Expert Agent Instructions

When working with @smrt/core:

1. **Always check latest documentation** before implementing agent solutions using WebFetch tool
2. **Stay current with framework updates** - agent frameworks evolve rapidly with new AI capabilities
3. **Review new code generation features** that could improve development workflow
4. **Check for breaking changes** in major version updates across dependencies
5. **Look for new AI integration patterns** and cross-package capabilities
6. **Monitor performance improvements** in database operations and AI processing

### Documentation Lookup Protocol

Before implementing solutions, use WebFetch to verify current capabilities:

**Core Libraries to Check**:
- **@langchain/community**: https://js.langchain.com/docs/introduction/
  - Monitor for new tools, chains, retrieval strategies
  - Check for LangGraph updates (stateful multi-actor applications)
  - Look for streaming and multimodal capabilities
- **cheerio**: https://cheerio.js.org/
  - Review for new selectors and traversal methods
  - Check parsing performance improvements
  - Monitor jQuery compatibility updates
- **yaml**: https://eemeli.org/yaml/
  - Check for schema enhancements
  - Review AST manipulation features
  - Monitor custom tag resolution improvements

**Verification Workflow**:
```typescript
// Before implementing agent solutions, verify current best practices
await WebFetch.get('https://js.langchain.com/docs/introduction/',
  'What new LangChain.js features would enhance AI agent development?');
await WebFetch.get('https://cheerio.js.org/',
  'What are the latest Cheerio features for HTML content processing?');
await WebFetch.get('https://eemeli.org/yaml/',
  'What new YAML parsing features support agent configuration?');
```

### Agent Framework Resources

The SMRT package serves as the central orchestrator for building intelligent agents that leverage:
- **Persistent object storage** with automatic schema generation
- **AI-powered operations** through built-in methods
- **Code generation tools** for rapid prototyping and deployment
- **Cross-package integration** for comprehensive agent capabilities
- **Runtime flexibility** across server and browser environments

This framework enables rapid development of vertical AI agents while maintaining production-ready scalability and performance.

## Common Gotchas and Important Considerations

### 1. Static _itemClass Requirement

**Collections MUST define static _itemClass**:
```typescript
// ✅ CORRECT
class ProductCollection extends SmrtCollection<Product> {
  static readonly _itemClass = Product;
}

// ❌ WRONG - Will throw error at runtime
class ProductCollection extends SmrtCollection<Product> {
  // Missing static _itemClass
}
```

**Error message if missing**: "Collection 'ProductCollection' must define a static _itemClass property"

### 2. Initialize Pattern

**Always call initialize() on direct instantiation**:
```typescript
// ✅ CORRECT - Initialize after construction
const product = new Product({ name: 'Widget' });
await product.initialize(); // Required to set up DB/AI/FS

// ✅ ALSO CORRECT - Collection.create() calls initialize automatically
const product = await collection.create({ name: 'Widget' });

// ❌ WRONG - Will fail when accessing db/ai/fs
const product = new Product({ name: 'Widget' });
await product.save(); // Error: db is undefined
```

### 3. Slug and Context Uniqueness

**UNIQUE constraint is on (slug, context) pair**:
```typescript
// These are DIFFERENT objects (different contexts)
const blog1 = new Post({ slug: 'hello-world', context: '/blog' });
const doc1 = new Post({ slug: 'hello-world', context: '/docs' });

// This will FAIL (same slug + context)
const blog2 = new Post({ slug: 'hello-world', context: '/blog' }); // UNIQUE constraint violation
```

**Slug auto-generation from name**:
- Converts to lowercase
- Replaces non-alphanumeric with hyphens
- Removes leading/trailing hyphens
- Example: "My Product Name!" → "my-product-name"

### 4. Field Detection and Schema Generation

**Schema is generated from instance properties**:
```typescript
class Product extends SmrtObject {
  // ✅ CORRECT - Property initialized with default value
  name: string = '';
  price: number = 0;
  active: boolean = true;

  // ❌ WRONG - Uninitialized properties won't be in schema
  name: string;
  price: number;
}
```

**Private properties are excluded**:
- Properties starting with `_` or `#` are NOT in schema
- Methods are NOT in schema
- Getters/setters are NOT in schema

### 5. Date Field Conventions

**Properties ending with _at or _date are automatically DATETIME**:
```typescript
class Event extends SmrtObject {
  start_date = new Date(); // → DATETIME column
  end_date = new Date();   // → DATETIME column
  created_at = new Date(); // → DATETIME column (auto-managed by save() method)
}
```

### 6. Collection Query Operators

**Operators MUST be in field name, not value**:
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
    price: '> 100',        // Won't work - operator should be in field name
    status: ['A', 'B']     // Won't work - need 'in' operator in field name
  }
});
```

**Supported operators**: `=` (default), `>`, `<`, `>=`, `<=`, `!=`, `in`, `like`

### 7. Lifecycle Hooks Configuration

**Hooks are configured via @smrt decorator or ObjectRegistry**:
```typescript
// ✅ CORRECT - Via decorator
@smrt({
  hooks: {
    beforeSave: 'validateData',  // Method name
    afterDelete: async (instance) => {
      // Function implementation
      await cleanup(instance);
    }
  }
})
class Product extends SmrtObject {
  async validateData() {
    // Hook implementation
  }
}

// ❌ WRONG - Direct method override doesn't work
class Product extends SmrtObject {
  async beforeSave() {
    // This won't be called automatically
  }
}
```

### 8. Custom Actions in Code Generation

**Custom methods must exist on the class**:
```typescript
@smrt({
  mcp: { include: ['analyze', 'summarize'] }  // These methods must exist
})
class Document extends SmrtObject {
  // ✅ CORRECT - Method exists
  async analyze(options: any) { }

  // ❌ WARNING - 'summarize' specified but not defined
  // Will log warning and skip MCP tool generation
}
```

### 9. Virtual Module Resolution

**Virtual modules only work with Vite plugin**:
```typescript
// ✅ WORKS - With smrtPlugin() in vite.config.js
import { setupRoutes } from '@smrt/routes';
import { createClient } from '@smrt/client';

// ❌ DOESN'T WORK - Without Vite plugin configured
// Will get "Cannot find module '@smrt/routes'" error
```

**Consumer projects need smrtConsumer()**:
```typescript
// vite.config.js in consuming project
import { smrtConsumer } from '@smrt/core/consumer-plugin';

export default {
  plugins: [
    smrtConsumer({
      packages: ['@my-org/products'] // Packages with SMRT objects
    })
  ]
};
```

### 10. Static Factory Pattern Required

**Collections must be created via static factory method**:
```typescript
// ✅ CORRECT - Static factory method
const collection = await MyCollection.create(options);
// Returns fully initialized, ready-to-use collection

// ❌ WRONG - Constructor is protected
const collection = new MyCollection(options); // Error: constructor is protected
await collection.initialize();

// Static factory handles initialization internally
// This prevents partially-initialized objects and ensures atomic creation
```

### 11. UPSERT Behavior

**save() uses UPSERT on (slug, context)**:
```typescript
const product = new Product({ slug: 'widget', context: '', name: 'Widget' });
await product.save(); // INSERT

product.name = 'Updated Widget';
await product.save(); // UPDATE (matches existing slug + context)

// New object with same slug but different context
const product2 = new Product({ slug: 'widget', context: '/store' });
await product2.save(); // INSERT (different context)
```

### 12. AI Method Validation

**is() method expects JSON boolean response**:
```typescript
// ✅ CORRECT - AI returns { "result": true }
const valid = await doc.is('Document has more than 100 words');

// ❌ AI MUST return proper JSON
// If AI returns plain "true" or "yes", will throw error
```

**do() method expects string response**:
```typescript
// ✅ CORRECT - AI returns string
const summary = await doc.do('Summarize in 2 sentences');
// Returns: "string with summary"

// Note: do() doesn't enforce JSON format
```

### 13. Error Retry Logic

**Only certain errors are retried**:
- **Retried**: `NetworkError`, `AIError`, database transient failures
- **NOT retried**: `ValidationError`, `ConfigurationError` (these are permanent failures)
- Default: 3 retries with exponential backoff (500ms → 1s → 2s)

```typescript
// Validation errors fail immediately
await product.save(); // ValidationError: required field 'name' - NO RETRY

// Network errors are retried
await ai.message('prompt'); // NetworkError: timeout - RETRIES 3 times
```

### 14. Table Name Generation

**Class names are converted to snake_case and pluralized**:
```typescript
class Product extends SmrtObject { }        // → products table
class UserAccount extends SmrtObject { }    // → user_accounts table
class Category extends SmrtObject { }       // → categories table (y→ies)
class Person extends SmrtObject { }         // → persons table (basic pluralization)
```

**Pluralization is basic**:
- Adds 's' to most words
- Converts trailing 'y' to 'ies'
- Already plural words (ending in 's') stay the same

### 15. Field Initialization with Options

**Field values can be set from constructor options**:
```typescript
class Product extends SmrtObject {
  name = text({ default: 'Untitled' });
  price = decimal({ default: 0 });
}

// Options override defaults
const p1 = new Product({ name: 'Widget', price: 99.99 });
// p1.name = 'Widget', p1.price = 99.99

// Missing fields use defaults
const p2 = new Product({});
// p2.name = 'Untitled', p2.price = 0
```

### 16. Eager Loading Only Works with ForeignKey Relationships

**Only foreignKey relationships can be eagerly loaded**:
```typescript
class Order extends SmrtObject {
  customerId = foreignKey(Customer);      // ✅ Can be eagerly loaded
  items = oneToMany(OrderItem);           // ❌ Cannot be eagerly loaded
  relatedOrders = manyToMany(Order);      // ❌ Cannot be eagerly loaded
}

// ✅ WORKS - foreignKey relationships
const orders = await orderCollection.list({
  include: ['customerId']  // Single JOIN query
});

// ❌ DOESN'T WORK - oneToMany/manyToMany relationships
const orders = await orderCollection.list({
  include: ['items']  // Silently ignored, no eager loading
});

// For oneToMany/manyToMany, use separate queries or batch loading
const orders = await orderCollection.list({ limit: 50 });
await orderCollection.batchLoadOneToMany(orders, 'items');  // Batch query
```

**Why this limitation exists**:
- `foreignKey`: Foreign key is ON the current table (simple JOIN)
- `oneToMany`: Foreign key is on OTHER table (requires reverse JOIN or subqueries)
- `manyToMany`: Requires join table (requires multiple JOINs)

### 17. Collection Cache Key Sensitivity

**Collections are cached based on full configuration**:
```typescript
// These create DIFFERENT cached instances (different persistence configs)
const collection1 = await ObjectRegistry.getCollection('Product', {
  persistence: { type: 'sql', url: 'products.db' }
});

const collection2 = await ObjectRegistry.getCollection('Product', {
  persistence: { type: 'sql', url: 'products-copy.db' }  // Different URL
});

console.log(collection1 === collection2); // false (different cache keys)

// These return SAME cached instance (identical configuration)
const collection3 = await ObjectRegistry.getCollection('Product', {
  persistence: { type: 'sql', url: 'products.db' },
  ai: { provider: 'openai', apiKey: 'key123' }
});

const collection4 = await ObjectRegistry.getCollection('Product', {
  persistence: { type: 'sql', url: 'products.db' },
  ai: { provider: 'openai', apiKey: 'key123' }
});

console.log(collection3 === collection4); // true (same cache key)
```

**Cache key format**:
```typescript
const cacheKey = `${className}:${JSON.stringify({
  persistence: options.persistence,
  db: options.db ? 'present' : undefined,
  ai: options.ai ? 'present' : undefined
})}`;
```

**Implications**:
- AI client configuration changes create new cache entry
- Database connection changes create new cache entry
- Cache persists for application lifetime
- Clear all cached collections: `ObjectRegistry.clear()`

## Performance Considerations

### 1. Collection Instance Caching (Phase 4)

**Problem**: Creating and initializing collection instances is expensive (database connections, schema setup, AI client initialization).

**Solution**: ObjectRegistry implements singleton pattern for collection instances.

**Performance Impact**: 60-80% reduction in collection initialization overhead

**How to Use**:
```typescript
// Automatic - Used internally by relationship loading
const customer = await order.loadRelated('customerId');
// ObjectRegistry.getCollection() reuses cached CustomerCollection

// Manual - For advanced use cases
const productCollection = await ObjectRegistry.getCollection('Product', options);
// Returns cached instance if called again with same options
```

**When It Helps**:
- ✅ Applications with many relationship traversals
- ✅ Long-running services (cached instances persist)
- ✅ Relationship-heavy data models
- ✅ APIs loading related data for multiple requests

**Trade-offs**:
- Collections persist for application lifetime (memory usage)
- Different persistence configs create separate cached instances
- No way to manually invalidate cache except `ObjectRegistry.clear()`

### 2. Eager Loading with JOINs (Phase 5)

**Problem**: Loading relationships one at a time creates N+1 queries (1 main query + N additional queries for relationships).

**Solution**: Use `include` option to pre-load relationships in a single JOIN query.

**Performance Impact**: 40-70% improvement for relationship-heavy queries

**How to Use**:
```typescript
// ❌ N+1 queries: 1 + 100 = 101 queries
const orders = await orderCollection.list({ limit: 100 });
for (const order of orders) {
  await order.loadRelated('customerId'); // 100 separate queries!
}

// ✅ Single query with JOINs: 1 query total
const orders = await orderCollection.list({
  limit: 100,
  include: ['customerId', 'productId'] // All in one query
});

for (const order of orders) {
  const customer = order.getRelated('customerId'); // Already loaded!
  const product = order.getRelated('productId');   // Already loaded!
}
```

**When It Helps**:
- ✅ Loading lists where most/all items need relationship data
- ✅ API endpoints returning nested object data
- ✅ Reports and data exports with relationships
- ✅ Dashboard queries with multiple related entities

**When NOT to Use**:
- ❌ Relationships rarely accessed (adds JOIN overhead)
- ❌ Only a few items need relationships (lazy load those specific ones)
- ❌ oneToMany or manyToMany relationships (not supported yet)

**Trade-offs**:
- Only works with foreignKey relationships
- Nested eager loading (relationships of relationships) not yet supported
- JOIN queries can be slower for very wide tables with many columns
- SQL adapters get JOINs, REST adapters get batch queries (less efficient)

**Performance Comparison**:
| Scenario | Without Eager Loading | With Eager Loading | Improvement |
|----------|----------------------|-------------------|-------------|
| 100 orders, 1 relationship | ~2500ms (101 queries) | ~750ms (1 query) | 70% faster |
| 100 orders, 3 relationships | ~7500ms (301 queries) | ~1500ms (1 query) | 80% faster |
| 20 orders, 2 relationships | ~1000ms (41 queries) | ~350ms (1 query) | 65% faster |

### 3. Schema Setup Caching

Collections cache their database setup promise to avoid redundant table creation. This is safe for concurrent initialization but means schema changes require process restart.

### 4. Bulk Operations

For inserting many objects, use transactions and bulk operations:
```typescript
// ❌ SLOW - Individual saves
for (const data of items) {
  const obj = await collection.create(data);
  await obj.save();
}

// ✅ FAST - Batch with transaction (if supported)
await db.transaction(async () => {
  for (const data of items) {
    const obj = await collection.create(data);
    await obj.save();
  }
});
```

### 5. Query Optimization

- Use indexes on frequently queried fields: `active = boolean({ index: true })`
- Use pagination for large result sets: `limit` and `offset` in list()
- Use `count()` instead of `list()` when you only need the count
- Add WHERE clauses to reduce result sets

### 6. AI Response Caching

Cache AI responses for expensive operations:
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