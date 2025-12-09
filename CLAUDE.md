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
- **Manifest-Based**: Schema generation from AST at build time (no runtime introspection)
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

**⚠️ WARNING: Do Not Override toJSON()**

The `toJSON()` method in `SmrtObject` handles critical framework infrastructure. **DO NOT override** this method unless you call `super.toJSON()` first.

**What toJSON() handles:**
- **STI discriminator** (`_meta_type`) for polymorphic queries
- **Meta field extraction** (`_meta_data`) for child-specific fields
- **Automatic serialization** of all fields from manifest

**The Safe Way - Use transformJSON() Hook:**
```typescript
class Document extends SmrtObject {
  title: string = '';
  content: string = '';

  // ✅ CORRECT - Use transformJSON() hook
  protected transformJSON(data: any): any {
    return {
      ...data,
      wordCount: this.content.split(/\s+/).length,
      preview: this.content.substring(0, 100)
    };
  }
}
```

**The Dangerous Way - Overriding toJSON():**
```typescript
// ❌ WRONG - breaks STI and meta fields
class Document extends SmrtObject {
  toJSON() {
    return { id: this.id, title: this.title };
    // Missing: _meta_type, _meta_data, other fields!
  }
}

// ✅ CORRECT - calls super if you must override
class Document extends SmrtObject {
  toJSON() {
    const data = super.toJSON();
    return { ...data, customField: 'value' };
  }
}
```

