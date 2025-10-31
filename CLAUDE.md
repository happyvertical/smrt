# SMRT Framework: Architecture and Development Guide

## What is SMRT?

SMRT (Smart, Multi-modal, Real-time Transformation) is a TypeScript framework for building vertical AI agents with automatic code generation and AI-powered operations.

### Core Value Proposition

**Define business logic once, get everything else automatically:**
- Define TypeScript classes with properties
- Get REST APIs, CLI tools, and AI integration (MCP servers) automatically
- Built-in AI operations (`is()`, `do()` methods) on every object
- Database persistence with automatic schema generation
- Type-safe operations across all interfaces

### Design Philosophy

- **TypeScript-First**: Use native TypeScript types; field helpers only when needed
- **AI-Powered**: Built-in intelligent operations on every object
- **Code Generation**: APIs, CLIs, MCP servers generated automatically
- **Self-Contained**: Minimal external dependencies, focused framework
- **Developer Experience**: IntelliSense, type safety, hot reload

### When to Use SMRT

✅ **Perfect for:**
- Vertical AI agents (local news, research, content processing)
- Domain-specific applications with AI operations
- Rapid prototyping of AI-powered services
- Applications needing APIs, CLIs, and AI integration

❌ **Not ideal for:**
- Generic web frameworks (use SvelteKit, Next.js, etc.)
- Pure data processing without AI
- Applications requiring custom ORM behavior

---

## Quick Start

### Installation

```bash
# Install SMRT framework
npm install @happyvertical/smrt-core

# Or with pnpm
pnpm add @happyvertical/smrt-core
```

### Define Your First SMRT Object

Use TypeScript types for automatic schema generation:

```typescript
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { foreignKey } from '@happyvertical/smrt-core/fields';

@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'analyze'] },
  cli: true
})
class Document extends SmrtObject {
  // TypeScript types → automatic schema generation
  title: string = '';
  content: string = '';
  wordCount: number = 0;        // → INTEGER (no decimal point)
  rating: number = 0.0;          // → DECIMAL (has decimal point)
  isPublished: boolean = false;
  publishedAt: Date = new Date();
  tags: string[] = [];

  // Field helpers for relationships and constraints
  categoryId = foreignKey(Category);

  constructor(options: any = {}) {
    super(options);
    Object.assign(this, options);
  }

  // AI-powered validation
  async isHighQuality(): Promise<boolean> {
    return await this.is(`
      - Contains more than 500 words
      - Has clear structure
      - Uses professional language
    `);
  }

  // AI-powered transformation
  async generateSummary(): Promise<string> {
    return await this.do(`
      Create a 2-sentence summary of this document.
      Focus on key points and conclusions.
    `);
  }
}
```

### Create and Use Collections

```typescript
import { SmrtCollection } from '@happyvertical/smrt-core';

class DocumentCollection extends SmrtCollection<Document> {
  static readonly _itemClass = Document;
}

// Create collection instance
const documents = await DocumentCollection.create({
  persistence: { type: 'sql', url: 'documents.db' },
  ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
});

// Create and save a document
const doc = await documents.create({
  title: 'Getting Started with SMRT',
  content: 'SMRT makes building AI agents simple...',
  wordCount: 1250,
  rating: 4.5
});
await doc.save();

// Query with advanced filters
const recentDocs = await documents.list({
  where: {
    'wordCount >': 1000,
    'publishedAt >': '2024-01-01'
  },
  orderBy: 'rating DESC',
  limit: 10
});

// Use AI-powered operations
const isQuality = await doc.isHighQuality();
const summary = await doc.generateSummary();
```

### Generate APIs, CLI, and MCP

The `@smrt()` decorator automatically configures code generation:

```typescript
// REST API endpoints generated:
// GET    /documents
// GET    /documents/:id
// POST   /documents
// PUT    /documents/:id

// CLI commands generated:
// smrt documents list
// smrt documents get <id>
// smrt documents create --title "..." --content "..."

// MCP tools generated (for AI integration):
// document_list, document_get, document_analyze
```

### Next Steps

- **Deep Dive**: [packages/core/CLAUDE.md](./packages/core/CLAUDE.md) - Comprehensive technical reference
- **API Reference**: [packages/core/README.md](./packages/core/README.md) - Complete API documentation
- **Contributing**: [CONTRIBUTING.md](./CONTRIBUTING.md) - How to contribute
- **Workflow**: [WORKFLOW.md](./WORKFLOW.md) - Development SOPs

---

## TypeScript Types vs Field Helpers

SMRT supports TypeScript-first development with automatic type inference.

### TypeScript Types (Primary Pattern)

Use TypeScript types for most properties - the AST scanner automatically generates database schema:

```typescript
class Product extends SmrtObject {
  // String → TEXT
  name: string = '';
  description: string = '';

  // Numbers with 0 vs 0.0 heuristic
  quantity: number = 0;      // → INTEGER (no decimal point)
  price: number = 0.0;       // → DECIMAL (has decimal point)
  rating: number = 4.5;      // → DECIMAL (has decimal point)

  // Boolean → BOOLEAN
  active: boolean = true;

  // Date → DATETIME
  created: Date = new Date();

  // Arrays → JSON
  tags: string[] = [];
  metadata: Record<string, any> = {};
}
```

