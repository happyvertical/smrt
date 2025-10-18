# SMRT Framework

**SMRT** is a TypeScript framework for building vertical AI agents with built-in code generation, database persistence, and AI-powered operations.

## Core Philosophy

- **Define Once**: Use the `@smrt()` decorator to define business logic once
- **Generate Everything**: Automatically create REST APIs, AI tools (MCP), and CLI commands
- **AI-First**: Built-in intelligent operations with `do()`, `is()`, and `describe()` methods
- **Type-Safe**: Full TypeScript support with automatic type inference
- **Database Agnostic**: Works with SQLite, Postgres, and DuckDB

## Quick Start

### Installation

```bash
npm install @smrt/core @smrt/types
```

### Create Your First SMRT Object

```typescript
import { SmrtObject } from '@smrt/core';

// No decorator needed - it's optional
class Task extends SmrtObject {
  title = '';
  priority = 0;
  completed = false;
}
```

That's it! You now have:
- ✅ REST API endpoints: `POST /tasks`, `GET /tasks`, `GET /tasks/:id`, `PUT /tasks/:id`, `DELETE /tasks/:id`
- ✅ CLI commands: `task create`, `task list`, `task update`, `task delete`
- ✅ MCP tools for AI agents to create, read, update, and list tasks
- ✅ Database schema with automatic migrations
- ✅ Type-safe operations throughout

## Key Features

### Automatic Code Generation

The `@smrt()` decorator analyzes your class and automatically generates:

- **REST API**: Full CRUD endpoints with OpenAPI documentation
- **CLI Commands**: Interactive command-line interface
- **MCP Tools**: Model Context Protocol tools for AI integration
- **Database Schema**: Automatic schema generation and migrations

### AI-Powered Methods

Built-in AI methods enable intelligent operations:

```typescript
// Natural language instructions
await task.do('mark as completed');
await task.do('set priority to high');

// Natural language queries
const isUrgent = await task.is('urgent');
const isOverdue = await task.is('past its due date');

// Generate descriptions
const summary = await task.describe();
```

### Database Persistence

Extend `SmrtObject` for automatic database integration:

```typescript
// Create
const task = await Task.create({ title: 'Build docs site' });

// Read
const found = await Task.findById(task.id);

// Update
await task.update({ completed: true });

// Delete
await task.delete();

// Query
const highPriority = await Task.collection.find({
  where: { priority: { $gte: 8 } }
});
```

### Collections

Work with multiple objects using `SmrtCollection`:

```typescript
const tasks = Task.collection;

// Batch operations
await tasks.createMany([
  { title: 'Task 1' },
  { title: 'Task 2' }
]);

// Complex queries
const results = await tasks.find({
  where: {
    completed: false,
    priority: { $gte: 5 }
  },
  orderBy: { priority: 'desc' },
  limit: 10
});

// Aggregations
const stats = await tasks.aggregate({
  _count: true,
  _avg: ['priority']
});
```

## Architecture

### Package Structure

The SMRT framework is organized into focused packages:

- **[@smrt/core](/core)**: Core framework with ORM, code generation, and AI integration
- **[@smrt/types](/types)**: Shared TypeScript type definitions
- **[@smrt/accounts](/accounts)**: Accounting ledger with multi-currency support
- **[@smrt/agents](/agents)**: Agent framework for autonomous actors
- **[@smrt/assets](/assets)**: Asset management with versioning
- **[@smrt/content](/content)**: Content processing (documents, PDFs, web)
- **[@smrt/events](/events)**: Event management with hierarchies
- **[@smrt/gnode](/gnode)**: Federation library for knowledge bases
- **[@smrt/places](/places)**: Place management with geo integration
- **[@smrt/products](/products)**: Product catalog and templates
- **[@smrt/profiles](/profiles)**: Profile management with relationships
- **[@smrt/tags](/tags)**: Hierarchical tagging system

### External Dependencies

SMRT depends on infrastructure packages from the [HappyVertical SDK](https://happyvertical.github.io/sdk/):

- **[@have/ai](https://happyvertical.github.io/sdk/ai)**: Multi-provider AI client
- **[@have/files](https://happyvertical.github.io/sdk/files)**: File system operations
- **[@have/sql](https://happyvertical.github.io/sdk/sql)**: Database operations
- **[@have/utils](https://happyvertical.github.io/sdk/utils)**: Shared utilities
- **[@have/logger](https://happyvertical.github.io/sdk/logger)**: Logging infrastructure

## Use Cases

### Vertical AI Agents

Build specialized AI agents for specific domains:

```typescript
@smrt({ api: true, cli: true, mcp: true })
class LocalNews extends SmrtObject {
  title = TextField();
  content = TextField();
  source = TextField();
  publishedAt = DateTimeField();

  async do(instruction: string) {
    // AI can summarize, analyze sentiment, extract entities, etc.
    return super.do(instruction);
  }
}
```

### Data Management Applications

Create type-safe data applications with automatic APIs:

```typescript
@smrt({ api: { include: ['read', 'list'] }, cli: true })
class Product extends SmrtObject {
  name = TextField({ required: true });
  sku = TextField({ unique: true });
  price = DecimalField();
  inventory = IntegerField({ default: 0 });
}
```

### Knowledge Bases

Build federated knowledge bases with gnode:

```typescript
import { Gnode } from '@smrt/gnode';

const gnode = new Gnode({
  name: 'my-knowledge-base',
  federation: { enabled: true }
});

await gnode.index(documents);
await gnode.search('query');
```

## Development

### Requirements

- Node.js 24+
- pnpm 9.0+
- TypeScript 5.7+

### Getting Started

```bash
# Clone the repository
git clone https://github.com/happyvertical/smrt.git
cd smrt

# Install dependencies
pnpm install

# Build packages
pnpm run build

# Run tests
pnpm test
```

### Project Structure

```
smrt/
├── packages/
│   ├── types/          # Shared type definitions
│   ├── core/           # Core framework
│   ├── accounts/       # Accounting domain
│   ├── agents/         # Agent framework
│   ├── assets/         # Asset management
│   ├── content/        # Content processing
│   ├── events/         # Event management
│   ├── gnode/          # Federation library
│   ├── places/         # Place management
│   ├── products/       # Product catalog
│   ├── profiles/       # Profile management
│   └── tags/           # Tagging system
├── docs/               # Documentation site
└── examples/           # Example applications
```

## Contributing

We welcome contributions! See [Contributing](/contributing) for guidelines.

## License

MIT License - see [License](/license) for details.

## Community

- **GitHub**: [https://github.com/happyvertical/smrt](https://github.com/happyvertical/smrt)
- **Issues**: [https://github.com/happyvertical/smrt/issues](https://github.com/happyvertical/smrt/issues)
- **Discussions**: [https://github.com/happyvertical/smrt/discussions](https://github.com/happyvertical/smrt/discussions)
- **Organization**: [https://github.com/happyvertical](https://github.com/happyvertical)

## Related Projects

- **[HappyVertical SDK](https://happyvertical.github.io/sdk/)**: Infrastructure packages for AI agents
- **[create-gnode](https://github.com/happyvertical/create-gnode)**: CLI for creating federated knowledge bases
- **[praeco](https://github.com/happyvertical/praeco)**: Local news agent built on SMRT

---

*SMRT was split from the HappyVertical SDK in October 2024 to create a focused, self-contained framework for building vertical AI agents.*
