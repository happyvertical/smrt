# SMRT Framework

<p align="center">
  <img src="./smrt-homer.png" alt="SMRT Framework" width="400" />
</p>

**A TypeScript framework for building vertical AI agents with automatic code generation, database persistence, and AI-powered operations.**

## Features

- 🤖 **AI-First Design**: Built-in `do()` and `is()` methods for intelligent operations
- 🗄️ **Automatic ORM**: Database schema generation from TypeScript classes
- 🔧 **Code Generation**: Auto-generate CLIs, REST APIs, and MCP servers
- 🔌 **Vite Plugin**: Seamless development with virtual modules
- 📦 **Self-Contained**: All core dependencies bundled
- 🎯 **Type-Safe**: Full TypeScript support across all interfaces

## Quick Start

```bash
# Install
npm install @smrt/core

# Or with pnpm
pnpm add @smrt/core
```

## Basic Usage

### TypeScript-First Development

SMRT uses TypeScript types for automatic schema generation, with decorators only when needed:

```typescript
import { SmrtObject, SmrtCollection, smrt } from '@smrt/core';
import { foreignKey } from '@smrt/core/fields'; // Only for relationships

// Define your domain object with TypeScript types
@smrt({
  api: true,      // Auto-generate REST API
  mcp: true,      // Auto-generate MCP tools for AI
  cli: true       // Auto-generate CLI commands
})
class Product extends SmrtObject {
  // TypeScript types → automatic schema generation
  name: string = '';              // → TEXT column
  description: string = '';       // → TEXT column
  price: number = 0.0;           // → DECIMAL (has decimal point)
  quantity: number = 0;          // → INTEGER (no decimal point)
  active: boolean = true;        // → BOOLEAN column
  tags: string[] = [];           // → JSON column
  launchedAt: Date = new Date(); // → DATETIME column

  // Use field helpers only for relationships
  categoryId = foreignKey(Category);

  // Custom AI-powered methods
  async analyze() {
    return await this.do('Analyze this product and suggest improvements');
  }

  async isQuality() {
    return await this.is('Product has high quality description and competitive pricing');
  }
}

// Collection for managing products
class ProductCollection extends SmrtCollection<Product> {
  static readonly _itemClass = Product; // Required for collections
}

// Use the collection
const products = await ProductCollection.create({
  persistence: { type: 'sql', url: 'products.db' },
  ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
});

// Create and save
const product = await products.create({
  name: 'Smart Widget',
  description: 'An innovative widget for modern homes',
  price: 29.99,
  quantity: 100,
  active: true
});

await product.save();

// AI-powered operations
const isValid = await product.isQuality();
const analysis = await product.analyze();

// Query with filters
const activeProducts = await products.list({
  where: {
    active: true,
    'price <': 50,
    'quantity >': 0
  },
  orderBy: 'price ASC',
  limit: 10
});
```

### The 0 vs 0.0 Heuristic

SMRT automatically determines column types from TypeScript number literals:

```typescript
class Inventory extends SmrtObject {
  // INTEGER columns (no decimal point)
  count: number = 0;        // → INTEGER
  quantity: number = 42;    // → INTEGER
  items: number = 100;     // → INTEGER

  // DECIMAL columns (has decimal point)
  price: number = 0.0;      // → DECIMAL
  discount: number = 0.95;  // → DECIMAL
  tax: number = 8.5;        // → DECIMAL
}
```

### When to Use Field Decorators

Field decorators are only needed for specific cases:

```typescript
import { text, decimal, foreignKey, oneToMany } from '@smrt/core/fields';

class Order extends SmrtObject {
  // TypeScript types for most fields
  orderNumber: string = '';
  total: number = 0.0;

  // Use decorators for:
  // 1. Relationships
  customerId = foreignKey(Customer);
  items = oneToMany(OrderItem);

  // 2. Constraints and validation
  email = text({
    required: true,
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  });

  // 3. Nullable decimals (can't infer from TypeScript)
  discount = decimal({ nullable: true });
}
```

