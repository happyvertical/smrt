# @have/sql: Database Interface Package

## Purpose and Responsibilities

The `@have/sql` package provides a standardized interface for SQL database operations, with specific support for SQLite (via LibSQL) and PostgreSQL. It is designed to:

- Abstract away database-specific implementation details while maintaining direct SQL access
- Provide a consistent API for common database operations across multiple database engines
- Support dynamic schema synchronization for seamless table creation and updates
- Handle query building and parameter binding securely to prevent SQL injection
- Enable vector search capabilities with SQLite-VSS for AI workloads
- Offer both high-level object-relational methods and low-level SQL execution
- Support Node.js environments with optimized builds (browser builds removed in favor of focused Node.js development)
- Provide JSON manifest-based schema management with dependency resolution

Unlike full-featured ORMs, this package is intentionally lightweight, focusing on providing just enough abstraction while maintaining direct SQL access when needed for performance-critical operations.

**Expert Agent Expertise**: When working with this package, always proactively check the latest documentation for foundational libraries (@libsql/client, sqlite-vss, pg) as they frequently add new features, performance improvements, and vector search capabilities that can enhance database solutions.

## Architecture Overview

### Core Components

1. **index.ts**: Entry point with unified `getDatabase()` function and shared utilities
2. **sqlite.ts**: LibSQL adapter with support for in-memory, file-based, and remote (Turso) databases
3. **postgres.ts**: PostgreSQL adapter with connection pooling
4. **schema-manager.ts**: JSON manifest-based schema management with dependency resolution
5. **shared/types.ts**: TypeScript interfaces and type definitions
6. **shared/utils.ts**: Shared utilities including `buildWhere()` function

### Database Auto-Detection

The package automatically detects database type from connection URLs:
- URLs starting with `file:` or `:memory:` → SQLite
- Otherwise requires explicit `type: 'postgres'` or `type: 'sqlite'`

### Parameter Placeholder Differences

**Critical Implementation Detail**: The package handles parameter placeholders differently:
- **SQLite**: Uses `?` placeholders (positional)
- **PostgreSQL**: Uses `$1, $2, $3...` placeholders (numbered)

All template literal methods (`many`, `single`, `pluck`, `execute`) automatically handle this difference.

## Key APIs

### Database Client Creation

```typescript
import { getDatabase } from '@have/sql';

// Create an SQLite client (auto-detected from URL)
const sqliteDb = await getDatabase({
  url: 'file:database.db'  // or 'file::memory:' for in-memory
});

// Create an SQLite client with Turso/LibSQL remote connection
const tursoDb = await getDatabase({
  type: 'sqlite',
  url: 'libsql://your-database.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN
});

// Create an encrypted SQLite database (LibSQL feature)
const encryptedDb = await getDatabase({
  type: 'sqlite',
  url: 'file:encrypted.db',
  encryptionKey: process.env.ENCRYPTION_KEY
});

// Create a PostgreSQL client
const pgDb = await getDatabase({
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'username',
  password: 'password'
});

// Create from connection URL
const dbFromUrl = await getDatabase({
  type: 'postgres',
  url: 'postgresql://user:pass@localhost:5432/dbname'
});

// Create a JSON database adapter (DuckDB-backed, in-memory)
// Uses JSON files as data source, no WAL files or persistent DB files
const jsonDb = await getDatabase({
  type: 'json',
  dataDir: './data',           // Directory with JSON files (required)
  writeStrategy: 'immediate',  // Auto-save changes to JSON (default)
  autoRegister: true           // Load all JSON files as tables (default)
});
```

### JSON Adapter (DuckDB-backed)

The JSON adapter provides SQL query capabilities over JSON files using DuckDB's in-memory engine. It's ideal for:
- Local-first applications with JSON as the source of truth
- Development and testing with JSON fixtures
- Avoiding WAL files and persistent database files
- Simple data management with full SQL capabilities

**Key Features**:
- ✅ **No WAL files** - Everything in-memory, no write-ahead logs
- ✅ **No persistent DB files** - JSON files are the only persistent storage
- ✅ **Full SQL support** - All DuckDB SQL features available
- ✅ **Automatic schema inference** - DuckDB infers schema from JSON
- ✅ **Index support** - Can create indexes on tables (unlike views)
- ✅ **SMRT framework compatible** - Works with automatic table creation

**Usage Example**:
```typescript
import { getDatabase } from '@have/sql';

// Create JSON database
const db = await getDatabase({
  type: 'json',
  dataDir: './data',          // JSON files location
  writeStrategy: 'immediate'  // Auto-save after every change
});

// JSON files become queryable tables
// ./data/users.json → users table
// ./data/posts.json → posts table

// Query JSON data with SQL
const activeUsers = await db.many`
  SELECT * FROM users
  WHERE status = 'active'
  ORDER BY created_at DESC
`;

// Writes update JSON files (based on writeStrategy)
await db.insert('users', {
  id: '123',
  name: 'Alice',
  email: 'alice@example.com',
  status: 'active'
});
// → ./data/users.json updated with new record

// Export table manually (for 'manual' write strategy)
await db.exportTable('users');
```

**Write Strategies**:
- `'immediate'` (default) - Auto-save after every insert/update
- `'manual'` - Require explicit `exportTable()` calls
- `'none'` - Read-only mode (throws error on writes)