### The 0 vs 0.0 Heuristic

Numeric literals **without** decimal point → INTEGER:
- `count: number = 0` → INTEGER
- `quantity: number = 42` → INTEGER

Numeric literals **with** decimal point → DECIMAL:
- `price: number = 0.0` → DECIMAL
- `rating: number = 4.5` → DECIMAL

This semantic distinction enables proper database schema generation without field helpers.

### When to Use Field Helpers

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

  email = text({
    required: true,
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  });
}
```

#### 3. Nullable Decimals
```typescript
class Place extends SmrtObject {
  // Optional decimal needs explicit helper
  latitude = decimal({ nullable: true });
  longitude = decimal({ nullable: true });
}
```

### Decision Tree

```
Do you need to define a property?
│
├─ Is it a relationship?
│  └─ YES → Use field helper: foreignKey(), oneToMany(), manyToMany()
│
├─ Do you need constraints (required, unique, min, max, pattern)?
│  └─ YES → Use field helper: text({ required: true }), integer({ min: 0 })
│
├─ Is it an optional decimal number?
│  └─ YES → Use field helper: decimal({ nullable: true })
│
└─ NO → Use TypeScript types:
   - Strings: name: string = ''
   - Integers: count: number = 0
   - Decimals: price: number = 0.0
   - Booleans: active: boolean = true
   - Dates: created: Date = new Date()
```

For complete documentation, see [packages/core/CLAUDE.md#typescript-types-vs-field-helpers](./packages/core/CLAUDE.md#typescript-types-vs-field-helpers).

---

## Monorepo Structure

The SMRT framework is organized as a pnpm workspace:

### Core Framework Packages

**Foundation:**
- **types**: Shared TypeScript type definitions
- **config**: Configuration management with cosmiconfig
- **core**: Core framework with ORM, code generation, and AI integration

**Domain Modules:**
- **accounts**: Accounting ledger with multi-currency support
- **agents**: Agent framework for autonomous actors
- **assets**: Asset management with versioning and metadata
- **content**: Content processing (documents, PDFs, web)
- **events**: Event management with participants and hierarchies
- **gnode**: Federation library for local knowledge bases
- **places**: Place management with geo integration
- **products**: Product catalog and microservice template
- **profiles**: Profile management with relationships
- **tags**: Hierarchical tagging system

### External SDK Dependencies

Infrastructure packages from [@happyvertical/sdk](https://github.com/happyvertical/sdk):
- **@happyvertical/ai**: Multi-provider AI client (OpenAI, Anthropic, Google, AWS)
- **@happyvertical/files**: File system operations
- **@happyvertical/sql**: Database operations (SQLite, Postgres, DuckDB)
- **@happyvertical/utils**: Shared utilities
- **@happyvertical/logger**: Logging infrastructure

### Package Dependencies

**Within SMRT framework:**
- `@happyvertical/smrt-types`: No internal dependencies
- `@happyvertical/smrt-config`: No internal dependencies
- `@happyvertical/smrt-core`: Depends on types, config, and external SDK packages
- Domain modules: All depend on core; some have cross-dependencies

**Build order** (managed by Turborepo):
1. types, config (parallel)
2. core (depends on types + config)
3. Domain modules (depend on core)

---

## Development Setup

### Prerequisites

- **Node.js**: 24+ required
- **pnpm**: 9.0+ required
- **TypeScript**: Configured with strict type checking

### Installation

```bash
# Clone the repository
git clone https://github.com/happyvertical/smrt.git
cd smrt

# Install dependencies
pnpm install

# Build all packages (Turborepo with caching)
npm run build
# First run: ~8s, cached runs: ~80ms
```

### Common Commands

```bash
# Development mode with watch
npm run dev

# Run tests
npm test
npm run test:watch

# Type checking
npm run typecheck

# Linting and formatting
npm run lint
npm run lint:fix
npm run format
npm run format-check