## Single Table Inheritance (STI)

SMRT supports Single Table Inheritance where multiple related classes share the same database table:

```typescript
import { SmrtObject, smrt } from '@smrt/core';

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
class Concert extends Event {
  artist: string = '';
  ticketPrice: number = 0.0;
  genre: string = '';
}

// All classes share the 'events' table
// Child-specific fields stored in JSONB _meta_data column
const eventCollection = await EventCollection.create(options);

// Create different types
const meeting = await eventCollection.create({
  _meta_type: 'Meeting',
  title: 'Team Standup',
  roomNumber: '101',
  attendees: ['Alice', 'Bob']
});

const concert = await eventCollection.create({
  _meta_type: 'Concert',
  title: 'Summer Festival',
  artist: 'The Band',
  ticketPrice: 49.99
});

// Polymorphic queries return mixed types
const allEvents = await eventCollection.list();
for (const event of allEvents) {
  if (event instanceof Meeting) {
    console.log(`Room: ${event.roomNumber}`);
  } else if (event instanceof Concert) {
    console.log(`Artist: ${event.artist}`);
  }
}
```

### Multi-Level Inheritance

SMRT supports deep inheritance hierarchies with proper field and method inheritance:

```typescript
// Level 1: Base content
@smrt()
class Content extends SmrtObject {
  title: string = '';
  body: string = '';

  async generateSummary() {
    return await this.do('Summarize in 2 sentences');
  }
}

// Level 2: News content extends Content
@smrt()
class NewsContent extends Content {
  sourceUrl: string = '';
  journalist: string = '';

  async analyzeCredibility() {
    return await this.is('Source is credible and factual');
  }
}

// Level 3: Local news extends NewsContent
@smrt()
class LocalNews extends NewsContent {
  localArea: string = '';
  communityImpact: number = 0;  // 0-10 scale

  async assessLocalRelevance() {
    return await this.do('Assess relevance to local community');
  }
}

// LocalNews has ALL fields and methods from ancestors
const article = new LocalNews({
  title: 'Town Hall Renovation',        // From Content
  body: 'The town hall...',             // From Content
  sourceUrl: 'https://local.news',      // From NewsContent
  journalist: 'Jane Smith',             // From NewsContent
  localArea: 'Downtown',                // From LocalNews
  communityImpact: 8                    // From LocalNews
});

// Call methods from any level
const summary = await article.generateSummary();      // From Content
const credible = await article.analyzeCredibility();  // From NewsContent
const relevance = await article.assessLocalRelevance(); // From LocalNews
```

## Code Generation

### CLI Generation

```typescript
import { CLIGenerator } from '@smrt/core/generators';

const generator = new CLIGenerator({
  collections: [ProductCollection]
});

await generator.generate();
// Creates: products-cli.js with full CRUD operations
```

### REST API Generation

```typescript
import { APIGenerator } from '@smrt/core/generators';

const generator = new APIGenerator({
  collections: [ProductCollection],
  includeSwagger: true
});

await generator.generate();
// Creates: REST endpoints with OpenAPI docs
```

### MCP Server Generation

```typescript
import { MCPGenerator } from '@smrt/core/generators';

const generator = new MCPGenerator({
  collections: [ProductCollection]
});

await generator.generate();
// Creates: MCP server for AI integration
```

## Vite Plugin

```typescript
// vite.config.js
import { smrtPlugin } from '@smrt/core/vite-plugin';

export default {
  plugins: [
    smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: true
    })
  ]
};

// Auto-generated virtual modules:
import { setupRoutes } from '@smrt/routes';
import { createClient } from '@smrt/client';
import { tools } from '@smrt/mcp';
```

## Packages

### Core SMRT Framework (`@smrt/*`)