**Startup Behavior**:
1. Creates data directory if it doesn't exist
2. Scans for `*.json` files in `dataDir`
3. Loads each JSON file as an in-memory table
4. Schema auto-inferred from JSON structure
5. Tables ready for SQL queries

**Comparison with DuckDB Adapter**:

| Feature | JSON Adapter | DuckDB Adapter |
|---------|-------------|----------------|
| Database file | None (in-memory only) | Configurable (file or :memory:) |
| WAL files | Never created | Created for persistent DBs |
| JSON handling | Creates tables | Creates views |
| Index support | ✅ Yes (on tables) | ❌ No (views can't have indexes) |
| Write strategy | Configurable | Configurable |
| Use case | JSON-first apps | DuckDB-first apps |

**Limitations**:
- ⚠️ **Memory usage** - All data loaded into RAM
- ⚠️ **Single-process** - No concurrent writes across processes
- ⚠️ **Full table exports** - Entire table written to JSON on changes
- ⚠️ **Startup time** - Proportional to JSON file sizes

#### SMRT Framework Integration

The JSON adapter integrates with the SMRT framework to solve type inference issues when JSON files contain empty strings or null values. This fixes **Issue #228** where DuckDB's auto-detection would infer columns as `ANY` type, causing UPSERT operations to fail.

**Problem Scenario** (without SMRT integration):
```json
// data/organizations.json
[
  {
    "id": "123",
    "slug": "town-of-bentley",
    "context": "",
    "name": "town-of-bentley",
    "url": "",           // Empty string - DuckDB infers as ANY type
    "meetings_url": "",  // Empty string - DuckDB infers as ANY type
    "location": "",
    "timezone": ""
  }
]
```

Without SMRT integration, DuckDB's `auto_detect=true` creates columns as `ANY` type, and subsequent UPSERT operations fail with:
```
Error: Cannot create values of type ANY. Specify a specific type.
```

**Solution with SMRT Integration**:
```typescript
import { smrt, SmrtObject } from '@have/smrt';
import { text } from '@have/smrt/fields';
import { getDatabase } from '@have/sql';

// 1. Define SMRT object BEFORE initializing database
@smrt()
class Organization extends SmrtObject {
  name = text({ required: true });
  url = text();
  meetings_url = text();
  location = text();
  timezone = text();
}

// Register the SMRT object (happens automatically with @smrt decorator)
// This makes the schema available to the JSON adapter

// 2. Initialize JSON adapter - it will check for SMRT schemas
const db = await getDatabase({
  type: 'json',
  dataDir: './data',
  writeStrategy: 'immediate',
  // autoRegister defaults to true - will use SMRT schemas when found
});

// 3. Tables are created with proper types from SMRT schema
// - ObjectRegistry lookup: data/organizations.json → 'organizations' table → Organization class
// - Schema extraction: Gets CREATE TABLE statement from SMRT
// - Table creation: Uses TEXT types instead of ANY
// - Data loading: JSON data inserted into properly-typed table

// 4. UPSERT operations now work correctly
const org = new Organization({
  slug: 'another-org',
  context: '',
  name: 'Another Organization',
  url: 'https://example.com',
  meetings_url: 'https://example.com/meetings',
  location: 'Some Location',
  timezone: 'America/Denver'
});

await org.save(); // Uses db.upsert() with properly-typed columns
```

**How It Works**:
1. **Schema Lookup**: `getSmrtSchemaForTable(tableName)` checks ObjectRegistry for matching SMRT object
2. **DEFAULT Value Fixing**: Explicit CAST() added to all DEFAULT values to prevent DuckDB's ANY type inference:
   - `DEFAULT ''` → `DEFAULT CAST('' AS TEXT)`
   - `DEFAULT NULL` → `DEFAULT CAST(NULL AS TEXT)`
3. **Table Creation**: `createTableFromSmrtSchema()` creates table with properly-typed columns
4. **Data Loading**: JSON data inserted into properly-typed table using INSERT INTO ... SELECT FROM read_json()
5. **Fallback**: Non-SMRT tables use DuckDB auto-detection as before

**Technical Details**:
DuckDB has a known issue where DEFAULT values with empty strings or NULL cause type inference to fail, resulting in columns with `ANY` type instead of `TEXT`. The fix explicitly casts all DEFAULT values to their column types:

```sql
-- Before (causes ANY type):
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  url TEXT DEFAULT NULL
);

-- After (proper TEXT typing):
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT DEFAULT CAST('' AS TEXT),
  url TEXT DEFAULT CAST(NULL AS TEXT)
);
```

This ensures that:
- INSERT operations work with empty strings
- UPSERT operations don't fail with "Cannot create values of type ANY"
- Columns maintain proper TEXT typing throughout their lifecycle

**Configuration Options**:
```typescript
// Option 1: Default behavior (recommended)
// JSON adapter uses SMRT schemas when available, falls back to auto-detection
const db = await getDatabase({
  type: 'json',
  dataDir: './data',
  autoRegister: true  // Load all JSON files
});

// Option 2: Skip SMRT tables
// Let SMRT framework create tables first, then load JSON data
const db = await getDatabase({
  type: 'json',
  dataDir: './data',
  autoRegister: true,
  skipSmrtTables: true  // Skip tables with SMRT schemas
});

// Option 3: Manual table creation
// Disable auto-registration entirely
const db = await getDatabase({
  type: 'json',
  dataDir: './data',
  autoRegister: false  // Don't auto-load JSON files
});
// Then manually create tables via SMRT or SQL
```

**Best Practices**:
1. **Register SMRT objects before database initialization**
2. **Use descriptive field types** to generate proper SQL schemas
3. **Test with empty/null initial data** to ensure type inference works
4. **Use autoRegister: true** (default) for seamless integration
5. **Use skipSmrtTables: false** (default) unless you need SMRT to create tables first

**Limitations**:
- Only works when SMRT objects are registered before database initialization
- Table names must match SMRT object table names (pluralized snake_case)
- JSON files must be named to match table names (e.g., `organizations.json` → `organizations` table)

**Debugging**:
```typescript
// Enable console logging to see SMRT schema detection
// Look for: "[json-adapter] Creating {table} with SMRT schema definition"
// Or: "[json-adapter] Skipping {table} - will be created by SMRT framework"
```

### Template Literal Queries (Recommended)

Template literal queries provide safe parameter binding with an intuitive syntax. The package automatically handles database-specific placeholder formats.

```typescript
// Get a single value (first column of first row)
const userCount = await db.pluck`SELECT COUNT(*) FROM users WHERE active = ${true}`;
const userCount2 = await db.ox`SELECT COUNT(*) FROM users WHERE active = ${true}`; // alias

// Get a single record (first row as object)
const user = await db.single`SELECT * FROM users WHERE id = ${userId}`;
const user2 = await db.oO`SELECT * FROM users WHERE id = ${userId}`; // alias

// Get multiple records (array of objects)
const activeUsers = await db.many`SELECT * FROM users WHERE status = ${'active'}`;
const activeUsers2 = await db.oo`SELECT * FROM users WHERE status = ${'active'}`; // alias

// Execute without returning results
await db.execute`UPDATE users SET last_login = ${new Date()} WHERE id = ${userId}`;
await db.xx`UPDATE users SET last_login = ${new Date()} WHERE id = ${userId}`; // alias
```

**Query Method Naming Convention**:
- `many` / `oo` → (o)bjective-(o)bjects: returns multiple rows
- `single` / `oO` → (o)bjective-(O)bject: returns a single row
- `pluck` / `ox` → (o)bjective-(x): returns a single value
- `execute` / `xx` → e(x)ecute-e(x)ecute: executes without returning results

### Raw Query Operations

```typescript
// Execute raw SQL with parameters
const { rows, rowCount } = await db.query(
  'SELECT * FROM users WHERE status = ? AND created_at > ?',
  ['active', '2023-01-01']
);

// Alternative parameter format
const result = await db.query(
  'INSERT INTO users (id, name, email) VALUES (?, ?, ?)',
  'user123', 'John Doe', 'john@example.com'
);
```

### Object-Relational Methods

```typescript
// Insert single record
await db.insert('users', {
  id: 'user123',
  name: 'John Doe',
  email: 'john@example.com',
  created_at: new Date().toISOString()
});

// Insert multiple records (batch)
await db.insert('users', [
  { id: 'user1', name: 'Alice', email: 'alice@example.com' },
  { id: 'user2', name: 'Bob', email: 'bob@example.com' }
]);

// Get single record by criteria
const user = await db.get('users', { id: 'user123' });

// List records with complex criteria
const users = await db.list('users', {
  status: 'active',
  'created_at >': '2023-01-01'
});

// Update records
await db.update('users', 
  { id: 'user123' },           // where criteria
  { last_login: new Date().toISOString() }  // data to update
);

// Get or insert (upsert pattern)
const user = await db.getOrInsert('users',
  { email: 'new@example.com' }, // where criteria
  { id: 'newuser', name: 'New User', email: 'new@example.com' } // data to insert
);

// Upsert (insert or update on conflict)
await db.upsert('users', ['email'], {
  email: 'user@example.com',
  name: 'John Doe',
  updated_at: new Date().toISOString()
});
```

### UPSERT Operations

The `upsert()` method provides database-agnostic UPSERT functionality using each adapter's native SQL syntax. This fixes Issue #226 (DuckDB compatibility) by letting each adapter handle its own ON CONFLICT syntax.

```typescript
// Basic upsert on single column
await db.upsert('users', ['email'], {
  id: 'user123',
  email: 'user@example.com',
  name: 'John Doe',
  updated_at: new Date().toISOString()
});
// If email exists: updates the record
// If email doesn't exist: inserts new record

// Upsert with composite unique constraint
await db.upsert('posts', ['slug', 'context'], {
  id: 'post123',
  slug: 'my-post',
  context: '/blog',
  title: 'Updated Title',
  content: 'Updated content'
});
// Matches on (slug='my-post' AND context='/blog')
// If match found: updates title and content
// If not found: inserts new record

// Upsert in SMRT framework (automatic conflict resolution)
class Article extends SmrtObject {
  title: string = '';
  content: string = '';
}

const article = new Article({
  slug: 'my-article',
  context: '/blog',
  title: 'My Article',
  content: 'Article content'
});

// Saves using db.upsert() with (slug, context) as conflict columns
await article.save();
```

**Key Features**:
- **Per-Adapter Implementation**: Each database adapter uses its native UPSERT syntax
- **Composite Keys**: Support for multi-column unique constraints
- **Transaction Support**: Works within transaction contexts
- **Type Safe**: Returns `QueryResult` with operation type and affected rows

**Adapter-Specific SQL**:
```typescript
// SQLite/DuckDB: ON CONFLICT with excluded.column
INSERT INTO users (id, email, name) VALUES (?, ?, ?)
ON CONFLICT(email) DO UPDATE SET
  id = excluded.id,
  name = excluded.name

// PostgreSQL: ON CONFLICT with numbered placeholders
INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
ON CONFLICT(email) DO UPDATE SET
  id = $1,
  name = $3

// JSON Adapter: Same as DuckDB, with write strategy validation
```

**Important Notes**:
- Conflict columns must have a UNIQUE constraint or be PRIMARY KEY
- All columns in data are updated on conflict, not just changed ones
- For partial updates, use `db.update()` instead
- Returns `{ operation: 'upsert', affected: number }`

### Advanced Query Building

```typescript
import { buildWhere } from '@have/sql';

// Build complex WHERE clauses
const { sql, values } = buildWhere({
  status: 'active',                    // equals (default)
  'price >': 100,                     // greater than
  'stock <=': 5,                      // less than or equal
  'category in': ['electronics', 'books'], // IN clause
  'name like': '%shirt%',             // LIKE pattern matching
  'deleted_at': null,                 // IS NULL
  'updated_at !=': null               // IS NOT NULL
});

// Use in queries
const products = await db.many`SELECT * FROM products ${sql}`;
```

### Table Interface

```typescript
// Create table-specific interface for cleaner code
const usersTable = db.table('users');

// Use table methods
await usersTable.insert({ id: 'user1', name: 'Alice' });
const user = await usersTable.get({ id: 'user1' });
const activeUsers = await usersTable.list({ status: 'active' });
```

### Schema Synchronization

#### Legacy SQL DDL Schema (String-based)

```typescript
import { syncSchema } from '@have/sql';

// Define schema as SQL DDL
const schemaSQL = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    status TEXT DEFAULT 'active',
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    title TEXT NOT NULL,
    content TEXT,
    published BOOLEAN DEFAULT false,
    created_at TEXT
  );
`;

// Synchronize schema (creates tables and adds missing columns)
await syncSchema({ db, schema: schemaSQL });

// Check if table exists
const exists = await db.tableExists('users');
```

#### Modern JSON Manifest Schema (Recommended)

The package now supports JSON manifest-based schema management with automatic dependency resolution:

```typescript
import { DatabaseSchemaManager } from '@have/sql';

// Define schema manifest
const manifest = {
  version: '1.0.0',
  timestamp: Date.now(),
  packageName: '@myapp/database',
  schemas: {
    users: {
      tableName: 'users',
      version: '1.0.0',
      packageName: '@myapp/database',
      dependencies: [],
      columns: {
        id: { type: 'TEXT', primaryKey: true },
        name: { type: 'TEXT', notNull: true },
        email: { type: 'TEXT', unique: true },
        status: { type: 'TEXT', defaultValue: "'active'" },
        created_at: { type: 'TEXT' }
      },
      indexes: [
        { name: 'idx_users_email', columns: ['email'], unique: true }
      ],
      triggers: [],
      foreignKeys: []
    },
    posts: {
      tableName: 'posts',
      version: '1.0.0',
      packageName: '@myapp/database',
      dependencies: ['users'], // Will be initialized after users
      columns: {
        id: { type: 'TEXT', primaryKey: true },
        user_id: { type: 'TEXT', notNull: true },
        title: { type: 'TEXT', notNull: true },
        content: { type: 'TEXT' },
        published: { type: 'BOOLEAN', defaultValue: 'false' }
      },
      indexes: [
        { name: 'idx_posts_user_id', columns: ['user_id'] }
      ],
      triggers: [],
      foreignKeys: [
        {
          column: 'user_id',
          referencesTable: 'users',
          referencesColumn: 'id',
          onDelete: 'CASCADE'
        }
      ]
    }
  },
  dependencies: []
};

// Initialize schemas with dependency resolution
await db.initializeSchemas({
  manifest,
  force: false,  // Set to true to recreate tables
  debug: true    // Enable debug logging
});

// Or use schema overrides to extend base schemas
await db.initializeSchemas({
  manifest: baseManifest,
  overrides: {
    users: customUserSchema  // Override specific schemas
  }
});
```

**Schema Management Features**:
- Automatic dependency resolution via topological sort
- Circular dependency detection
- Schema versioning and up-to-date checks
- Concurrent initialization locking
- Force recreation option
- Column, index, trigger, and foreign key support

### Vector Search with SQLite-VSS

```typescript
// Create vector search table
await db.execute`
  CREATE VIRTUAL TABLE IF NOT EXISTS document_embeddings USING vss0(
    id TEXT PRIMARY KEY,
    embedding(1536),
    content TEXT,
    metadata TEXT
  )
`;

// Insert embeddings
const embedding = new Float32Array(1536); // Your embedding vector
await db.execute`
  INSERT INTO document_embeddings (id, embedding, content, metadata) 
  VALUES (${docId}, ${embedding}, ${content}, ${JSON.stringify(metadata)})
`;

// Perform similarity search
const similarDocs = await db.many`
  SELECT 
    id, 
    content, 
    metadata,
    distance
  FROM document_embeddings 
  WHERE vss_search(embedding, ${queryEmbedding})
  ORDER BY distance 
  LIMIT ${limit}
`;

// Search with filters
const filteredResults = await db.many`
  SELECT d.*, v.distance
  FROM document_embeddings d
  JOIN (
    SELECT rowid, distance 
    FROM document_embeddings 
    WHERE vss_search(embedding, ${queryEmbedding})
    LIMIT 100
  ) v ON d.rowid = v.rowid
  WHERE JSON_EXTRACT(d.metadata, '$.category') = ${category}
  ORDER BY v.distance
  LIMIT ${limit}
`;
```

### Transaction Support

Both SQLite and PostgreSQL adapters support transactions with automatic rollback on errors:

```typescript
// Transaction automatically commits on success, rolls back on error
await db.transaction(async (tx) => {
  // All operations use the transaction context
  await tx.insert('users', userData);
  await tx.insert('profiles', profileData);
  await tx.update('accounts', { user_id: userId }, { balance: newBalance });

  // Template literal queries work too
  const user = await tx.single`SELECT * FROM users WHERE id = ${userId}`;

  // Any error will trigger automatic rollback
  if (!user) {
    throw new Error('User not found');
  }

  // Commits automatically when callback completes successfully
});
```

**Transaction Implementation Notes**:
- **SQLite**: Reuses the same client with BEGIN/COMMIT/ROLLBACK
- **PostgreSQL**: Gets a dedicated client from the pool for the transaction
- Both implementations provide the full `DatabaseInterface` within the transaction context

### Error Handling

The package provides structured error handling with context information via `DatabaseError` from `@have/utils`:

```typescript
import { DatabaseError } from '@have/utils';

try {
  await db.insert('users', invalidData);
} catch (error) {
  if (error instanceof DatabaseError) {
    console.error('Database operation failed:', error.message);
    console.error('Context:', error.context);

    // Access specific error details
    if (error.context.sql) {
      console.error('SQL:', error.context.sql);
      console.error('Values:', error.context.values);
    }

    if (error.context.table) {
      console.error('Table:', error.context.table);
    }

    // Original database error
    console.error('Original error:', error.context.originalError);
  }
}

// Transaction errors are caught and transaction is rolled back
try {
  await db.transaction(async (tx) => {
    await tx.insert('users', userData);
    await tx.insert('profiles', profileData);
  });
} catch (error) {
  // Transaction was automatically rolled back
  console.error('Transaction failed:', error.message);
}
```

**Error Context Fields**:
- `sql`: The SQL query that failed
- `values` or `args`: Parameter values used in the query
- `table`: Table name (for table-specific operations)
- `originalError`: The original error from the database driver

## Important Implementation Details and Gotchas

### Database Instance Detection

The `getDatabase()` function can accept either configuration options OR an existing database instance:

```typescript
// Pass configuration - creates new instance
const db1 = await getDatabase({ type: 'sqlite', url: ':memory:' });

// Pass existing instance - returns it unchanged
const db2 = await getDatabase(db1); // Returns db1

// This allows flexible function signatures that work with both
async function doWork(dbOrConfig: DatabaseInterface | GetDatabaseOptions) {
  const db = await getDatabase(dbOrConfig); // Works with both!
  // ...
}
```

### LibSQL Client Import Strategy

The SQLite adapter uses a special import strategy to avoid bundling issues:

```typescript
// Uses @vite-ignore to prevent Vite from bundling the client
const libsqlClient = '@libsql/client';
const { createClient } = await import(/* @vite-ignore */ libsqlClient);
```

This ensures proper Node.js runtime resolution for in-memory databases.

### buildWhere() Placeholder Offset

The `buildWhere()` utility accepts a `startIndex` parameter for PostgreSQL:

```typescript
// SQLite - no offset needed (uses ?)
const { sql, values } = buildWhere({ status: 'active' });
// sql: "WHERE status = $1"

// PostgreSQL - specify starting index
const { sql, values } = buildWhere({ status: 'active' }, 5);
// sql: "WHERE status = $5"
// Useful when building queries with existing parameters
```

### Schema Sync Parsing Limitations

The legacy `syncSchema()` function has specific parsing requirements:

- CREATE TABLE statements must match the regex pattern: `/CREATE TABLE (IF NOT EXISTS )?(\w+) \(([\s\S]+)\)/i`
- Columns must be comma-newline separated (`,\n`)
- Column definitions must match: `/(\w+)\s+(\w+[^,]*)/`
- Constraint keywords (PRIMARY, FOREIGN, UNIQUE, CHECK, CONSTRAINT) are skipped during column detection

**Recommendation**: Use JSON manifest-based schema management for complex schemas.

### Transaction Client Handling

**PostgreSQL** transactions acquire a dedicated client from the pool:
- Client is acquired at transaction start
- Released in `finally` block after commit/rollback
- Proper cleanup even if errors occur

**SQLite** transactions reuse the same client:
- Uses BEGIN/COMMIT/ROLLBACK on the existing connection
- No separate transaction client needed

### Environment Variables for PostgreSQL

The PostgreSQL adapter checks these environment variables as defaults:

```typescript
SQLOO_URL       // Connection string (takes precedence)
SQLOO_DATABASE  // Database name
SQLOO_HOST      // Host (default: 'localhost')
SQLOO_USER      // Username
SQLOO_PASSWORD  // Password
SQLOO_PORT      // Port (default: 5432)
```

Options passed to `getDatabase()` override environment variables.

### Type Coercion Differences

**SQLite** (via LibSQL):
- Returns numbers as numbers
- Returns booleans as 0/1
- Returns NULL as null
- All column names preserved as-is

**PostgreSQL** (via node-postgres):
- Has built-in type parsers for common PostgreSQL types
- Automatically parses dates, arrays, JSON
- Can be configured with custom type parsers

## Dependencies

The package has the following dependencies:

### Internal Dependencies
- `@have/utils`: For shared utilities and `DatabaseError` error handling

### External Dependencies
- `@libsql/client` (^0.14.0): LibSQL client for SQLite compatibility with extensions and remote databases
- `sqlite-vss` (^0.1.2): Vector similarity search for SQLite databases
- `pg` (^8.13.1): PostgreSQL client for Node.js with connection pooling

### Development Dependencies
- `@types/node` (^24.0.0): TypeScript definitions for Node.js
- `@types/pg` (^8.11.10): TypeScript definitions for PostgreSQL client
- `typescript` (^5.7.3): TypeScript compiler
- `vite` (7.1.3): Build tool
- `vite-plugin-dts` (4.3.0): TypeScript declaration file generation
- `vitest` (^3.2.4): Testing framework for unit and integration tests

## Development Guidelines

### Database-Agnostic Development

When adding new features:

1. **Maintain API consistency** across SQLite and PostgreSQL implementations
2. **Handle parameter differences** (? vs $1, $2... placeholders)
3. **Account for type differences** between database engines
4. **Test on both databases** to ensure compatibility
5. **Document database-specific limitations** when they exist

### Query Safety and Security

- **Always use parameterized queries** - Never interpolate user input directly into SQL
- **Validate table and column names** when dynamically generating SQL
- **Use buildWhere utility** for complex conditions instead of string concatenation
- **Sanitize file paths** for SQLite databases to prevent path traversal
- **Use prepared statements** for repeated queries when possible

### Performance Optimization

```typescript
// Good: Batch inserts for multiple records
await db.insert('logs', batchData);

// Good: Use indexes for frequently queried columns
await db.execute`CREATE INDEX idx_users_email ON users(email)`;

// Good: Use transactions for related operations
await db.execute`BEGIN TRANSACTION`;
try {
  await db.insert('orders', orderData);
  await db.insert('order_items', itemsData);
  await db.execute`COMMIT`;
} catch (error) {
  await db.execute`ROLLBACK`;
  throw error;
}

// Good: Use appropriate LIMIT clauses
const recentPosts = await db.many`
  SELECT * FROM posts 
  ORDER BY created_at DESC 
  LIMIT 10
`;
```

### Vector Search Optimization

```typescript
// Optimize embedding storage
const optimizedEmbedding = new Float32Array(embedding).buffer;

// Use appropriate distance metrics
await db.execute`
  CREATE VIRTUAL TABLE embeddings USING vss0(
    id TEXT PRIMARY KEY,
    embedding(384) FLOAT  -- Use smaller dimensions when possible
  )
`;

// Batch vector inserts for better performance
const embeddings = documents.map(doc => ({
  id: doc.id,
  embedding: doc.vector,
  content: doc.text
}));
await db.insert('embeddings', embeddings);
```

### Testing

The package includes comprehensive tests for verifying database operations:

```bash
npm test              # Run all tests once
npm run test:watch    # Run tests in watch mode
npm run test:sqlite   # Run only SQLite tests
npm run test:postgres # Run only PostgreSQL tests
```

Tests use in-memory databases and mocked connections to avoid external dependencies.

### Building

Build the package with target-specific configurations:

```bash
npm run build        # Build for Node.js
npm run build:watch  # Build in watch mode
npm run clean        # Clean build artifacts
```

### Best Practices

#### Connection Management
- **Reuse database connections** when possible
- **Use connection pooling** for PostgreSQL in high-traffic applications
- **Handle connection errors gracefully** with retry logic
- **Close connections** properly to prevent resource leaks

#### Schema Design
- **Use consistent naming conventions** (snake_case for columns)
- **Include created_at and updated_at** timestamp fields
- **Add appropriate indexes** for query performance
- **Use foreign key constraints** to maintain data integrity
- **Plan for schema evolution** with migration strategies

#### Data Types
- **Use TEXT for IDs** to support UUIDs and flexible identifiers
- **Store dates as ISO strings** for cross-database compatibility
- **Use JSON columns** for flexible metadata storage
- **Normalize vector dimensions** for consistent similarity search

#### Error Handling
- **Catch and handle database-specific errors** appropriately
- **Provide meaningful error messages** with context
- **Log query details** for debugging (excluding sensitive data)
- **Implement retry logic** for transient connection errors

## API Documentation

The @have/sql package generates comprehensive API documentation in both HTML and markdown formats using TypeDoc:

### Generated Documentation Formats

**HTML Documentation** (recommended for browsing):
- Generated in `docs/` directory for public website
- Full API reference with interactive navigation
- Cross-linked type definitions and examples
- Accessible via development server at `http://localhost:3030/`

**Markdown Documentation** (great for development):
- Generated in `packages/sql/docs/` directory
- Markdown format perfect for IDE integration
- Accessible via development server at `http://localhost:3030/packages/sql/`

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
2. **Local Browsing**: Access HTML docs at `http://localhost:3030/` or markdown at `http://localhost:3030/packages/sql/`
3. **IDE Integration**: Point your editor to `packages/sql/docs/` for offline markdown reference

The documentation includes complete API coverage, usage examples, and cross-references to related HAVE SDK packages.

## Documentation Links

Always reference the latest documentation when planning database solutions, as these libraries frequently add new features, performance improvements, and vector search capabilities:

### Core Libraries

#### @libsql/client (LibSQL/Turso)
- **Official Documentation**: https://docs.turso.tech/libsql
- **TypeScript SDK**: https://docs.turso.tech/sdk/ts
- **API Reference**: https://docs.turso.tech/sdk/ts/reference
- **Authentication**: https://docs.turso.tech/sdk/authentication
- **Examples**: https://github.com/tursodatabase/libsql-client-ts/tree/main/packages/libsql-client/examples
- **NPM Package**: https://www.npmjs.com/package/@libsql/client

#### sqlite-vss (Vector Similarity Search)
- **Main Repository**: https://github.com/asg017/sqlite-vss
- **Documentation**: https://github.com/asg017/sqlite-vss/blob/main/docs.md
- **API Reference**: https://github.com/asg017/sqlite-vss/blob/main/docs/api.md
- **⚠️ Migration Note**: sqlite-vss is not in active development. Consider migrating to [sqlite-vec](https://github.com/asg017/sqlite-vec) for new projects
- **Migration Guide**: https://alexgarcia.xyz/blog/2024/building-new-vector-search-sqlite/

#### pg (node-postgres)
- **Official Documentation**: https://node-postgres.com/
- **Features**: https://node-postgres.com/features
- **API - Client**: https://node-postgres.com/apis/client
- **API - Pool**: https://node-postgres.com/apis/pool
- **API - Result**: https://node-postgres.com/apis/result
- **GitHub Repository**: https://github.com/brianc/node-postgres
- **NPM Package**: https://www.npmjs.com/package/pg

### Expert Agent Instructions

When working with @have/sql:

1. **Always check latest documentation** before implementing solutions using WebFetch tool
2. **Stay current with LibSQL features** - Turso frequently adds new capabilities
3. **Monitor vector search evolution** - sqlite-vss → sqlite-vec migration path
4. **Review PostgreSQL updates** for new data types and performance features
5. **Check for breaking changes** in major version updates
6. **Look for new connection options** and authentication methods

Example workflow:
```typescript
// Before implementing vector search, check latest docs
await WebFetch.get('https://github.com/asg017/sqlite-vss/blob/main/docs.md');
// Then implement with current best practices
await db.execute`CREATE VIRTUAL TABLE embeddings USING vss0(...)`;
```

### Database-Specific Considerations

#### SQLite/LibSQL
- **Single-writer limitation** - Design for read-heavy workloads
- **WAL mode benefits** - Better concurrency for read operations
- **Extension support** - Vector search (sqlite-vss), full-text search, JSON functions
- **Encryption at rest** - Available with LibSQL using encryptionKey parameter
- **Remote databases** - Turso provides hosted LibSQL with global replication
- **Embedded replicas** - Sync remote databases locally for better performance

#### PostgreSQL
- **Connection pooling** - Essential for production applications
- **JSON/JSONB support** - Native JSON operations and indexing
- **Array data types** - First-class support for array columns
- **Full-text search** - Built-in text search capabilities
- **Vector extensions** - pgvector for vector similarity search

This package provides a robust foundation for data persistence in the HAVE SDK, designed to be lightweight yet powerful enough for AI-driven applications requiring both traditional relational operations and modern vector search capabilities.

## Quick Reference

### Complete DatabaseInterface Methods

```typescript
interface DatabaseInterface {
  // Raw database client (LibSQL Client or pg.Pool)
  client: any;

  // Object-relational methods
  insert(table: string, data: Record<string, any> | Record<string, any>[]): Promise<QueryResult>;
  get(table: string, where: Record<string, any>): Promise<Record<string, any> | null>;
  list(table: string, where: Record<string, any>): Promise<Record<string, any>[]>;
  update(table: string, where: Record<string, any>, data: Record<string, any>): Promise<QueryResult>;
  upsert(table: string, conflictColumns: string[], data: Record<string, any>): Promise<QueryResult>;
  getOrInsert(table: string, where: Record<string, any>, data: Record<string, any>): Promise<Record<string, any>>;

  // Table interface factory
  table(name: string): TableInterface;

  // Template literal queries
  many(strings: TemplateStringsArray, ...vars: any[]): Promise<Record<string, any>[]>;
  single(strings: TemplateStringsArray, ...vars: any[]): Promise<Record<string, any> | null>;
  pluck(strings: TemplateStringsArray, ...vars: any[]): Promise<any>;
  execute(strings: TemplateStringsArray, ...vars: any[]): Promise<void>;

  // Template literal query aliases
  oo(strings: TemplateStringsArray, ...vars: any[]): Promise<Record<string, any>[]>;
  oO(strings: TemplateStringsArray, ...vars: any[]): Promise<Record<string, any> | null>;
  ox(strings: TemplateStringsArray, ...vars: any[]): Promise<any>;
  xx(strings: TemplateStringsArray, ...vars: any[]): Promise<void>;

  // Raw query execution
  query(sql: string, ...vars: any[]): Promise<{ rows: Record<string, any>[]; rowCount: number }>;

  // Schema management
  tableExists(table: string): Promise<boolean>;
  syncSchema?(schema: string): Promise<void>;
  initializeSchemas?(options: SchemaInitializationOptions): Promise<void>;

  // Transaction support
  transaction?<T>(callback: (tx: DatabaseInterface) => Promise<T>): Promise<T>;
}
```

### Exported Functions and Classes

```typescript
// Main exports from @have/sql
export {
  getDatabase,           // Factory function for database instances
  syncSchema,            // Legacy SQL DDL schema sync
  tableExists,           // Check if table exists
  buildWhere,            // Build WHERE clause from object
  escapeSqlValue,        // Escape values for SQL
  validateColumnName,    // Validate column names
  DatabaseSchemaManager  // JSON manifest schema manager
};

// Type exports
export type {
  DatabaseInterface,
  TableInterface,
  QueryResult,
  SchemaManifest,
  SchemaDefinition,
  ColumnDefinition,
  IndexDefinition,
  TriggerDefinition,
  ForeignKeyDefinition,
  SchemaInitializationOptions,
  SchemaInitializationResult
};
```

### Common Usage Patterns

```typescript
// Pattern: Safe dynamic queries with buildWhere
import { buildWhere } from '@have/sql';

const filters = {
  'status': 'active',
  'price >=': minPrice,
  'price <': maxPrice,
  'category in': ['electronics', 'books'],
  'deleted_at': null
};

const { sql: whereClause, values } = buildWhere(filters);
const products = await db.many`SELECT * FROM products ${whereClause}`;

// Pattern: Batch inserts for performance
const records = Array.from({ length: 1000 }, (_, i) => ({
  id: `item-${i}`,
  name: `Item ${i}`,
  value: Math.random() * 100
}));
await db.insert('items', records);

// Pattern: Upsert (get or insert)
const user = await db.getOrInsert(
  'users',
  { email: 'user@example.com' },
  { id: generateId(), email: 'user@example.com', name: 'New User' }
);

// Pattern: Table-scoped operations
const usersTable = db.table('users');
await usersTable.insert({ id: '1', name: 'Alice' });
const alice = await usersTable.get({ id: '1' });
const allUsers = await usersTable.list({});

// Pattern: Complex transaction with error handling
try {
  const result = await db.transaction(async (tx) => {
    const order = await tx.single`
      INSERT INTO orders (id, user_id, total)
      VALUES (${orderId}, ${userId}, ${total})
      RETURNING *
    `;

    for (const item of items) {
      await tx.insert('order_items', {
        order_id: orderId,
        product_id: item.productId,
        quantity: item.quantity
      });
    }

    await tx.execute`
      UPDATE users
      SET order_count = order_count + 1
      WHERE id = ${userId}
    `;

    return order;
  });
  console.log('Order created:', result);
} catch (error) {
  console.error('Transaction failed, all changes rolled back:', error);
}

// Pattern: Vector search with metadata filtering
const results = await db.many`
  SELECT d.*, v.distance
  FROM document_embeddings d
  JOIN (
    SELECT rowid, distance
    FROM document_embeddings
    WHERE vss_search(embedding, ${queryEmbedding})
    LIMIT 100
  ) v ON d.rowid = v.rowid
  WHERE JSON_EXTRACT(d.metadata, '$.category') = ${category}
    AND JSON_EXTRACT(d.metadata, '$.language') = ${language}
  ORDER BY v.distance
  LIMIT ${limit}
`;
```

### Testing Utilities

```typescript
// In-memory database for tests
import { getDatabase } from '@have/sql';

const testDb = await getDatabase({ type: 'sqlite', url: ':memory:' });

// Create test schema
await testDb.execute`
  CREATE TABLE test_table (
    id TEXT PRIMARY KEY,
    data TEXT
  )
`;

// Run tests...

// Cleanup (drop tables if needed)
await testDb.execute`DROP TABLE IF EXISTS test_table`;
```

### Performance Tips

1. **Use batch inserts** for multiple records: `db.insert('table', arrayOfRecords)`
2. **Create indexes** on frequently queried columns: `CREATE INDEX idx_name ON table(column)`
3. **Use transactions** for multiple related operations to ensure atomicity
4. **Prefer template literals** (`db.many`) over object methods for complex queries
5. **Use buildWhere()** for dynamic filtering instead of string concatenation
6. **Enable WAL mode** for SQLite to improve concurrency: `PRAGMA journal_mode=WAL`
7. **Use connection pooling** for PostgreSQL (automatically handled by pg.Pool)
8. **Consider prepared statements** for frequently executed queries (via raw `query()` method)