# Clean build artifacts
npm run clean
```

### Build System

The framework uses **Turborepo** for intelligent task orchestration:
- Intelligent caching: Only rebuilds when dependencies change
- Parallel execution: Builds packages in parallel when possible
- GitHub Actions cache: CI/CD benefits from cached builds
- Dependency awareness: Automatically respects package dependencies

**Performance:**
- First build: ~8 seconds
- Cached builds: ~80ms (100x faster)

### Code Style

- Code formatting enforced by Biome
- 2 spaces for indentation
- Single quotes for strings
- 80-character line width
- ESM module format exclusively
- camelCase for variables/functions, PascalCase for classes

---

## For Contributors

### Quick Links

- **Detailed Workflows**: [WORKFLOW.md](./WORKFLOW.md) - Step-by-step SOPs for development
- **Testing Standards**: [TESTING_STANDARD.md](../TESTING_STANDARD.md) - Testing requirements
- **Contributing Guide**: [CONTRIBUTING.md](./CONTRIBUTING.md) - High-level guidelines

### Contribution Workflow

1. **Find or create an issue** in [GitHub Issues](https://github.com/happyvertical/smrt/issues)
2. **Follow workflow SOPs** in [WORKFLOW.md](./WORKFLOW.md):
   - Pre-work checklist
   - Create feature branch: `{type}/issue-{number}-{description}`
   - Implement with tests
   - Run quality checks
   - Create PR
3. **Code review** and feedback
4. **Merge** after approval

### Git Branching Strategy

**Branch naming**: `{type}/issue-{number}-{short-description}`
- `feat/issue-123-new-feature`
- `fix/issue-45-bug-fix`
- `docs/issue-89-update-readme`

**Conventional commits**: All commits follow [Conventional Commits](https://www.conventionalcommits.org/)

For complete workflow details, see [WORKFLOW.md](./WORKFLOW.md).

### Testing Requirements

All code changes must include tests following [TESTING_STANDARD.md](../TESTING_STANDARD.md):
- Use real resources (in-memory DBs, temp files) over mocks
- Tests should read like documentation
- README examples must have corresponding tests
- Follow BDD/TDD for bug fixes

---

## Architecture & Advanced Topics

### Cross-Package Dependencies

When adding features, maintain the dependency hierarchy to avoid circular dependencies:

**Within SMRT framework:**
- `types`, `config` → No internal dependencies
- `core` → Depends on types, config, and external SDK packages
- Domain modules → Depend on core

**Cross-dependencies:**
- `assets` → depends on `tags`
- `events` → depends on `places`, `profiles`

### MCP Server Integration (3-Tier Architecture)

The SMRT framework provides three tiers of Model Context Protocol servers for AI integration:

**Tier 1: Auto-Generated Project MCP Servers**
- Runtime MCP servers generated from your SMRT objects
- Deploy alongside your application for AI-powered operations
- See [packages/core/CLAUDE.md](./packages/core/CLAUDE.md) for MCPGenerator API

**Tier 2: SMRT Advisor MCP** (`@happyvertical/smrt-dev-mcp`)
- Development-focused tools for code generation
- Tools: `generate-smrt-class`, `introspect-project`

**Tier 3: SMRT Documentation MCP** (`@happyvertical/smrt-docs-mcp`)
- Documentation and learning tools
- Tools: `search-docs`, `get-example`, `explain-concept`

**Example Development Flow:**
1. **Learn** (Tier 3): Query framework documentation
2. **Generate** (Tier 2): Create SMRT classes
3. **Develop**: Write business logic
4. **Deploy** (Tier 1): Generate project MCP server
5. **Operate** (Tier 1): AI interacts with live data

### TypeScript Project References

The framework uses TypeScript project references for proper type resolution across packages:

**Configuration requirements:**
- `composite: true` in tsconfig.json
- `outDir`, `rootDir`, and `tsBuildInfoFile` properly configured
- Entry in root tsconfig.json `references` array

### Performance Optimizations

**Registry Caching:**
- Class metadata cached on first access
- Field definitions analyzed once
- Collection instances use singleton pattern (60-80% faster)

**Query Optimization:**
- Eager loading with JOINs (40-70% improvement for relationship-heavy queries)
- Prepared statement reuse
- Result set streaming for large queries

**Build Caching:**
- Manifest generated once at build time
- Virtual modules cached by Vite
- Type declarations cached in `node_modules/.vite`

For detailed architecture documentation, see [packages/core/ARCHITECTURE.md](./packages/core/ARCHITECTURE.md).

---

## Issue Triage and Management

The SMRT repository uses automated AI-powered issue triage:

- **AI-Powered Triage**: Automatic analysis, labeling, and prioritization
- **Priority Levels**: P0 (Critical), P1 (High), P2 (Medium), P3 (Low)
- **Issue Templates**: Structured bug reports and feature requests
- **Stale Management**: Automatic cleanup after 30+ days inactive

**Response Time Targets:**
- **P0-Critical**: < 1 hour (production outages, security issues)
- **P1-High**: < 4 hours (major functionality broken)
- **P2-Medium**: < 2 business days (non-blocking bugs)
- **P3-Low**: < 1 week (minor issues, enhancements)

See [.github/TRIAGE_SOP.md](.github/TRIAGE_SOP.md) for complete details.

---

## Release Management

The framework uses semantic-release for automated versioning:

```bash
npm run release:preview  # Preview next release
npm run release:dry-run  # Dry run
npm run release          # Full release (CI handles this)
```

---

## Related Projects

- **[HAppyVertical SDK](https://github.com/happyvertical/sdk)**: Infrastructure packages that use SMRT
- **[create-gnode](https://github.com/happyvertical/create-gnode)**: CLI for creating federated local knowledge bases
- **[praeco](https://github.com/happyvertical/praeco)**: Local news agent built on SMRT

---

## License

MIT License - see [LICENSE](./LICENSE) file for details.

## Contact

- **GitHub**: https://github.com/happyvertical/smrt
- **Issues**: https://github.com/happyvertical/smrt/issues
- **Discussions**: https://github.com/happyvertical/smrt/discussions

---

*This framework was split from the HAppyVertical SDK in October 2024 to create a focused, self-contained foundation for building vertical AI agents.*