- `@smrt/core` - Core framework with ORM, code generation, and AI integration
- `@smrt/types` - Shared TypeScript type definitions
- `@smrt/cli` - Developer CLI for introspection, testing, and project management

### Domain Modules (`@smrt/*`)

- `@smrt/accounts` - Accounting ledger with multi-currency support
- `@smrt/agents` - Agent framework for autonomous actors
- `@smrt/assets` - Asset management with versioning and metadata
- `@smrt/content` - Content processing (documents, PDFs, web content)
- `@smrt/events` - Event management with participants and hierarchies
- `@smrt/gnode` - Federation library for local knowledge bases
- `@smrt/places` - Place management with geo integration
- `@smrt/products` - Product catalog and microservice template
- `@smrt/profiles` - Profile management with relationships
- `@smrt/tags` - Hierarchical tagging system

### SDK Infrastructure (`@have/*`)

External dependencies provided by the HAppyVertical SDK:

- `@have/ai` - Multi-provider AI client (OpenAI, Anthropic, Google, AWS)
- `@have/files` - File system operations and utilities
- `@have/sql` - Database operations (SQLite, Postgres, DuckDB)
- `@have/utils` - Shared utility functions
- `@have/logger` - Logging infrastructure

## Documentation

- [Architecture Guide](./CLAUDE.md) - Development guide and patterns
- [Core Framework Docs](./packages/core/CLAUDE.md) - Detailed framework documentation
- [API Reference](./packages/core/README.md) - Complete API reference

## Requirements

- Node.js 24+
- pnpm 9.0+
- TypeScript 5.7+

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
npm run build

# Run tests
npm test

# Watch mode
npm run dev

# Lint
npm run lint

# Format
npm run format
```

### Local SDK Development

To develop SMRT framework alongside SDK packages, use the provided setup scripts:

```bash
# Link local SDK packages for development
./setup-local-dev.sh

# Restore published SDK packages from GitHub Package Registry
./restore-published-deps.sh
```

**Requirements:**
- Clone the SDK repository: `git clone git@github.com:happyvertical/sdk.git ../sdk`
- Or set a custom path: `export SDK_PATH=/path/to/sdk`

The setup script will:
1. Build SDK packages from your local SDK repository
2. Link SDK packages globally using `pnpm link`
3. Link them into all SMRT packages that depend on SDK packages
4. Enable hot-reload: changes to SDK packages are reflected immediately

**Note:** The restore script runs `pnpm install --force` to reinstall packages from the registry.

### Git Hooks

This project uses [Lefthook](https://lefthook.dev/) to enforce commit message standards:

- **Automatic Installation**: Lefthook is automatically installed when you run `pnpm install` (via the `prepare` script)
- **Commit Message Validation**: All commits must follow [Conventional Commits](https://www.conventionalcommits.org/) format
- **Local Enforcement**: Validation happens immediately during `git commit`, providing instant feedback

**Commit Message Format:**
```
<type>(<scope>): <subject>

<body>

<footer>
```

**Valid Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

**Example:**
```bash
git commit -m "feat(core): add eager loading support for relationships"
```

If your commit message doesn't follow this format, the hook will reject it with helpful guidance.

## Related Projects

- [HAppyVertical SDK](https://github.com/happyvertical/sdk) - Infrastructure packages
- [create-gnode](https://github.com/happyvertical/create-gnode) - Generate local knowledge bases
- [praeco](https://github.com/happyvertical/praeco) - Local news agent

## History

SMRT was split from the HAppyVertical SDK in October 2024 to create a focused, self-contained framework for building vertical AI agents.

## License

MIT - see [LICENSE](./LICENSE) file for details

## Contributing

See [CLAUDE.md](./CLAUDE.md) for development guidelines.

## Support

- [GitHub Issues](https://github.com/happyvertical/smrt/issues)
- [GitHub Discussions](https://github.com/happyvertical/smrt/discussions)

---

Built with ❤️ by [HappyVertical](https://github.com/happyvertical)
