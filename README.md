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

```typescript
import { SmrtObject, SmrtCollection, smrt } from '@smrt/core';
import { text, decimal, boolean } from '@smrt/core/fields';

// Define your domain object
@smrt({
  api: true,      // Auto-generate REST API
  mcp: true,      // Auto-generate MCP tools for AI
  cli: true       // Auto-generate CLI commands
})
class Product extends SmrtObject {
  name = text({ required: true });
  price = decimal({ min: 0 });
  active = boolean({ default: true });

  // Custom AI-powered methods
  async analyze() {
    return await this.do('Analyze this product and suggest improvements');
  }
}

// Use the collection
const products = await ProductCollection.create({
  persistence: { type: 'sql', url: 'products.db' },
  ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
});

// Create and query
const product = await products.create({
  name: 'Widget',
  price: 29.99
});

await product.save();

// AI-powered validation
const isValid = await product.is('Product has competitive pricing');

// List with filters
const active = await products.list({
  where: { active: true, 'price <': 50 },
  limit: 10
});
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
