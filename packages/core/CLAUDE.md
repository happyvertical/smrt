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

## Single Table Inheritance (STI)

### What is STI?

Single Table Inheritance (STI) is a database pattern where a class hierarchy shares a single database table. All subclasses are stored in the same table with a discriminator column (`_meta_type`) that identifies the actual class type.

**STI vs CTI (Class Table Inheritance)**:
- **STI**: One table for entire hierarchy, discriminator column identifies type
- **CTI**: Separate table for each class in hierarchy (default SMRT behavior)

**When to use STI**:
- ✅ Subclasses share most fields (80%+ overlap)
- ✅ Need polymorphic queries (fetch mixed types in one query)
- ✅ Frequent joins across hierarchy
- ✅ Small number of subclass-specific fields

**When NOT to use STI**:
- ❌ Subclasses have many unique fields (sparse columns)
- ❌ Deep inheritance hierarchies (3+ levels)
- ❌ Subclasses need separate indexing strategies

### Defining STI Classes

Mark the **base class** with `tableStrategy: 'sti'`. Child classes automatically inherit the strategy:

```typescript
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

// Base class defines STI strategy
@smrt({ tableStrategy: 'sti' })
class Event extends SmrtObject {
  title: string = '';
  date: Date = new Date();
  location: string = '';
}

// Child classes inherit STI (no explicit strategy needed)
@smrt()
class Meeting extends Event {
  roomNumber: string = '';
  attendees: string[] = [];
}

@smrt()
class Conference extends Event {
  sponsorName: string = '';
  ticketPrice: number = 0.0;
}

@smrt()
class Concert extends Event {
  artist: string = '';
  genre: string = '';
}
```

**Generated schema** (single `events` table for all classes):
```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  context TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  -- Base class fields
  title TEXT NOT NULL,
  date DATETIME NOT NULL,
  location TEXT NOT NULL,

  -- STI discriminator (identifies the actual class)
  _meta_type TEXT NOT NULL,

  -- All child fields in JSONB column
  _meta_data JSONB,

  UNIQUE(slug, context)
);

CREATE INDEX idx_events_meta_type ON events(_meta_type);
```

### Inheritance Rules

**Strategy inheritance**:
- Child with `@smrt()` (no config) → Inherits parent's strategy ✅
- Child with `@smrt({ tableStrategy: 'sti' })` → Explicit STI ✅
- Child with `@smrt({ tableStrategy: 'cti' })` → Error! Cannot override ❌

**Validation**:
```typescript
// ✅ CORRECT - Child inherits STI
@smrt({ tableStrategy: 'sti' })
class Event extends SmrtObject {
  title: string = '';
}

@smrt()  // Inherits 'sti' from Event
class Meeting extends Event {
  roomNumber: string = '';
}

// ❌ WRONG - Explicit CTI conflicts with parent's STI
@smrt({ tableStrategy: 'sti' })
class Event extends SmrtObject {
  title: string = '';
}

@smrt({ tableStrategy: 'cti' })  // Throws ConfigurationError!
class Meeting extends Event {
  roomNumber: string = '';
}
```

### Polymorphic Queries

Query the base class to get mixed instances of all subtypes:

```typescript
const collection = await EventCollection.create({
  persistence: { type: 'sql', url: 'events.db' }
});

// Create different event types
const meeting = await collection.create({
  _meta_type: 'Meeting',
  title: 'Team Standup',
  date: new Date(),
  location: 'Conference Room A',
  roomNumber: '101',
  attendees: ['Alice', 'Bob']
});

const concert = await collection.create({
  _meta_type: 'Concert',
  title: 'Summer Music Festival',
  date: new Date(),
  location: 'City Park',
  artist: 'The Band',
  genre: 'Rock'
});

// Polymorphic query returns mixed types!
const allEvents = await collection.list({
  orderBy: 'date ASC'
});

// Each instance is the correct subclass
for (const event of allEvents) {
  console.log(event.constructor.name); // "Meeting", "Concert", etc.

  if (event instanceof Meeting) {
    console.log(`Room: ${event.roomNumber}`);
  } else if (event instanceof Concert) {
    console.log(`Artist: ${event.artist}`);
  }
}

// Filter by type
const meetings = await collection.list({
  where: { _meta_type: 'Meeting' }
});
```

### Meta Fields Storage

**Base class fields**: Stored as regular columns in the table
**Child-specific fields**: Stored in `_meta_data` JSONB column

