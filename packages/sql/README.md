# @have/sql

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Database interaction library with support for SQLite (including LibSQL/Turso), PostgreSQL, and DuckDB in the HAVE SDK.

## Overview

The `@have/sql` package provides a simple and consistent interface for interacting with SQL databases. It supports both SQLite/LibSQL and PostgreSQL with the same API, making it easy to develop locally with SQLite and deploy to production with PostgreSQL or Turso.

## Features

- **Unified API** for SQLite, LibSQL, PostgreSQL, and DuckDB
- **Template literal query interface** with automatic parameterization and shorthand aliases
- **DuckDB JSON support** for querying git-tracked JSON files with SQL
- **Vector search capabilities** with SQLite-VSS integration
- **LibSQL/Turso support** with remote connections and encryption
- **Type-safe query results** with comprehensive TypeScript support
- **Simple CRUD operations** with minimal boilerplate
- **Connection pooling** and efficient resource management
- **Transaction support** with automatic commit/rollback
- **Schema synchronization** utilities for automatic table creation and migrations
- **Query building utilities** for complex WHERE conditions
- **No ORM overhead** - just raw SQL with safety features

## Installation

```bash
# Install with npm
npm install @have/sql

# Or with yarn
yarn add @have/sql

# Or with bun
bun add @have/sql
```

## Usage

### Connecting to a Database

```typescript
import { getDatabase } from '@have/sql';

// Connect to SQLite (in-memory)
const sqliteDb = await getDatabase({
  type: 'sqlite',
  url: ':memory:', // In-memory database
});

// Connect to SQLite (file)
const fileDb = await getDatabase({
  type: 'sqlite',
  url: 'file:./my-database.sqlite',
});

// Connect to LibSQL/Turso (remote)
const tursoDb = await getDatabase({
  type: 'sqlite',
  url: 'libsql://your-database.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Connect to PostgreSQL
const pgDb = await getDatabase({
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'my_database',
  user: 'username',
  password: 'password',
});

// Connect to PostgreSQL via URL
const pgUrlDb = await getDatabase({
  type: 'postgres',
  url: 'postgresql://user:pass@localhost:5432/dbname',
});

// Connect to DuckDB (in-memory)
const duckDb = await getDatabase({
  type: 'duckdb',
  url: ':memory:',
  dataDir: './data', // Auto-register JSON files from this directory
  autoRegisterJSON: true,
  writeStrategy: 'none', // Read-only by default
});

// Connect to DuckDB (file-based)
const duckFileDb = await getDatabase({
  type: 'duckdb',
  url: 'my-database.duckdb',
  dataDir: './data',
  autoRegisterJSON: true,
  writeStrategy: 'immediate', // Auto-export changes to JSON files
});
```

### DuckDB-Specific Features

DuckDB provides unique capabilities for working with JSON files as data sources:

```typescript
// Auto-register JSON files as queryable tables
const db = await getDatabase({
  type: 'duckdb',
  url: ':memory:',
  dataDir: './data', // Scans this directory for .json files
  autoRegisterJSON: true,
  writeStrategy: 'none',
});

// If you have ./data/users.json and ./data/products.json,
// they're automatically available as tables
const users = await db.many`SELECT * FROM users WHERE active = ${true}`;
const products = await db.many`SELECT * FROM products WHERE price > ${100}`;

// Join across JSON files
const results = await db.many`
  SELECT u.name, p.title, o.total
  FROM users u
  JOIN orders o ON u.id = o.user_id
  JOIN products p ON o.product_id = p.id
  WHERE u.status = ${'active'}
`;

// Write-back strategies
// 'none' (default) - Read-only, perfect for git-tracked fixtures
// 'immediate' - Auto-export to JSON after insert/update
// 'manual' - Use exportTable() method for explicit control

const dbWithWrites = await getDatabase({
  type: 'duckdb',
  url: ':memory:',
  dataDir: './data',
  writeStrategy: 'manual',
});

await dbWithWrites.insert('users', {
  id: 'user-123',
  name: 'Alice',
  email: 'alice@example.com',
});

// Manually export to JSON file
await dbWithWrites.exportTable('users');
// Creates/updates ./data/users.json
```

#### Use Cases for DuckDB

- **Version-controlled datasets**: Track data changes in git alongside your code
- **Test fixtures**: SQL-queryable test data that's easy to review in pull requests
- **Configuration management**: Complex config files with relational queries
- **Analytics**: Run SQL queries over exported data without database setup
- **CI/CD pipelines**: Reproducible data for integration tests
- **Documentation**: Data samples that are both human and machine readable
```

### Executing Queries

The package provides template literal functions with both descriptive names and shorthand aliases:

- `many`/`oo` - Returns all rows from a query
- `single`/`oO` - Returns a single row
- `pluck`/`ox` - Returns a single value (first column of first row)
- `execute`/`xx` - Executes a statement (no return value)

```typescript
// Fetch all posts (using descriptive names)
const posts = await db.many`
  SELECT * FROM posts
  WHERE published = ${true}
  ORDER BY created_at DESC
`;

// Fetch a single post (using shorthand alias)
const post = await db.oO`
  SELECT * FROM posts
  WHERE id = ${postId}
`;