See [issue #377](https://github.com/happyvertical/smrt/issues/377) for details.

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

// Raw SQL query for complex patterns (NOT EXISTS, JOINs, etc.)
const unpublished = await documents.query(`
  SELECT * FROM documents
  WHERE is_published = false
  AND NOT EXISTS (
    SELECT 1 FROM reviews r WHERE r.document_id = documents.id
  )
  ORDER BY created_at DESC
  LIMIT ?
`, [10]);

// Use AI-powered operations
const isQuality = await doc.isHighQuality();
const summary = await doc.generateSummary();
```

### Multi-Level Class Inheritance

SMRT supports multi-level class inheritance, allowing you to build class hierarchies where child classes automatically inherit fields and methods from parent classes:

```typescript
// Level 1: Base Content class (from @happyvertical/smrt-content)
@smrt()
class Content extends SmrtObject {
  title: string = '';
  body: string = '';
  publishedAt: Date | null = null;
  wordCount: number = 0;

  async generateSummary(): Promise<string> {
    return await this.do('Create a 2-sentence summary');
  }
}

// Level 2: Praeco Content extends Content (from praeco package)
@smrt()
class PraecoContent extends Content {
  sourceUrl: string = '';
  sentiment: string = '';

  async analyzeSentiment(): Promise<string> {
    return await this.is('The content has positive sentiment')
      ? 'positive'
      : 'negative';
  }
}

// Level 3: Bentley Content extends PraecoContent (from bentleyalberta.com)
@smrt()
class BentleyContent extends PraecoContent {
  localTags: string[] = [];
  featured: boolean = false;

  async analyzeLocalRelevance(): Promise<number> {
    // Custom local analysis
    return 0.95;
  }
}

// BentleyContent automatically inherits ALL fields and methods:
// - title, body, publishedAt, wordCount (from Content)
// - sourceUrl, sentiment (from PraecoContent)
// - localTags, featured (from BentleyContent)
// - generateSummary() (from Content)
// - analyzeSentiment() (from PraecoContent)
// - analyzeLocalRelevance() (from BentleyContent)

// Schema generation includes all inherited fields
const bentley = new BentleyContent({
  title: 'Local News',
  body: 'Story content...',
  sourceUrl: 'https://example.com',
  localTags: ['bentley', 'alberta'],
  db: { type: 'sqlite', url: 'bentley.db' }
});

await bentley.initialize();
await bentley.save();  // Table has ALL inherited columns

// Call methods from any level of the hierarchy
const summary = await bentley.generateSummary();  // Content
const sentiment = await bentley.analyzeSentiment();  // PraecoContent
const relevance = await bentley.analyzeLocalRelevance();  // BentleyContent
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

### Custom Method Discovery (Auto-Generated CLI Commands)

**New in v0.6+**: Custom methods are automatically discovered and exposed as CLI commands!

Define custom methods on your SMRT objects, and the CLI generator will automatically create corresponding commands:

```typescript
@smrt({
  cli: { include: ['list', 'get', 'research', 'report'] }  // Include custom methods
})
class Agent extends SmrtObject {
  name: string = '';
  source: string = '';

  // Custom method with parameters
  async research(options: { query: string, depth?: number }) {
    return {
      action: 'research',
      query: options.query,
      depth: options.depth || 3,
      results: await this.do(`Research: ${options.query}`)
    };
  }

  // Another custom method
  async report(options: { type?: string }) {
    return {
      action: 'report',
      type: options.type || 'summary',
      content: await this.do(`Generate ${options.type} report for ${this.name}`)
    };
  }
}
```

**Auto-generated CLI commands:**
```bash
# Standard CRUD (as before)
smrt agent:list
smrt agent:get <id>

# Custom methods (auto-discovered! 🎉)
smrt agent:research <id> --query "AI safety research" --depth 5
smrt agent:report <id> --type detailed
```

**How it works:**
- CLI generator scans `ObjectRegistry.getMethods()` for public methods
- Method parameters are converted to kebab-case CLI options (`researchQuery` → `--research-query`)
- Include/exclude lists work for both CRUD commands and custom methods
- Only public methods are exposed (private/protected methods are skipped)

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
npm test           # Uses 'smrt test' - generates manifests + runs tests
npm run test:watch # Watch mode

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

### ⚠️ CRITICAL: Running Tests

**ALWAYS use `smrt test` or `npm test` - NEVER use `npx vitest` directly!**

```bash
# ✅ CORRECT - Generates test manifest first
smrt test
npm test           # Aliases to 'smrt test'

# ❌ WRONG - Will fail with "unregistered class" errors
npx vitest
npx vitest run
```

**Why?** Tests require a manifest file that maps SMRT objects for schema generation. The `smrt test` command:
1. **Generates the test manifest** from `@smrt()` decorated classes
2. **Runs vitest** with the manifest loaded

Without the manifest, tests fail with errors like:
```
Cannot generate schema for unregistered class 'Council'.
Ensure the class is decorated with @smrt() for schema generation to work.
```

**For individual test files:**
```bash
# Generate manifest first, then run specific test
smrt test --manifest-only
npx vitest run src/specific-test.test.ts
```

**Database Adapter Testing:**

The framework includes comprehensive adapter parity tests to ensure consistent behavior across all database backends (SQLite, JSON/DuckDB). These tests verify:
- STI (Single Table Inheritance) operations
- UPSERT conflict resolution
- Type preservation across save/load cycles
- Query operations with filtering

See `packages/core/src/__tests__/sti-adapter-parity.test.ts` for the complete test suite that runs identical tests across all supported adapters.

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

### Manifest-Based Schema Generation

SMRT uses **AST-based manifest generation** instead of runtime introspection:

**How it works:**
1. **Build Time**: AST scanner finds all `@smrt()` decorated classes
2. **Manifest Generation**: Creates JSON manifest with class metadata, fields, and types
3. **Schema Generation**: Uses manifest data to generate database schemas
4. **No Runtime Introspection**: All metadata determined at build time

**Benefits:**
- **Performance**: No runtime reflection overhead
- **Tree-Shaking**: Unused classes can be eliminated
- **Type Safety**: Full TypeScript type information preserved
- **Predictable**: Schema determined at build time, not runtime

**The Manifest Process:**
```bash
# During build
smrt scan           # Scans TypeScript AST
  → manifest.json   # Generated manifest with all metadata
  → schema.sql      # Generated database schema

# During runtime
ObjectRegistry      # Reads manifest.json
  → generateSchema  # Uses manifest data (no reflection)
```

**TypeScript Type Inference:**
```typescript
// AST scanner infers types from TypeScript
class Product extends SmrtObject {
  name: string = '';        // AST → TEXT column
  count: number = 0;        // AST → INTEGER (no decimal)
  price: number = 0.0;      // AST → DECIMAL (has decimal)
  active: boolean = true;   // AST → BOOLEAN
  tags: string[] = [];      // AST → JSON
}
```

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

### Changesets and Versioning

⚠️ **IMPORTANT: Changesets are auto-generated on merge to main**

This project uses [Changesets](https://github.com/changesets/changesets) for versioning and package releases:

- **Automated Generation**: Changesets are auto-generated from conventional commits when PRs merge to main
- **No Changesets in PRs**: PRs do NOT contain changeset files - they're generated during publish workflow
- **PR Validation**: Only validates conventional commit format, not changeset presence
- **No Manual Creation**: Don't run `npx changeset` or create changeset files manually
- **Critical: Avoid `[skip ci]`**: Using `[skip ci]` in any commit message will prevent the on-merge-main workflow from running, which breaks package publishing

**Why this matters**: When a PR with `[skip ci]` in any commit is merged to main, GitHub Actions skips the entire merge workflow, including building and publishing packages. This requires manual intervention to trigger the publish workflow.

For complete changeset workflow and troubleshooting, see [CHANGESETS.md](./CHANGESETS.md).

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

The framework uses [Changesets](https://github.com/changesets/changesets) for automated versioning and publishing:

```bash
# Preview what will be released
pnpm run changeset:version  # Update package versions based on changesets

# Publish (handled automatically by CI on merge to main)
pnpm run changeset:publish  # Publish packages to registry
```

**Important**: Package releases are fully automated:
1. PRs generate changesets from conventional commits
2. Merging to main triggers the on-merge-main workflow
3. Workflow builds, versions, and publishes packages automatically
4. No manual `npm publish` needed

See [CHANGESETS.md](./CHANGESETS.md) for complete release workflow documentation.

---

## Dependency Management

The SMRT framework uses [Renovate CE](https://github.com/renovatebot/renovate) for automated dependency updates:

### How It Works

1. **Upstream Changes (SDK)**: When `@happyvertical/sdk` packages publish new versions, Renovate CE detects the update via GitHub webhooks
2. **PR Creation**: Renovate automatically creates a PR in SMRT with the updated dependencies
3. **Automerge**: Patch version updates are automatically merged after tests pass
4. **Downstream Propagation**: After SMRT publishes, Renovate detects the new version and creates PRs in downstream repos (praeco, caelus, etc.)

### Configuration

The Renovate configuration is defined in `renovate.json` and extends the shared config from [happyvertical/renovate-config](https://github.com/happyvertical/renovate-config):

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["local>happyvertical/renovate-config:smrt"]
}
```

### Expected Behavior

| Scenario | Renovate Action |
|----------|-----------------|
| SDK patch release (0.x.Y) | Auto-create PR, automerge after tests pass |
| SDK minor release (0.X.0) | Create PR, requires manual review |
| External dependency update | Grouped weekly PRs |
| Security vulnerability | Immediate PR with priority label |

### Dependency Flow

```
@happyvertical/sdk
        │
        ▼ (Renovate detects new version)
@happyvertical/smrt-* (this repo)
        │
        ▼ (Renovate detects new version)
praeco, caelus, create-gnode (downstream repos)
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