```typescript
// Database row for Meeting:
{
  id: 'uuid-123',
  title: 'Team Standup',        // Base field → column
  date: '2024-01-15',            // Base field → column
  location: 'Conference Room A', // Base field → column
  _meta_type: 'Meeting',         // Discriminator
  _meta_data: {                  // Child fields → JSONB
    roomNumber: '101',
    attendees: ['Alice', 'Bob']
  }
}
```

**Automatic serialization/deserialization**:
- `save()`: Extracts child fields into `_meta_data`
- Load: Merges `_meta_data` back into object instance

### Registry Methods

Query STI hierarchy metadata:

```typescript
import { ObjectRegistry } from '@happyvertical/smrt-core';

// Get table strategy for a class
ObjectRegistry.getTableStrategy('Event');     // 'sti'
ObjectRegistry.getTableStrategy('Meeting');   // 'sti' (inherited)

// Get STI base class
ObjectRegistry.getSTIBase('Event');    // 'Event' (self)
ObjectRegistry.getSTIBase('Meeting');  // 'Event' (parent)

// Get all descendants
ObjectRegistry.getDescendants('Event');
// ['Meeting', 'Conference', 'Concert']

// Build inheritance chain
ObjectRegistry.getInheritanceChain('Meeting');
// ['Event', 'Meeting']
```

### Error Handling

STI implementation includes comprehensive error handling:

**Circular inheritance detection**:
```typescript
// Throws ConfigurationError.circularInheritance()
@smrt({ tableStrategy: 'sti' })
class A extends SmrtObject { }

@smrt()
class B extends A { }

@smrt()
class C extends B { }

// If somehow C extends A again → Error!
```

**Strategy compatibility validation**:
```typescript
// Throws ConfigurationError.incompatibleStrategy()
@smrt({ tableStrategy: 'sti' })
class Event extends SmrtObject { }

@smrt({ tableStrategy: 'cti' })  // Error: Cannot override parent's strategy
class Meeting extends Event { }
```

**Missing discriminator**:
```typescript
// Throws DatabaseError.missingDiscriminator()
const row = { id: '123', title: 'Event', _meta_type: null };
await collection.createPolymorphic(row._meta_type, row);
// Error: Cannot determine subclass without discriminator
```

**Corrupted meta data**:
```typescript
// Throws DatabaseError.corruptedData()
const row = { id: '123', _meta_data: '{invalid json' };
// Error: Cannot parse _meta_data JSONB
```

**Unregistered base class**:
```typescript
// Throws ConfigurationError.unregisteredBaseClass()
@smrt({ tableStrategy: 'sti' })
class Meeting extends Event { }  // Event not decorated yet
// Error: Base class must be registered first
```

### Best Practices

**1. Keep child-specific fields minimal**
```typescript
// ✅ GOOD - Few child-specific fields
@smrt({ tableStrategy: 'sti' })
class Event extends SmrtObject {
  title: string = '';
  date: Date = new Date();
  location: string = '';
  // 3 base fields
}

@smrt()
class Meeting extends Event {
  roomNumber: string = '';
  // 1 child field
}

// ❌ BAD - Too many child-specific fields
@smrt()
class Conference extends Event {
  sponsorName: string = '';
  ticketPrice: number = 0.0;
  venueCapacity: number = 0;
  registrationUrl: string = '';
  speakerBios: string = '';
  sessionTracks: string[] = [];
  // 6+ child fields → consider CTI instead
}
```

**2. Use type guards for subclass access**
```typescript
const events = await collection.list();

for (const event of events) {
  // ✅ GOOD - Type guards
  if (event instanceof Meeting) {
    console.log(event.roomNumber);  // Type-safe!
  }

  // ❌ BAD - Unsafe casting
  const meeting = event as Meeting;
  console.log(meeting.roomNumber);  // May be undefined!
}
```

**3. Always specify _meta_type when creating**
```typescript
// ✅ GOOD - Explicit type
const meeting = await collection.create({
  _meta_type: 'Meeting',
  title: 'Standup',
  roomNumber: '101'
});

// ❌ BAD - Missing type (defaults to base class)
const event = await collection.create({
  title: 'Standup',
  roomNumber: '101'  // Will be ignored!
});
```

**4. Index discriminator column**
```typescript
// Already done automatically by schema generator
CREATE INDEX idx_events_meta_type ON events(_meta_type);
```

**5. Avoid deep hierarchies (prefer 2 levels)**
```typescript
// ✅ GOOD - Two levels
Event
├── Meeting
├── Conference
└── Concert

// ⚠️ AVOID - Three+ levels
Event
└── CorporateEvent
    ├── Meeting
    ├── Training
    └── TeamBuilding
```

### Multi-Level STI Inheritance

SMRT supports multi-level STI hierarchies:

```typescript
@smrt({ tableStrategy: 'sti' })
class Event extends SmrtObject {
  title: string = '';
}

@smrt()  // Inherits STI
class SportingEvent extends Event {
  sport: string = '';
}

@smrt()  // Inherits STI through SportingEvent
class HockeyGame extends SportingEvent {
  homeTeam: string = '';
  awayTeam: string = '';
}

// All three classes share the 'events' table
ObjectRegistry.getSTIBase('Event');         // 'Event'
ObjectRegistry.getSTIBase('SportingEvent'); // 'Event'
ObjectRegistry.getSTIBase('HockeyGame');    // 'Event'

ObjectRegistry.getDescendants('Event');
// ['SportingEvent', 'HockeyGame']
```

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

### Custom Method Discovery

**New in v0.6+**: All code generators (CLI, API, MCP) automatically discover custom methods from your SMRT objects!

#### How It Works

1. **Define custom methods** on your SMRT class
2. **Include them** in the `@smrt()` decorator config
3. **Generated automatically** as CLI commands, API endpoints, or MCP tools

#### Example

```typescript
@smrt({
  cli: { include: ['list', 'get', 'research', 'report'] },
  api: { include: ['list', 'get', 'research'] },
  mcp: { include: ['list', 'get', 'research', 'analyze'] }
})
class Agent extends SmrtObject {
  name: string = '';
  source: string = '';

  /**
   * Research a topic using AI
   */
  async research(options: { query: string, depth?: number }) {
    return {
      action: 'research',
      query: options.query,
      depth: options.depth || 3,
      results: await this.do(`Research: ${options.query}`)
    };
  }

  /**
   * Generate a report
   */
  async report(options: { type?: string }) {
    return {
      action: 'report',
      type: options.type || 'summary',
      content: await this.do(`Generate ${options.type} report`)
    };
  }

  /**
   * Analyze data (MCP only - not in CLI/API)
   */
  async analyze(options: any = {}) {
    return {
      action: 'analyze',
      results: await this.is('Data is comprehensive and accurate')
    };
  }
}
```

#### Generated Output

**CLI Commands:**
```bash
smrt agent:list
smrt agent:get <id>
smrt agent:research <id> --query "AI safety" --depth 5
smrt agent:report <id> --type detailed
```

**REST API Endpoints:**
```
GET    /agents
GET    /agents/:id
POST   /agents/:id/research
```

**MCP Tools:**
```json
{
  "tools": [
    { "name": "agent_list", "description": "List Agent objects" },
    { "name": "agent_get", "description": "Get Agent by ID" },
    { "name": "agent_research", "description": "Research a topic using AI" },
    { "name": "agent_analyze", "description": "Analyze data" }
  ]
}
```

#### ObjectRegistry.getMethods()

Access method metadata programmatically:

```typescript
import { ObjectRegistry } from '@happyvertical/smrt-core';

// Get all methods for a class
const methods = ObjectRegistry.getMethods('Agent');

for (const [name, methodDef] of methods) {
  console.log(`Method: ${name}`);
  console.log(`  Async: ${methodDef.async}`);
  console.log(`  Public: ${methodDef.isPublic}`);
  console.log(`  Return type: ${methodDef.returnType}`);
  console.log(`  Parameters:`, methodDef.parameters);
}

// Output:
// Method: research
//   Async: true
//   Public: true
//   Return type: Promise<any>
//   Parameters: [{ name: 'options', type: 'any', optional: true }]
```

#### Parameter Mapping

CLI generator automatically converts between naming conventions:

- **Method → CLI**: `researchQuery` → `--research-query`
- **CLI → Method**: `--research-query` → `researchQuery`

**Example:**
```typescript
async research(options: { researchQuery: string, maxResults?: number }) {
  // Implementation
}
```

**Generated CLI:**
```bash
smrt agent:research <id> --research-query "AI" --max-results 10
```

#### Method Filtering

Control which methods are exposed:

```typescript
@smrt({
  cli: {
    include: ['list', 'get', 'research'],  // Only these methods
    exclude: ['internalMethod']             // Explicitly excluded
  }
})
class Agent extends SmrtObject {
  async research(options: any) { /* ... */ }      // ✅ Included
  async report(options: any) { /* ... */ }        // ❌ Not in include list
  private async internalMethod() { /* ... */ }    // ❌ Private (auto-excluded)
}
```

**Rules:**
- Only **public methods** are discoverable (private/protected auto-excluded)
- `include` list is whitelist (if present, only listed methods are exposed)
- `exclude` list is blacklist (removes methods even if in include list)
- Works the same for CLI, API, and MCP configs

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
