# @happyvertical/smrt-core


[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Core AI agent framework with standardized collections, object-relational mapping, and code generators in the HAVE SDK.

## Overview

The `@happyvertical/smrt-core` package provides the foundation for building vertical AI agents. It offers a comprehensive framework with object-relational mapping, AI-powered operations, code generation capabilities, and seamless integration with other HAVE SDK packages.

## Key Features

- **AI-First Object Framework**: Objects with built-in AI operations (`is()`, `do()`, `describe()` methods)
- **Object-Relational Mapping**: Automatic database schema generation from TypeScript classes
- **Standardized Collections**: Advanced CRUD, batch operations, semantic search, and interceptors
- **Code Generation**: CLI tools, REST APIs, and MCP servers generated from objects
- **Field System**: Type-safe field definitions with validation and constraints
- **Vite Plugin Integration**: Virtual modules for automatic service generation
- **AST Scanning**: Automatic discovery of SMRT objects in codebases
- **Cross-Package Integration**: Unified access to AI, files, database, and web capabilities
- **Vector Embeddings**: Generate and manage semantic embeddings for search and similarity

## Installation

```bash
# Install with npm
npm install @happyvertical/smrt-core

# Or with yarn
yarn add @happyvertical/smrt-core

# Or with bun
bun add @happyvertical/smrt-core
```

## Usage

### Define SMRT Objects with TypeScript Types

```typescript
import { SmrtObject, field, foreignKey, smrt } from '@happyvertical/smrt-core';

// Define objects using TypeScript types (primary pattern)
@smrt({
  api: true,  // Auto-generate REST API
  mcp: true,  // Auto-generate MCP tools
  cli: true   // Auto-generate CLI commands
})
class Document extends SmrtObject {
  // TypeScript types → Automatic schema generation
  title: string = '';           // → TEXT column
  content: string = '';         // → TEXT column
  wordCount: number = 0;        // → INTEGER (no decimal)
  rating: number = 4.5;         // → DECIMAL (has decimal)
  isPublished: boolean = false; // → BOOLEAN column
  tags: string[] = [];          // → JSON column
  publishedAt: Date = new Date(); // → engine-specific timestamp column

  // Use field decorators only when needed for:
  // 1. Relationships
  @foreignKey(Category)
  categoryId: string = '';

  // 2. Constraints
  @field({ required: true, unique: true })
  slug: string = '';

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

#### When to Use Field Decorators

**Use TypeScript types** for most properties (preferred):
```typescript
name: string = '';           // → TEXT
count: number = 0;           // → INTEGER (no decimal point)
price: number = 0.0;         // → DECIMAL (has decimal point)
active: boolean = true;      // → BOOLEAN
created: Date = new Date();  // → engine-specific timestamp
tags: string[] = [];         // → JSON
```

**Add a decorator** only when you need something the type cannot express:
1. **Relationships**: `@foreignKey(Category)` above `categoryId = '';`
2. **Constraints**: `@field({ required: true, pattern: /^.+@.+$/ })` above `email = '';`
3. **Nullable columns**: `@field({ nullable: true })` above `latitude: number | null = null;`

The **field** decorators exported by `@happyvertical/smrt-core` are `field`,
`foreignKey`, `crossPackageRef`, `oneToMany`, `manyToMany`, and `meta` (the
class decorator `smrt` and the **method** decorator `method` come from the same
package). There are no per-type helper functions — `text()`, `integer()`,
`decimal()`, `datetime()`, and `json()` were removed in #318 and do not exist in
any current version.

**The 0 vs 0.0 Heuristic**:
- `quantity: number = 0` → INTEGER column (no decimal point)
- `price: number = 0.0` → DECIMAL column (has decimal point)
- `rating: number = 4.5` → DECIMAL column (has decimal point)

#### Date and PostgreSQL timezone semantics

SMRT persists JavaScript `Date` values as instants. PostgreSQL schemas therefore
use `TIMESTAMPTZ` for manifest-backed models and framework system tables;
SQLite and JSON retain their existing adapter-specific representations. Create,
strict insert, upsert/update, save, and hydration all round-trip the same epoch
regardless of the Node or PostgreSQL session timezone. Executable registry DDL
must name its target engine, for example
`ObjectRegistry.getSchemaDDL('Event', 'postgres')` or
`ObjectRegistry.getAllSchemas('postgres')`. The one-argument registry forms are
retained for compatibility with code that inspects cached manifests; their
engine-neutral `ddl` must not be executed on PostgreSQL. More generally, a
manifest's `schema.ddl` is a CREATE TABLE preview with no indexes and abstract
types; `db:migrate`, `MigrationGenerator`, `SchemaAggregator`, and
`createIsolatedTestDbFromManifest` all render the structured `schema.columns`
and `schema.indexes` through the engine DDL strategy instead (#2358).

Schemas created before SMRT adopted `TIMESTAMPTZ` may contain PostgreSQL
`TIMESTAMP` columns. By default SMRT reports these as manual drift and does not
reinterpret them. After auditing DB defaults, triggers, raw SQL, and every
historical writer, an operator may opt into the UTC conversion with
`migrateSmrtSchemas({ ..., postgresTimestampMigration: { legacyTimezone:
'UTC' } })`. That migration uses `column AT TIME ZONE 'UTC'` because the SQL
adapter wrote UTC ISO strings and the old column discarded only their offset,
and it also fails unless the PostgreSQL migration session is UTC. If any writer
used local wall time, use a provenance-aware application migration with that
source timezone instead.
Legacy framework system tables are never converted automatically: after the
same historical-writer audit, an operator may explicitly call
`migratePostgresSystemTimestamps(db, { legacyTimezone: 'UTC' })`. Databases with
any non-UTC system-table writer require an application-owned, provenance-aware
migration instead. Type upgrades do not receive an automatic down migration;
rollback is a restore from the pre-migration backup or a reviewed forward-fix
after confirming the original writer's timezone contract.

### Create and Manage Collections

```typescript
import { SmrtCollection } from '@happyvertical/smrt-core';

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

## AI-Powered Methods

SMRT objects include built-in AI operations that enable intelligent content analysis and transformation. These methods leverage the configured AI provider to perform natural language tasks.

### `is(criteria)` - Evaluate Criteria

Evaluates whether the object meets specified criteria using AI analysis. Returns a boolean.

```typescript
// Check if content meets quality standards
const isHighQuality = await document.is(`
  - Contains more than 500 words
  - Has clear structure and headings
  - Uses professional language
`);

// Validate data conditions
const isValid = await order.is("Has all required fields populated and total > 0");

// Check content characteristics
const isTechnical = await article.is("Contains technical programming content");
```

### `do(instructions)` - Execute Instructions

Executes AI-powered instructions on the object and returns the result. Use this for content transformation, analysis, and generation tasks.

```typescript
// Generate a summary
const summary = await document.do(`
  Create a 2-sentence summary of this document.
  Focus on the key points and main conclusions.
`);

// Transform content
const bullets = await article.do("Convert the main points into a bulleted list");

// Extract information
const entities = await content.do("Extract all mentioned company names as a JSON array");

// Analyze sentiment
const analysis = await review.do("Analyze the sentiment and provide a score from 1-10");
```

### `describe()` - Generate Description

Generates a natural language description of the object based on its content. Returns a string description.

```typescript
// Generate a product description
const description = await product.describe();
// Returns: "A high-performance wireless mouse with ergonomic design..."

// Use in content pipelines
const items = await collection.list({ where: { description: '' } });
for (const item of items) {
  item.description = await item.describe();
  await item.save();
}
```

### AI Method Best Practices

1. **Be specific with criteria**: Provide clear, measurable conditions for `is()` calls
2. **Use structured prompts**: Break complex instructions into bullet points for `do()` calls
3. **Cache expensive results**: Store AI-generated content in object properties to avoid repeated calls
4. **Handle errors gracefully**: AI methods may throw errors if the provider is unavailable

```typescript
class Article extends SmrtObject {
  summary: string = '';

  // Cache AI-generated summary
  async getSummary() {
    if (!this.summary) {
      this.summary = await this.do('Summarize in 2-3 sentences');
      await this.save();
    }
    return this.summary;
  }

  // Combine AI methods for complex workflows
  async processForPublication() {
    const isReady = await this.is('Has title, content > 300 words, and proper formatting');
    if (!isReady) {
      throw new Error('Article not ready for publication');
    }

    this.description = await this.describe();
    this.summary = await this.do('Create an engaging meta description under 160 characters');
    await this.save();
  }
}
```

## Single Table Inheritance (STI)

SMRT supports Single Table Inheritance where multiple classes share one database table:

### Basic STI Configuration

```typescript
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

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
class Conference extends Event {
  sponsorName: string = '';
  ticketPrice: number = 0.0;
  sessions: number = 0;
}
```

### How STI Works

- **Single Table**: All classes in the hierarchy share the `events` table
- **Discriminator Column**: `_meta_type` identifies the actual class type
- **Field Storage**:
  - Base class fields → Regular columns
  - Child-specific fields → JSONB `_meta_data` column

### Polymorphic Queries

```typescript
const eventCollection = await EventCollection.create(options);

// Create different event types
const meeting = await eventCollection.create({
  _meta_type: 'Meeting',
  title: 'Daily Standup',
  roomNumber: '101',
  attendees: ['Alice', 'Bob']
});

const conference = await eventCollection.create({
  _meta_type: 'Conference',
  title: 'Tech Summit',
  sponsorName: 'TechCorp',
  ticketPrice: 299.00
});

// Query returns mixed types!
const allEvents = await eventCollection.list();

for (const event of allEvents) {
  console.log(event.constructor.name); // 'Meeting' or 'Conference'

  if (event instanceof Meeting) {
    console.log(`Room: ${event.roomNumber}`);
  } else if (event instanceof Conference) {
    console.log(`Price: ${event.ticketPrice}`);
  }
}

// Filter by type
const meetings = await eventCollection.list({
  where: { _meta_type: 'Meeting' }
});
```

### Multi-Level Inheritance

```typescript
// Level 1: Base class
@smrt({ tableStrategy: 'sti' })
class Content extends SmrtObject {
  title: string = '';
  body: string = '';
}

// Level 2: Extends Content
@smrt()
class Article extends Content {
  author: string = '';
  publishedDate: Date = new Date();
}

// Level 3: Extends Article
@smrt()
class NewsArticle extends Article {
  newsCategory: string = '';
  breakingNews: boolean = false;
}

// All three classes share the 'contents' table
const article = new NewsArticle({
  title: 'Breaking News',        // From Content
  body: 'Story details...',       // From Content
  author: 'Jane Smith',           // From Article
  publishedDate: new Date(),      // From Article
  newsCategory: 'Technology',     // From NewsArticle
  breakingNews: true              // From NewsArticle
});
```

### When to Use STI

✅ **Use STI when:**
- Classes share most fields (80%+ overlap)
- Need polymorphic queries (mixed types in one query)
- Frequent queries across the hierarchy
- Small number of subclass-specific fields

❌ **Avoid STI when:**
- Many unique fields per subclass (sparse columns)
- Deep hierarchies (3+ levels)
- Subclasses need different indexing strategies

## Code Generation

SMRT generates CLI, REST, and MCP surfaces from `@smrt()` objects in two ways:

- **Build-time**, via the Vite plugin (`smrtPlugin()`, see [Vite Plugin Integration](#vite-plugin-integration) below) — scans decorated classes and emits virtual modules (routes, typed client, MCP tool definitions, manifest) consumed by the generated SvelteKit routes and `@happyvertical/smrt-web`. This is how a typical SMRT application ships REST/MCP today.
- **Runtime**, via the generator classes below (`@happyvertical/smrt-core/generators`), which read whatever `@smrt()` objects are currently registered on `ObjectRegistry` and serve them directly — for a host process that wants REST/MCP without a Vite build. None of these classes accept a `collections` list; they discover registered objects themselves, and (`MCPGenerator.generateServer()` aside) none of them write files to disk.

CLI generation does not live here. `@happyvertical/smrt-core` shipped an in-process `CLIGenerator`/`setupCLI()` (plus the `@happyvertical/smrt-virt-cli` Vite virtual module) for admin `objectname:action` commands, but it had zero consumers and was retired (#2664). Two live CLI transports remain, both outside this package:

- The local `smrt <object>:<action>` binary (`packages/cli/src/cli-generator.ts`), against a database connection from `smrt.config`.
- [`@happyvertical/smrt-app-cli`](./app-cli.md), a distributable command-line application that discovers commands over authenticated HTTP from a running app.

### REST API Generation

`APIGenerator` serves REST for whatever `@smrt()` objects are registered. `APIConfig` is `{ basePath?, enableCors?, allowedOrigins?, allowCredentials?, customRoutes?, authMiddleware?, port?, hostname?, eventsRoute?, manifestHash?, playbookPreflight? }` — there is no `collections`, `outputDir`, `includeSwagger`, or `middleware` option, and no `generate()` method.

```typescript
import { APIGenerator, startRestServer } from '@happyvertical/smrt-core/generators';

// Low-level: a Web-standard fetch handler you mount yourself
const generator = new APIGenerator({ basePath: '/api/v1' });
const handler = generator.generateHandler(); // (req: Request) => Promise<Response>

// Or registerCollection() + a batteries-included Node http.Server:
generator.registerCollection('products', productCollection);
const { server, url } = generator.createServer();

// Or the startRestServer() convenience wrapper: warns for any of the passed
// classes not already registered by their own @smrt() decorator (it does not
// register them itself), starts a Node http.Server, and resolves a
// graceful-shutdown function.
const shutdown = await startRestServer([Product, Order], { db }, { basePath: '/api/v1' });
```

OpenAPI documentation is a separate concern, generated by `generateOpenAPISpec()` (`@happyvertical/smrt-core/generators/swagger`) rather than an `includeSwagger` option on `APIGenerator`.

### Which methods get a route

A public method becomes a custom REST action **by default** when it is
*wire-able*: every parameter can be built from a JSON request body or a query
string. This is a gate on the signature, not on intent — a method that takes a
live model instance has no route because no HTTP caller could ever invoke it.

Wire-able parameter types:

- primitives and literal types (`string`, `number`, `boolean`, `'a' | 'b'`);
- `any`, `unknown`, and an inline object literal (`{ limit?: number }`);
- arrays, `Record<…>`, `Partial<…>`, `Pick<…>`, `Omit<…>`;
- a named interface or type alias — accepted heuristically, since resolving it
  needs type information the AST scanner does not have;
- `Date`, which generated handlers and the runtime REST transport hydrate from
  an ISO string or epoch number;
- a union with at least one wire-able branch — `addReference(c: Content | string)`
  is routed, because the string branch already accepts an id.

NOT wire-able, so not routed by default:

- a manifest **model class** instance (`addAsset(asset: Asset)`);
- a function or callback, including one nested inside an inline object literal;
- a stream, buffer, `Request`/`Response`, `Map`/`Set`, or similar runtime value;
- a bare type parameter (`T`);
- a rest parameter, which no transport can name in a body;
- a type the scanner could not resolve — an intersection, tuple, conditional,
  mapped, `typeof`, or indexed-access type. This fails **closed**: the manifest
  records the parameter as `any` for compatibility, so the gate reads separate
  provenance rather than trusting that `any`.

CRUD verbs and framework lifecycle methods (`save`, `initialize`, `toJSON`, …)
are never custom actions, even when a subclass declares its own override — they
are the mechanism behind generated CRUD, matching what the CLI and MCP surfaces
already do.

Every withheld method is reported **with its reason** in
`.smrt/smrt-knowledge.json` under `withheldSurfaces`, so a missing route is
explained rather than silent.

**Compatibility, precisely.** A method named in `api.include`, or carrying an
`api.routes[method]` entry, is an explicit declaration made before this gate
existed and bypasses the heuristic entirely — those routes are preserved
unchanged. A **default-routed** method (public, no declaration) can lose its
route on signature, and across this monorepo 88 did. Audit before upgrading:
every withheld method is listed with its reason in `.smrt/smrt-knowledge.json`
under `withheldSurfaces`, and `@method({ expose: true })` restores any one of
them.

One case fails the build rather than the request: `cli.include` naming a method
the heuristic now withholds trips the cli↔api coherence check, because the CLI
would be advertising a command whose route no longer exists. The error lists its
remedies; `@method({ expose: true })` is usually the one you want, since it keeps
the route without widening `api.include`.

### The `@method()` decorator

`@method()` refines how a method is exposed, the way `@field()` refines how a
property is stored. Neither *declares* its member: a property is a field because
it is a property, and a public method is a candidate action because it is
public. Both refine what the framework already inferred.

```typescript
import { method, smrt, SmrtObject } from '@happyvertical/smrt-core';

@smrt()
class Content extends SmrtObject {
  @method({ httpMethod: 'POST', path: 'reviews', effect: 'write' })
  async runReview(options?: RunContentReviewOptions) { /* … */ }

  @method({ expose: false, reason: 'callback registration, not a wire operation' })
  static registerValidator(validator: ValidatorFunction) { /* … */ }

  // The heuristic rejects this; force it back on and accept the JSON yourself.
  @method({ expose: true })
  async addAsset(asset: Asset | string) { /* … */ }
}
```

| option | meaning | migrates from |
|---|---|---|
| `expose` | `false` withholds a method the heuristic accepted; `true` exposes one it rejected | — |
| `reason` | why it is withheld; surfaced by the knowledge artifact and `smrt doctor` | — |
| `httpMethod` | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'` | `api.routes[m].method` |
| `path` | route path segment(s) | `api.routes[m].path` |
| `scope` | `'item' \| 'collection'` | `api.routes[m].scope` |
| `effect` / `idempotent` / `openWorld` | tool semantics | `api.routes[m]` |
| `description` | AI/tool description | `ai.descriptions[m]` |

Rules worth knowing:

- **`expose: true` bypasses the heuristic and nothing else.** It cannot undo
  `api: false`, cross an `include`/`exclude` boundary, reach a non-public
  method, claim a CRUD verb, or manufacture a receiver — and it does not hydrate
  a value the transport cannot build. A forced `addAsset(asset: Asset)` receives
  whatever JSON the caller sent.
- **`expose: false` outranks everything else**, including a legacy
  `api.routes` entry or an `api.include` listing for the same method.
- **Merging is field by field.** `@method({ description })` on a class that
  already declares `routes: { m: { method: 'POST', path: 'x' } }` overrides only
  the description; the verb and path survive.
- **`scope` is a declaration, not a relocation.** The executable receiver
  decides: an instance method is item-scoped, a static or collection-class
  method is collection-scoped. A contradicting `scope` is ignored and reported
  at build time.
- `api.routes` and `ai.descriptions` keep working unchanged. Where both are
  present, `@method()` wins.
- **The runtime REST transport is declaration-gated.** `APIGenerator` (the
  standalone fetch handler, as opposed to the generated SvelteKit routes) serves
  a custom collection action only where one was DECLARED — historically an
  `api.routes` entry, and now also a `@method()` carrying any option that
  migrates from that map (`httpMethod`, `path`, `scope`, `effect`,
  `idempotent`, `openWorld`) or an explicit `expose: true`. A bare `@method()`
  or a `description`-only one does not declare a route there, because neither
  migrates from `api.routes`. Browser-plane preflight predicts exactly this gate,
  and honors `expose: false` with it — a withheld action is predicted
  unroutable, and a request to its declared URL gets an explicit 404 rather than
  falling through into a `create`. The same refusal covers an ITEM-scoped
  declaration, which this transport does not serve at all: `POST
  /<collection>/<action>` for one answers 404, not a silent `create`. The
  generated SvelteKit surface serves those under `[id]`.

**Date hydration is top-level only.** A parameter declared exactly `Date` (or
`Date | null` / `Date | undefined`) is converted from its ISO string or epoch
number before the method is called. `Date | string` is left alone — that
signature already accepts the string a caller sends. A `Date` nested inside a
named options bag is invisible to the manifest and is not hydrated; such a
method must accept the string itself.

### Caching Headers (Conditional GET)

Generated read routes (`list` and `get`) support conditional GET out of the box, on both the REST generator and the generated SvelteKit routes:

- Every 200 read response carries a **strong ETag** — a SHA-256 hash of the serialized JSON body — plus a `Cache-Control` header.
- A request whose `If-None-Match` matches the current ETag is answered `304 Not Modified` with an **empty body**, saving transfer, parse, and re-render. (v1 still runs the query; a later slice derives the ETag from the change feed for zero-query 304s.)
- Any mutation that changes the serialized data changes the ETag, so stale validators revalidate to a fresh 200.

The `Cache-Control` policy is resolved from the object's `@smrt({ api })` config:

| Model config | Read `Cache-Control` |
|--------------|----------------------|
| Default (any non-public model) | `private, no-cache` — browsers may store but must revalidate; shared caches never store |
| `api: { public: true }` (no cache opt-in) | `private, no-cache` |
| `api: { public: true \| 'read', cache: { sMaxage: n } }` | `public, max-age=0, s-maxage=n` — CDNs serve for `n` seconds; browsers still revalidate |
| Tenant-scoped model (`@smrt({ tenantScoped })` or `@TenantScoped()`, **any** mode) | `private, no-cache` — always; `sMaxage` is ignored with a one-time warning |

```typescript
// Opt a genuinely public model into CDN caching for 5 minutes:
@smrt({ api: { public: 'read', cache: { sMaxage: 300 } } })
export class Article extends SmrtObject { /* ... */ }
```

Notes:

- `api.cache.sMaxage` is only honored when reads are public (`public: true` or `public: 'read'`). **Non-public models never emit shared-cache headers**, even if `sMaxage` is configured.
- **Tenant-scoped models never emit shared-cache headers** (any mode, including `'optional'`): the response body varies with the tenant context resolved from the session cookie, which URL-keyed shared caches cannot see — honoring `sMaxage` would serve one tenant's rows to other tenants or anonymous visitors. The knob is neutralized to `private, no-cache` and a one-time warning is logged.
- `max-age=0` keeps browsers revalidating (cheap 304s), so end users see edits immediately while shared caches absorb anonymous traffic.
- Reserve the opt-in for responses that are identical for every requester; it is distinct from the top-level `@smrt({ cache })` knob, which configures the server-side collection read-through cache.
- Mutations (`create`/`update`/`delete`) and custom action routes are unaffected.

### Tenant-Scoped Public Reads Fail Closed to Global Rows

A tenant-scoped model (`@smrt({ tenantScoped })` or `@TenantScoped()`) that is
also marked `api: { public: true | 'read' }` can be read without authentication.
Such a request carries no tenant context, so — left unguarded — the generated
read would return rows from **every** tenant to an anonymous caller.

Generated reads fail closed instead. When tenancy is enabled but no tenant
context is active, `list`, `get /:id`, and `count` are restricted to
**NULL-tenant (global) rows only** on both transports (the REST generator and
the generated SvelteKit routes), mirroring the dispatch resolver and `_changes`
convention: *tenancy enforced with no context → global rows only*. A
client-supplied `?tenantId=` / `?tenant_id=` query param cannot widen the scope.

| Request against a tenant-scoped `public` model | Rows returned |
|-----------------------------------------------|---------------|
| No tenant context (anonymous), tenancy enabled | NULL-tenant (global) rows only |
| Active tenant context (authenticated) | that tenant's rows (interceptor-filtered) |
| Tenancy disabled | all rows (no isolation to enforce) |

Registering the `tenantScoped` + `api.public` combination logs a one-time
warning so the global-only behavior is not mistaken for a broken endpoint. If
per-tenant public reads are intended, resolve a tenant from the request itself
(host, subdomain, or path) and enter that tenant context before the read. This
scoping applies to reads only; mutations always require authentication.

### MCP Server Generation

`MCPGenerator` exposes registered objects as MCP tools. `MCPConfig` is `{ name?, version?, description?, cache? }` — there is no `collections`, `outputDir`, or `tools` constructor option; the tool set is always derived from `ObjectRegistry`, not passed in.

```typescript
import { MCPGenerator } from '@happyvertical/smrt-core/generators';

const generator = new MCPGenerator({ name: 'my-app-mcp', version: '1.0.0' });

// In-process: list tools and handle a JSON-RPC-style call directly
const tools = await generator.generateTools();
const response = await generator.handleToolCall(jsonRpcRequest);

// Or write a runnable stdio server to disk — the only generator that does:
await generator.generateServer({
  outputPath: '.smrt/mcp-server/index.js',
  serverName: 'my-app-mcp',
  generateClaudeConfigFile: true,
});
```

Generated `tools/list` results are sorted by tool name and advertise a one-day
`private` cache lifetime. Only a reviewed global, unauthenticated catalog may
opt into shared caching, and the opt-in is rejected for a server that exposes
tenant-scoped tools:

```typescript
const generator = new MCPGenerator({
  cache: {
    toolsList: { cacheScope: 'public', publicCatalog: true },
  },
});
```

## SMRT Development MCP

Use `@happyvertical/smrt-dev-mcp` for development-time code generation,
project introspection, ecosystem review, architecture context, and deterministic
SMRT knowledge. Runtime tool generation remains available from
`@happyvertical/smrt-core/generators/mcp`, while application-level MCP policy
belongs to `@happyvertical/smrt-app-mcp`.

Configure the development server in your `.mcp.json` file:

```json
{
  "mcpServers": {
    "smrt-dev-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@happyvertical/smrt-dev-mcp"
      ],
      "env": {
        "DEBUG": "false"
      }
    }
  }
}
```

After restarting your MCP client, use `generate-smrt-class` for model
scaffolding, `introspect-project` for object and schema discovery, and
`smrt-review` for deterministic framework-alignment findings.

Former source-checkout helper tool names are not exposed as compatibility
aliases. When using `generate-smrt-class` to scaffold a collection, add its
item import and required `_itemClass`; for curl examples, use the public REST
or OpenAPI generator output.

## Vite Plugin Integration

Use the Vite plugin for automatic service generation during development:

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
  SmrtObject,
  field,
  foreignKey,
  oneToMany,
  manyToMany,
} from '@happyvertical/smrt-core';

class Product extends SmrtObject {
  @field({ required: true, maxLength: 100 })
  name: string = '';

  @field({ min: 0, required: true })
  price: number = 0.0;

  inStock: boolean = true;
  tags: string[] = [];

  @field({ required: true })
  createdAt: Date = new Date();

  // Relationships
  @foreignKey(Category)
  categoryId: string = '';

  @oneToMany(Review)
  reviews: Review[] = [];

  @manyToMany(Product)
  relatedProducts: Product[] = [];
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

#### Query bounds

`limit` and `offset` must be non-negative integers; anything else (`NaN`, a
negative, a fraction) is rejected as a client error rather than bound into the
query. `orderBy` terms are validated against the model's fields and refused for
`@field({ sensitive: true })` and `@field({ readPermission })` columns — the same
rail `where` and `select` use, because ordering by a value you may not read is an
oracle over it — and for fields that exist but have no column
(`oneToMany`/`manyToMany`/`@meta()`/`transient`).

`list()` applies no default page size, because relationship, junction and
`listByIds()` callers rely on receiving every matching row. Opt into bounds per
collection when a collection's reads should always be paged:

```typescript
const products = await Products.create({
  db,
  defaultListLimit: 50, // used when a caller passes no limit
  maxListLimit: 500,    // every limit is clamped down to this
});
```

The generated REST, SvelteKit and MCP surfaces always bound their own input:
they default to 50, clamp to 1000, reject malformed values with a 400, and page
with a deterministic `ORDER BY created_at DESC, <primary key> ASC` (`id` unless
the model declares its own `@field({ primaryKey: true })` column).

### Eager Loading (Preventing N+1 Queries)

SMRT supports eager loading to optimize queries that access related objects, solving the common "N+1 query problem":

```typescript
// Define relationships
class Order extends SmrtObject {
  @foreignKey(Customer)
  customerId: string = '';

  @foreignKey(Product)
  productId: string = '';

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

For more details, see the package `AGENTS.md` documentation.

### Direct SQL Access

All SMRT objects have public `db` property for direct database access via @happyvertical/sql. This enables custom queries, transactions, and advanced database operations:

```typescript
import { field, SmrtObject, SmrtCollection } from '@happyvertical/smrt-core';

class Product extends SmrtObject {
  @field({ required: true })
  name = '';

  @field({ required: true })
  price = 0.0;

  @field({ required: true })
  category = '';
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
- **Full @happyvertical/sql power**: Access all DatabaseInterface methods (many, single, pluck, execute)
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
import { getDatabase } from '@happyvertical/sql';
const db = await getDatabase({ type: 'postgres', url: 'postgres://...' });
const collection = await ProductCollection.create({ db });
```

### PostgreSQL runtime timeouts

Every PostgreSQL pool SMRT opens is bounded by default. Without these, `pg`
waits forever for a free client, a runaway query holds its connection until it
finishes, and a request that stalls mid-transaction holds its locks until the
process exits.

| Key | Applied as | Default | Effect |
| --- | --- | --- | --- |
| `connectionTimeout` | `connectionTimeoutMillis` pool option | `10s` | Fail an acquisition instead of queueing forever (pending happyvertical/sdk#1204) |
| `statementTimeout` | `statement_timeout` | `30s` | Cancel a single runaway statement |
| `idleInTransactionSessionTimeout` | `idle_in_transaction_session_timeout` | `60s` | Kill a transaction left open between statements, releasing its locks |
| `lockTimeout` | `lock_timeout` | `10s` | Stop waiting for a lock someone else holds |

Values are milliseconds or a duration string (`'250ms'`, `'30s'`, `'2min'`,
`'1h'`) — the same spelling `migrations.postgres.*` uses. `0` disables a
timeout explicitly. An unparseable value falls back to that key's default.

```typescript
// Per connection
const collection = await ProductCollection.create({
  db: {
    type: 'postgres',
    url: process.env.DATABASE_URL,
    timeouts: { statementTimeout: '10s', lockTimeout: '2s' },
  },
});
```

Deployments that only hand SMRT a connection URL configure the same four keys
through the environment: `SMRT_PG_CONNECTION_TIMEOUT`,
`SMRT_PG_STATEMENT_TIMEOUT`, `SMRT_PG_IDLE_IN_TRANSACTION_TIMEOUT`, and
`SMRT_PG_LOCK_TIMEOUT`. Precedence is: a parameter already spelled into the
connection URL, then `timeouts`, then the environment variable, then the
default — so `postgres://…/app?statement_timeout=120000` keeps its 120 s while
still picking up bounded lock and idle-in-transaction settings.

Three things these do **not** cover. `smrt db:migrate` opens its own connection
and bounds each statement from `migrations.postgres.lockTimeout` /
`.statementTimeout`, so a long migration keeps its own budget. A `db` option
that is already a live `DatabaseInterface` or a pre-created client is used as
given — configure timeouts where that pool is built. And the three session
timeouts ride the connection URL, so a PostgreSQL config with no `url` (discrete
`host`/`database` fields, or a bare `{ type: 'postgres' }` that lets the adapter
read `HAVE_SQL_URL`) receives only the acquisition timeout; pass the URL through
the config to get the rest.

## Vector Embeddings

SMRT objects support vector embeddings for semantic search and similarity comparisons. Embeddings convert object content into numerical vectors that capture semantic meaning.

### Configuration

Configure which fields to embed in the `@smrt()` decorator:

```typescript
@smrt({
  embeddings: {
    fields: ['title', 'content', 'summary'],  // Fields to embed (required)
    provider: 'local',                        // Override the project provider (optional)
    autoGenerate: true                        // Allow save-time generation (optional, default true)
  }
})
class Article extends SmrtObject {
  title: string = '';
  content: string = '';
  summary: string = '';
}
```

The decorator's `embeddings` object accepts exactly `fields`, `provider`,
`autoGenerate`, `regenerateOnChange`, and `combinedField`.

**There is no `model` key here.** Because `smrt()` takes a typed config, writing
one in a TypeScript object literal is an excess-property error; in plain
JavaScript, or wherever that check does not apply, it is simply ignored, since
nothing reads it. The model is a project-level setting:

```javascript
// smrt.config.js
import { defineConfig } from '@happyvertical/smrt-config';

export default defineConfig({
  smrt: {
    embeddings: {
      provider: 'local',                      // 'local' | 'ai' | 'auto' (default 'local')
      localModel: 'Xenova/bge-base-en-v1.5',  // used by 'local', and by 'auto' with no AI client
      aiModel: 'text-embedding-3-small',      // used by 'ai', and by 'auto' when an AI client exists
      dimensions: 768                         // default 768
    }
  }
});
```

The project config and the class config are merged into a
`ResolvedEmbeddingConfig` at runtime. `getEmbedding()` does take a per-call
`model` argument, but it selects which stored vector to read rather than which
model to generate with — see below.

Two caveats on the class-level flags:

- `autoGenerate` permits save-time generation but does not guarantee it. `save()`
  only kicks off a background `generateEmbeddings()` when an AI client is
  configured, so that a save never quietly loads a local transformer model. With
  `provider: 'local'` and no AI client, call `generateEmbeddings()` yourself.
- `regenerateOnChange` is resolved onto `ResolvedEmbeddingConfig` but is not
  currently consulted anywhere. Unchanged content is skipped regardless; use
  `generateEmbeddings({ force: true })` to re-embed it.

### `generateEmbeddings(options?)` - Generate Vectors

Generates vector embeddings for all configured fields. Call this after creating or updating content.

```typescript
const article = await collection.create({
  title: 'Introduction to Vector Search',
  content: 'Vector embeddings enable semantic search...'
});

// Generate embeddings for all configured fields
await article.generateEmbeddings();

// With options
await article.generateEmbeddings({
  force: true,        // Regenerate even if content unchanged
  fields: ['title']   // Only embed specific fields
});
```

### `getEmbedding(fieldName, model?)` - Retrieve Embedding

Retrieves the stored embedding vector for a specific field. Returns `null` when
no embedding is stored for that field yet — callers must handle that case.

```typescript
// Signature: getEmbedding(fieldName: string, model?: string): Promise<number[] | null>

// Get the embedding for a field
const titleVector = await article.getEmbedding('title');
if (titleVector) {
  console.log(`Embedding has ${titleVector.length} dimensions`);
} else {
  await article.generateEmbeddings({ fields: ['title'] });
}

// The model name is part of the storage key, so pass it to read the vector
// stored under a specific model (defaults to the resolved project model)
const vector = await article.getEmbedding('content', 'text-embedding-3-large');
```

### `hasStaleEmbeddings()` - Check for Updates

Checks if the object's content has changed since embeddings were last generated.

```typescript
// Check if embeddings need regeneration
if (await article.hasStaleEmbeddings()) {
  await article.generateEmbeddings();
}

// Use in batch processing
const articles = await collection.list({});
for (const article of articles) {
  if (await article.hasStaleEmbeddings()) {
    await article.generateEmbeddings();
  }
}
```

### `clearEmbeddings()` - Remove Embeddings

Removes all stored embeddings for the object.

```typescript
// Clear all embeddings
await article.clearEmbeddings();

// Useful when content is significantly changed
article.content = newContent;
await article.clearEmbeddings();
await article.generateEmbeddings();
```

### Embedding Best Practices

1. **Choose appropriate fields**: Embed fields with meaningful text content, not IDs or numeric values
2. **Regenerate on content changes**: Use `hasStaleEmbeddings()` to keep embeddings current
3. **Batch processing**: Generate embeddings in batches to manage API rate limits
4. **Select the right model**: Use smaller models for speed, larger models for accuracy

```typescript
// Batch embedding generation with rate limiting
async function embedAllArticles(collection: ArticleCollection) {
  const articles = await collection.list({});

  for (const article of articles) {
    if (await article.hasStaleEmbeddings()) {
      await article.generateEmbeddings();
      await new Promise(resolve => setTimeout(resolve, 100)); // Rate limit
    }
  }
}
```

### Raw Query with Hydration

Execute complex SQL queries while still getting back fully-hydrated SMRT objects:

```typescript
// Complex queries with JOINs, CTEs, subqueries - results are still SMRT objects
const featured = await products.query(`
  SELECT p.* FROM products p
  JOIN categories c ON p.category_id = c.id
  WHERE c.featured = true
  AND NOT EXISTS (
    SELECT 1 FROM inventory i
    WHERE i.product_id = p.id AND i.quantity = 0
  )
  ORDER BY p.created_at DESC
  LIMIT $1
`, [10]);

// Each result is a fully-functional Product instance
for (const product of featured) {
  console.log(product.name);      // Access properties
  await product.save();            // Use SMRT methods
  const valid = await product.is('Is this product well-described?'); // AI methods work
}
```

### Batch Operations

Efficiently work with multiple records:

```typescript
// Batch fetch by IDs (single query, avoids N+1)
const items = await collection.listByIds(['id1', 'id2', 'id3']);

// Find or create with defaults (upsert pattern)
const user = await users.getOrUpsert(
  { email: 'user@example.com' },     // Find by these fields
  { name: 'New User', role: 'member' } // Use these defaults if creating
);

// Get only changed fields between objects
const changes = collection.getDiff(existingUser, updatedData);
// Returns: { name: 'New Name' } if only name changed
```

## Semantic Search

Collections provide semantic search capabilities using vector embeddings. This enables finding similar content based on meaning rather than exact text matching.

### Search by Text Query

```typescript
// Search for articles similar to a text query
const results = await articles.semanticSearch('machine learning basics', {
  field: 'content',      // Which embedded field to search
  limit: 10,             // Max results
  minSimilarity: 0.7     // Minimum cosine similarity (0-1)
});

for (const article of results) {
  console.log(article.title, article._similarity); // _similarity score attached
}
```

### Find Similar Objects

```typescript
// Find articles similar to an existing article
const similar = await articles.findSimilar(article, {
  field: 'content',
  limit: 5,
  excludeSelf: true     // Don't include the source article
});
```

### Low-Level Similarity Search

```typescript
// Search with a pre-computed embedding vector
const queryEmbedding = await collection.ai.embed('search query');
const results = await articles.findSimilarToEmbedding(queryEmbedding, {
  field: 'content',
  limit: 10
});
```

### Batch Generate Embeddings

```typescript
// Generate embeddings for all objects missing them
const stats = await articles.generateMissingEmbeddings({
  batchSize: 50,         // Process in batches
  onProgress: (done, total) => {
    console.log(`Progress: ${done}/${total}`);
  }
});

console.log(`Generated: ${stats.generated}, Skipped: ${stats.skipped}`);
```

## Interceptors

Interceptors allow you to hook into collection operations for cross-cutting concerns like tenancy, auditing, caching, and access control.

### Registering Interceptors

```typescript
import { GlobalInterceptors } from '@happyvertical/smrt-core';

GlobalInterceptors.register({
  name: 'tenancy',
  priority: 100,  // Higher priority runs first

  // Intercept list operations
  beforeList(className, options, context) {
    // Add tenant filter to all queries
    return {
      ...options,
      where: { ...options.where, tenantId: getCurrentTenantId() }
    };
  },

  // Intercept after data is fetched
  afterList(className, results, context) {
    // Log or transform results
    logQuery(className, results.length);
    return results;
  }
});
```

### Available Hooks

| Hook | Description | Return Value |
|------|-------------|--------------|
| `beforeGet` | Before fetching single record | Modified options or void |
| `afterGet` | After fetching single record | Modified result or void |
| `beforeList` | Before listing records | Modified options or void |
| `afterList` | After listing records | Modified results or void |
| `beforeQuery` | Before raw SQL query | Modified query/params or void |
| `afterQuery` | After raw SQL query | Modified results or void |
| `beforeSave` | Before saving record | Modified instance or void |
| `afterSave` | After saving record | void |
| `beforeDelete` | Before deleting record | Boolean (false cancels) or void |
| `afterDelete` | After deleting record | void |

### Interceptor Context

All hooks receive a context object with metadata:

```typescript
interface InterceptorContext {
  className: string;       // SMRT class name (e.g., 'Product')
  collectionName: string;  // Collection class name
  timestamp: Date;         // When operation started
  operation: string;       // 'list' | 'get' | 'query' | 'save' | 'delete'
  metadata: Record<string, any>; // Custom data
}
```

### Example: Audit Logging

```typescript
GlobalInterceptors.register({
  name: 'audit',
  priority: 50,

  afterSave(className, instance, context) {
    auditLog.write({
      action: 'save',
      entity: className,
      entityId: instance.id,
      timestamp: context.timestamp,
      changes: instance._changedFields
    });
  },

  afterDelete(className, id, context) {
    auditLog.write({
      action: 'delete',
      entity: className,
      entityId: id,
      timestamp: context.timestamp
    });
  }
});
```

### Example: Soft Deletes

```typescript
GlobalInterceptors.register({
  name: 'soft-delete',
  priority: 90,

  // Filter out soft-deleted records from all queries
  beforeList(className, options, context) {
    return {
      ...options,
      where: { ...options.where, 'deletedAt': null }
    };
  },

  // Convert delete to soft delete
  beforeDelete(className, id, context) {
    const collection = getCollection(className);
    collection.db.execute`
      UPDATE ${collection.tableName}
      SET deleted_at = ${new Date()}
      WHERE id = ${id}
    `;
    return false; // Cancel the actual delete
  }
});
```

## Context Memory System

The Context Memory System enables SMRT objects to remember and recall operational knowledge, learned patterns, and parsing strategies. This is essential for AI agents that discover effective approaches and need to reuse them across sessions.

### Why Context Memory?

When an AI agent discovers that a specific CSS selector works for extracting content from a website, or learns that a particular date format is used consistently, it should remember this for future use. The Context Memory System provides persistent storage for these learned patterns with:

- **Hierarchical scoping**: Organize patterns by domain, context, and specificity
- **Confidence filtering**: Store reliability (0–1) and apply a minimum confidence on recall
- **Opt-in fallback**: Query from specific to general scopes with `includeAncestors: true`
- **Stored expiration metadata**: Record `expiresAt`; use `LearningMemory` when you need enforced TTL and outcome counters

### Core Methods

#### Object-Level Context

Store and retrieve context specific to an individual object instance:

```typescript
import { SmrtObject, field } from '@happyvertical/smrt-core';

class WebScraper extends SmrtObject {
  @field({ required: true })
  url: string = '';

  async discoverContentSelector() {
    const url = this.url;

    // Try to recall previously discovered selector
    const remembered = await this.recall({
      scope: `parser/content/${new URL(url).hostname}`,
      key: 'article-selector',
      includeAncestors: true // Falls back to parent scopes
    }) as string | null;

    if (remembered) {
      return remembered;
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
    }) as string | null;

    if (remembered) {
      return remembered;
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
  expiresAt?: Date       // Stored on the row; NOT enforced by recall() (see below)
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

// Returns: the stored value, JSON-parsed, or null if not found
```

#### `recallAll(options)` - Retrieve Multiple Contexts

```typescript
const contexts = await object.recallAll({
  scope: string,                // Scope to query
  includeDescendants?: boolean, // Include child scopes (default: false)
  minConfidence?: number        // Minimum confidence threshold (default: 0)
});

// Returns: Map<string, unknown> of key → stored value
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
      return await this.applyStrategy(url, strategy);
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
    const response = await fetch(endpoint);

    // Recall known response structure
    const structure = await this.recall({
      scope: `api/response/${endpoint}`,
      key: 'structure'
    });

    if (structure) {
      // Use known structure for efficient parsing
      return this.parseResponse(response, structure);
    }

    // Analyze and remember response structure
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
    for (const [key, value] of preferences) {
      this.applyPreference(key, value);
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
    const current = await this.recall({ scope, key }) as {
      pattern: unknown;
      version: number;
    } | null;

    if (!current) return;

    // Create improved version
    const improved = await this.improvePattern(current.pattern);
    const nextVersion = current.version + 1;

    // Store as new version
    await this.remember({
      scope,
      key,
      value: { pattern: improved, version: nextVersion },
      version: nextVersion,
      confidence: 1.0,
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
- **Usage metrics**: `success_count` / `failure_count` columns, maintained only by `LearningMemory` (see below)
- **Timestamps**: Created, updated, and last used dates
- **Expiration**: An `expires_at` column that stores the `expiresAt` you pass to `remember()`

The system table is automatically created when you initialize any SMRT object with database configuration.

**Expiry is stored, not enforced by `recall()`.** `remember()` writes
`expires_at`, but `recall()` and `recallAll()` have no expiry predicate — an
entry whose expiry has passed is still returned, and the primitive recall APIs
do not expose the stored expiry. If you stay on the primitive API, include the
expiry inside the stored value and enforce it before use (then call `forget()`
to delete the stale entry). Do not query the private `_smrt_contexts` table
directly. `success_count` / `failure_count` are the
same shape of promise: the columns exist on the table, but nothing in the
primitive path ever increments them. `SmrtObject.remember()` does not write
them at all, and `SmrtCollection.remember()` writes literal zeros — so a
collection-level `remember()` resets whatever counters had accumulated on that
row.

If you want expiry, a confidence floor, and reinforcement counters applied for
you, use `LearningMemory` (exported from `@happyvertical/smrt-core`) instead of
calling `remember()`/`recall()` directly. It reads and writes the same
`_smrt_contexts` rows, but it drops expired rows, applies a confidence floor
(0.7 by default), and updates `success_count`/`failure_count` from the outcomes
you report. It can also decay confidence by age, but that is opt-in: time decay
is off unless you set `decayHalfLifeMs`.

### Best Practices

1. **Use hierarchical scopes**: Organize from general to specific (e.g., `parser/date/domain.com/section`)
2. **Include confidence scores**: Track how reliable each pattern is
3. **Set appropriate confidence thresholds**: Filter out low-confidence patterns with `minConfidence`
4. **Use metadata for debugging**: Store discovery timestamps, AI model used, etc.
5. **Clean up old patterns**: Use `forgetScope()` to remove outdated contexts
6. **Version critical patterns**: Use version numbers for pattern evolution
7. **Handle expiration explicitly**: `expiresAt` is recorded but never applied or returned by `recall()`; include an expiry in the stored value and enforce it before use, or use `LearningMemory`, which applies expiry through a public API

## Cross-Package Integration

SMRT integrates seamlessly with other HAVE SDK packages:

```typescript
// With @happyvertical/spider for web content
import { SpiderAdapter } from '@happyvertical/spider';

class WebDocument extends SmrtObject {
  @field({ required: true })
  url = '';

  content = '';

  async scrapeContent() {
    const spider = new SpiderAdapter(this.options.spider);
    this.content = await spider.getTextContent(this.url);
    await this.save();
  }
}

// With @happyvertical/pdf for document processing
import { PDFProcessor } from '@happyvertical/pdf';

class PDFDocument extends SmrtObject {
  @field({ required: true })
  filePath = '';

  extractedText = '';

  async extractText() {
    const pdf = new PDFProcessor(this.options.pdf);
    this.extractedText = await pdf.extractText(this.filePath);
    await this.save();
  }
}

// With @happyvertical/files for file management
class FileDocument extends SmrtObject {
  async saveToFile(filename: string) {
    await this.fs.writeText(filename, this.content);
  }
}
```

## Error Handling

SMRT provides comprehensive error handling with specific error types:

Every error carries a stable machine-readable `code` and a structured
`details` object. There are no ad-hoc `field` / `sql` / `operation`
properties — read `details`.

```typescript
import { ValidationError, DatabaseError, RuntimeError } from '@happyvertical/smrt-core';

try {
  await document.save();
} catch (error) {
  if (error instanceof ValidationError) {
    // 'VALIDATION_UNIQUE_CONSTRAINT' | 'VALIDATION_REQUIRED_FIELD' | ...
    console.log('Validation failed:', error.code, error.details);
  } else if (error instanceof DatabaseError) {
    // The driver error is preserved on `cause`.
    console.log('Database error:', error.code, error.details, error.cause);
  } else if (error instanceof RuntimeError) {
    console.log('Runtime error:', error.code, error.details);
  }
}
```

### Constraint violations are typed, and never retried

`save()` classifies the driver failure through its whole cause chain, so a
unique or NOT NULL violation arrives as a `ValidationError` on every adapter —
SQLite, PostgreSQL and DuckDB alike — raised on the first attempt with no retry
backoff. Other database failures stay `DatabaseError` with the driver error on
`cause`.

Do **not** match on `error.message`. `@happyvertical/sql` wraps every driver
error as `DatabaseError('Failed to upsert record into table', …)` and
stringifies the driver text into `context.originalError`, so the constraint
wording is not on the outer message. Use the classifier instead:

```typescript
import {
  classifyDatabaseError,
  isUniqueViolationError,
} from '@happyvertical/smrt-core';

try {
  await document.save();
} catch (error) {
  if (isUniqueViolationError(error)) {
    // Losing side of a race — re-read the winner.
  }
  const { kind, deterministic, retryable } = classifyDatabaseError(error);
}
```

Retries are transient-only: serialization failures, deadlocks, lock timeouts
and dropped connections are retried; constraint violations, invalid input
syntax, missing tables and statements issued inside an aborted PostgreSQL
transaction (`25P02`) fail fast.

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
  @field({ required: true, unique: true, indexed: true })
  sku = '';

  @field({ indexed: true }) // Frequently queried
  category = '';

  @field({ min: 0 })
  price = 0.0;
}
```

Reference columns need no opt-in: every `@foreignKey`, `@crossPackageRef` and
tenant column is indexed automatically on every schema path (test databases,
`manifest.json`, `smrt db:migrate`) unless an index already leads with it — for
example a `conflictColumns` unique index that starts on that column. The
primary key is not indexed twice, `unique: true` on a single-table-inheritance
field becomes a unique index (partial by discriminator when only a subclass
declares it), and classes with custom `conflictColumns` keep a plain
`(slug, context)` index for slug loading. `smrt db:migrate` adds the missing
indexes to existing databases and drops the legacy `<table>_id_idx`.

The ordering every generated list route uses is indexed automatically too:
`(tenant_id, created_at)` on a tenant-scoped table and `(created_at)` otherwise,
so the default page (`ORDER BY created_at DESC` behind the tenant filter) is an
ordered index scan rather than a full scan plus a sort. The composite stands in
for the standalone tenant index rather than adding to it.

A list workload usually needs more than one column: it filters on one or more
columns and sorts on another, and only a composite index in that order serves it
as an ordered scan. Declare those with `@smrt({ indexes })` (#2357):

```typescript
@smrt({
  indexes: [
    // Serves: WHERE tenant_id = ? AND ... ORDER BY publish_date DESC LIMIT 10
    {
      name: 'articles_tenant_id_publish_date_idx',
      columns: ['tenantId', 'publish_date'],
    },
    // Partial + unique indexes are supported too.
    { name: 'articles_active_sku_idx', columns: ['sku'], unique: true, where: 'archived = false' },
  ],
})
class Article extends SmrtObject {}
```

`columns` accepts SMRT field names or column names, in index order — filter
columns first, sort column last. Declare columns, not a direction: PostgreSQL
scans a btree either way, so an ascending index also serves the matching
`ORDER BY ... DESC` without a sort step. A column the object does not have, or a
name that collides with a different generated index, fails schema generation
rather than silently dropping the index. An index leading with a reference column (`tenant_id`, a foreign key, a
cross-package ref) also stands in for that column's automatic index, and one
leading with `(tenant_id, created_at)` stands in for the default list-ordering
index.

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

**Learn more**: See the performance considerations in package `AGENTS.md` for detailed optimization strategies.

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
// throws ValidationError, code 'VALIDATION_UNIQUE_CONSTRAINT'
```

**Detecting it**: match the typed error, not the driver text — the adapter
wraps the driver error, so the constraint wording is not on `error.message`.

```typescript
import { isUniqueViolationError } from '@happyvertical/smrt-core';

if (isUniqueViolationError(error)) { /* … */ }
```

**Solution**: Ensure unique slugs within the same context, or use different contexts for objects with the same slug.

## API Reference

See the [API documentation](https://happyvertical.github.io/sdk/modules/_have_smrt.html) for detailed information on all available methods and options.

## License

This package is part of the HAVE SDK and is licensed under the MIT License - see the [LICENSE](../../LICENSE) file for details.