// Get a count (using descriptive name)
const count = await db.pluck`
  SELECT COUNT(*) FROM posts
  WHERE author = ${authorName}
`;
console.log(`Found ${count} posts by ${authorName}`);

// Execute a statement (using shorthand alias)
await db.xx`
  DELETE FROM posts
  WHERE id = ${postId}
`;

// Raw query with parameters
const { rows, rowCount } = await db.query(
  'SELECT * FROM posts WHERE status = ? AND created_at > ?',
  ['published', '2024-01-01']
);
```

### Using CRUD Helper Functions

```typescript
// Insert single record
const result = await db.insert('posts', {
  id: 'post-123',
  title: 'Hello World',
  content: 'This is my first post',
  author: 'Jane Doe',
  created_at: new Date().toISOString()
});

// Insert multiple records (batch)
await db.insert('posts', [
  { id: 'post-1', title: 'First Post', author: 'Alice' },
  { id: 'post-2', title: 'Second Post', author: 'Bob' }
]);

// Get a record by criteria
const post = await db.get('posts', { id: 'post-123' });

// List records with complex filters
const recentPosts = await db.list('posts', {
  author: 'Jane Doe',
  published: true,
  'created_at >': '2024-01-01'
});

// Update records
await db.update('posts',
  { id: 'post-123' }, // where criteria
  { title: 'Updated Title', updated_at: new Date().toISOString() } // data to set
);

// Get or insert (upsert pattern)
const user = await db.getOrInsert('users',
  { email: 'new@example.com' }, // search criteria
  { id: 'user-new', name: 'New User', email: 'new@example.com' } // data to insert if not found
);

// Create a table-specific helper
const postsTable = db.table('posts');
const post = await postsTable.get({ id: 'post-123' });
const newPost = await postsTable.insert({
  id: 'post-456',
  title: 'Another Post',
  content: 'More content here',
  author: 'John Smith'
});
```

### Using Transactions

```typescript
// Execute multiple operations in a transaction
await db.transaction(async (tx) => {
  // Use transaction object with the same API as db
  await tx.execute`
    INSERT INTO categories (name)
    VALUES (${categoryName})
  `;

  const categoryId = await tx.pluck`
    SELECT id FROM categories
    WHERE name = ${categoryName}
  `;

  await tx.execute`
    INSERT INTO posts (title, category_id, created_at)
    VALUES (${title}, ${categoryId}, ${new Date().toISOString()})
  `;

  // Transaction automatically commits if no errors
  // Or rolls back if any error is thrown
});

// Use CRUD operations within transactions
await db.transaction(async (tx) => {
  const user = await tx.insert('users', {
    id: 'user-123',
    email: 'user@example.com',
    name: 'John Doe'
  });

  await tx.insert('user_profiles', {
    user_id: 'user-123',
    bio: 'Software developer'
  });
});
```

### Advanced Query Building

```typescript
import { buildWhere } from '@have/sql';

// Build complex WHERE clauses with flexible operators
const { sql, values } = buildWhere({
  status: 'active',                    // equals (default)
  'price >': 100,                     // greater than
  'stock <=': 5,                      // less than or equal
  'category in': ['electronics', 'books'], // IN clause
  'name like': '%shirt%',             // LIKE pattern matching
  'deleted_at': null,                 // IS NULL
  'updated_at !=': null               // IS NOT NULL
});

// Use in template literal queries
const products = await db.many`SELECT * FROM products ${sql}`;
```

### Schema Synchronization

```typescript
import { syncSchema } from '@have/sql';

// Define schema as SQL DDL
const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
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
await syncSchema({ db, schema });

// Check if table exists
const exists = await db.tableExists('users');
```

### Vector Search with SQLite-VSS

```typescript
// Note: Vector search is only available with SQLite databases
// Create vector search table
await db.execute`
  CREATE VIRTUAL TABLE IF NOT EXISTS document_embeddings USING vss0(
    id TEXT PRIMARY KEY,
    embedding(1536),
    content TEXT
  )
`;

// Insert embeddings
const embedding = new Float32Array(1536); // Your embedding vector
await db.execute`
  INSERT INTO document_embeddings (id, embedding, content)
  VALUES (${docId}, ${embedding}, ${content})
`;

// Perform similarity search
const similarDocs = await db.many`
  SELECT id, content, distance
  FROM document_embeddings
  WHERE vss_search(embedding, ${queryEmbedding})
  ORDER BY distance
  LIMIT ${limit}
`;
```

## Important Notes

- **Always use parameterized queries** with template literals or the query method
- **Never use variables for table or column names** - only for values
- **Validate user input** before using in table/column names
- **Use transactions** for related operations that should be atomic
- **Keep SQL ANSI-compatible** when possible for database portability
- **Use appropriate indexes** for frequently queried columns
- **Handle connection errors** gracefully with proper error handling

## API Reference

See the [API documentation](https://happyvertical.github.io/sdk/modules/_have_sql.html) for detailed information on all available methods and options.

## License

This package is part of the HAVE SDK and is licensed under the MIT License - see the [LICENSE](../../LICENSE) file for details.