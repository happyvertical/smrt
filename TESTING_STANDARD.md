# SMRT Testing Standard

This document outlines testing standards and best practices for the SMRT framework.

## Philosophy

- **Use real resources over mocks**: Prefer in-memory databases and temp files over mock objects
- **Tests as documentation**: Tests should read like documentation and demonstrate usage patterns
- **BDD/TDD for bug fixes**: Write failing tests before fixing bugs
- **README parity**: All README code examples must have corresponding tests

## Release Gate For Touched Packages

When a feature or refactor touches a package, the testing bar applies to the
entire touched package, not just the new tests added for the change.

- **Full touched-package suite must pass**: targeted regression tests are required, but they do not replace the package's full `vitest` suite
- **Fix or remove stale tests as part of the work**: if older tests drift from current behavior, bring them up to date before calling the package release-ready
- **Skipped tests must be intentional**: only skip for explicit environment gates or intentionally expensive cases, and keep the reason obvious in the test source
- **Generated surfaces need tests**: if SMRT-generated REST/CLI/MCP behavior changes, add or update tests that exercise the generated contract
- **Coverage must be wired in**: every actively developed package should enable Vitest coverage reporting in `vitest.config.ts`

## Running Tests

### ⚠️ CRITICAL: Use the Vitest Plugin

**The vitest plugin is required for all SMRT projects.** It automatically generates manifests at startup.

```bash
# ✅ CORRECT - vitest plugin auto-generates manifest
npx vitest
npx vitest run
npm test

# ⚠️ DEPRECATED - still works but not needed
smrt test
```

**Your vitest.config.ts MUST include the plugin:**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';

export default defineConfig({
  plugins: [smrtVitestPlugin()],
  test: {
    globals: true,
    environment: 'node',
  },
});
```

Without the plugin, tests fail with errors like:
```
Cannot generate schema for unregistered class 'Council'.
No field metadata found for 'Document'.
```

**Note on watch mode**: The manifest is generated once at vitest startup. If you add new classes or fields while vitest is running in watch mode, restart vitest to pick up the changes.

### Watch Mode

```bash
npm run test:watch
# or
npx vitest --watch
```

### Individual Test Files

```bash
# With the plugin, just run the specific test directly
npx vitest run src/specific-test.test.ts
```

## Test File Structure

### Standard Test Template

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createIsolatedTestDb } from '@happyvertical/smrt-vitest';
import { MyObject, MyCollection } from './my-object.js';

describe('MyObject', () => {
  let collection: MyCollection;

  beforeEach(async () => {
    // Creates isolated in-memory SQLite database
    const db = await createIsolatedTestDb();
    collection = await MyCollection.create({
      persistence: { type: 'sql', db }
    });
  });

  describe('basic CRUD operations', () => {
    it('should create and save object', async () => {
      const obj = await collection.create({
        name: 'Test',
        value: 42
      });
      await obj.save();

      const loaded = await collection.get({ id: obj.id });
      expect(loaded?.name).toBe('Test');
      expect(loaded?.value).toBe(42);
    });

    it('should update object', async () => {
      const obj = await collection.create({ name: 'Initial' });
      await obj.save();

      obj.name = 'Updated';
      await obj.save();

      const loaded = await collection.get({ id: obj.id });
      expect(loaded?.name).toBe('Updated');
    });

    it('should delete object', async () => {
      const obj = await collection.create({ name: 'Delete Me' });
      await obj.save();

      await obj.delete();

      const loaded = await collection.get({ id: obj.id });
      expect(loaded).toBeUndefined();
    });
  });

  describe('querying', () => {
    it('should filter by field', async () => {
      await collection.create({ name: 'Active', status: 'active' }).then(o => o.save());
      await collection.create({ name: 'Inactive', status: 'inactive' }).then(o => o.save());

      const active = await collection.list({ where: { status: 'active' } });
      expect(active).toHaveLength(1);
      expect(active[0].name).toBe('Active');
    });

    it('should support comparison operators', async () => {
      await collection.create({ price: 50 }).then(o => o.save());
      await collection.create({ price: 150 }).then(o => o.save());
      await collection.create({ price: 250 }).then(o => o.save());

      const expensive = await collection.list({ where: { 'price >': 100 } });
      expect(expensive).toHaveLength(2);
    });

    it('should support IN operator', async () => {
      await collection.create({ category: 'A' }).then(o => o.save());
      await collection.create({ category: 'B' }).then(o => o.save());
      await collection.create({ category: 'C' }).then(o => o.save());

      const selected = await collection.list({
        where: { category: ['A', 'B'] }
      });
      expect(selected).toHaveLength(2);
    });
  });
});
```

## Isolated Test Databases

### Using `createIsolatedTestDb()`

The `@happyvertical/smrt-vitest` package provides `createIsolatedTestDb()` for creating isolated in-memory SQLite databases:

```typescript
import { createIsolatedTestDb } from '@happyvertical/smrt-vitest';

beforeEach(async () => {
  const db = await createIsolatedTestDb();
  collection = await MyCollection.create({
    persistence: { type: 'sql', db }
  });
});
```

**Benefits**:
- **Isolation**: Each test suite gets its own database
- **Speed**: In-memory databases are fast
- **Cleanup**: Automatically cleaned up after tests
- **No mocking**: Use real database operations

### Alternative: Temp Files

For testing file operations or when you need a file-based database:

```typescript
import { describe, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

describe('File-based tests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should work with temp files', async () => {
    const dbPath = join(tempDir, 'test.db');
    const collection = await MyCollection.create({
      persistence: { type: 'sql', url: dbPath }
    });
    // Test operations...
  });
});
```

## Testing Relationships

### Foreign Keys

```typescript
describe('relationships', () => {
  let authorCollection: AuthorCollection;
  let bookCollection: BookCollection;

  beforeEach(async () => {
    const db = await createIsolatedTestDb();
    authorCollection = await AuthorCollection.create({
      persistence: { type: 'sql', db }
    });
    bookCollection = await BookCollection.create({
      persistence: { type: 'sql', db }
    });
  });

  it('should load related objects', async () => {
    const author = await authorCollection.create({ name: 'Author' });
    await author.save();

    const book = await bookCollection.create({
      title: 'Book',
      authorId: author.id
    });
    await book.save();

    await book.loadRelated('authorId');
    const loadedAuthor = book.getRelated('authorId');
    expect(loadedAuthor?.name).toBe('Author');
  });

  it('should support eager loading', async () => {
    const author = await authorCollection.create({ name: 'Author' });
    await author.save();

    await bookCollection.create({ title: 'Book 1', authorId: author.id }).then(b => b.save());
    await bookCollection.create({ title: 'Book 2', authorId: author.id }).then(b => b.save());

    const books = await bookCollection.list({
      include: ['authorId']
    });

    expect(books).toHaveLength(2);
    for (const book of books) {
      const author = book.getRelated('authorId');
      expect(author).toBeDefined();
      expect(author?.name).toBe('Author');
    }
  });
});
```

## Testing STI (Single Table Inheritance)

```typescript
describe('STI polymorphism', () => {
  let eventCollection: EventCollection;

  beforeEach(async () => {
    const db = await createIsolatedTestDb();
    eventCollection = await EventCollection.create({
      persistence: { type: 'sql', db }
    });
  });

  it('should save and load correct subclass', async () => {
    const meeting = await eventCollection.create({
      _meta_type: '@my-package:Meeting',
      title: 'Team Standup',
      location: 'Room A'
    });
    await meeting.save();

    const loaded = await eventCollection.get({ id: meeting.id });
    expect(loaded).toBeInstanceOf(Meeting);
    expect(loaded?.title).toBe('Team Standup');
    expect(loaded?.location).toBe('Room A');
  });

  it('should filter by _meta_type', async () => {
    await eventCollection.create({
      _meta_type: '@my-package:Meeting',
      title: 'Meeting 1'
    }).then(e => e.save());

    await eventCollection.create({
      _meta_type: '@my-package:Conference',
      title: 'Conference 1'
    }).then(e => e.save());

    const meetings = await eventCollection.list({
      where: { _meta_type: '@my-package:Meeting' }
    });

    expect(meetings).toHaveLength(1);
    expect(meetings[0]).toBeInstanceOf(Meeting);
  });
});
```

## Testing AI-Powered Methods

When testing AI-powered methods (`is()`, `do()`), use test mode to avoid API calls:

```typescript
describe('AI operations', () => {
  it('should validate with is()', async () => {
    const doc = await collection.create({
      title: 'Test Doc',
      content: 'This is a test document with enough words to be quality content.'
    });

    // In tests, you may want to mock AI responses
    // Or use a test AI provider that returns deterministic results
    const isQuality = await doc.is('This document is high quality');
    expect(typeof isQuality).toBe('boolean');
  });

  it('should transform with do()', async () => {
    const doc = await collection.create({
      title: 'Test',
      content: 'Test content'
    });

    const summary = await doc.do('Create a summary');
    expect(typeof summary).toBe('string');
  });
});
```

**Note**: Consider adding a test mode flag or mock AI provider to avoid making real API calls during tests.

## Testing Error Conditions

```typescript
describe('error handling', () => {
  it('should throw on invalid data', async () => {
    await expect(async () => {
      await collection.create({ invalid: 'field' });
    }).rejects.toThrow();
  });

  it('should validate required fields', async () => {
    await expect(async () => {
      const obj = await collection.create({});
      await obj.save();
    }).rejects.toThrow();
  });

  it('should handle duplicate IDs', async () => {
    const obj1 = await collection.create({ id: 'duplicate' });
    await obj1.save();

    await expect(async () => {
      const obj2 = await collection.create({ id: 'duplicate' });
      await obj2.save();
    }).rejects.toThrow();
  });
});
```

## Testing Code Generation

### Testing CLI Commands

```typescript
import { describe, it, expect } from 'vitest';
import { CLIGenerator } from '@happyvertical/smrt-core/codegen';

describe('CLI generation', () => {
  it('should generate list command', () => {
    const generator = new CLIGenerator({
      className: 'Product',
      packageName: '@test/package'
    });

    const code = generator.generateCommand('list');
    expect(code).toContain('list');
    expect(code).toContain('Product');
  });
});
```

### Testing API Generation

```typescript
describe('API generation', () => {
  it('should generate REST endpoint', () => {
    const generator = new APIGenerator({
      className: 'Product',
      packageName: '@test/package'
    });

    const code = generator.generateEndpoint('list');
    expect(code).toContain('GET');
    expect(code).toContain('/products');
  });
});
```

## BDD/TDD for Bug Fixes

When fixing a bug, follow Test-Driven Development:

1. **Write a failing test** that reproduces the bug
2. **Run the test** to confirm it fails
3. **Fix the bug** in the implementation
4. **Run the test** to confirm it passes
5. **Refactor** if needed, keeping tests passing

**Example**:

```typescript
describe('Bug #123: WHERE clause with null', () => {
  it('should handle null equality checks', async () => {
    // Reproduce the bug with a test
    await collection.create({ name: 'Active', deleted_at: null }).then(o => o.save());
    await collection.create({ name: 'Deleted', deleted_at: new Date() }).then(o => o.save());

    const active = await collection.list({
      where: { deleted_at: null }
    });

    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('Active');
  });
});
```

## README Example Parity

**Every code example in a README must have a corresponding test.**

This ensures:
- Examples are always accurate
- Breaking changes are caught
- Documentation stays in sync with code

**Template**:

```typescript
describe('README examples', () => {
  it('should match Quick Start example', async () => {
    // Copy-paste README example here and add assertions
    const collection = await MyCollection.create({
      persistence: { type: 'sql', url: ':memory:' }
    });

    const obj = await collection.create({ name: 'Test' });
    await obj.save();

    expect(obj.name).toBe('Test');
    expect(obj.id).toBeDefined();
  });
});
```

## Coverage Requirements

- **Coverage is required for active packages**: package `vitest.config.ts` files should enable coverage reporting so feature work can produce a report without extra setup
- **Minimum coverage**: 80% line coverage
- **Critical paths**: 100% coverage for core ORM operations
- **Error paths**: Test both success and failure cases
- **Edge cases**: Empty inputs, null values, boundary conditions
- **Document exclusions**: exclude generated files or non-product test harnesses deliberately, not by accident

## Running Coverage Reports

```bash
npm run test:coverage

# Or run coverage for a specific touched package
pnpm --filter @happyvertical/smrt-<package> exec vitest run --coverage
```

## Additional Resources

- [Vitest Documentation](https://vitest.dev/)
- [SMRT Testing Philosophy](./CLAUDE.md#testing-requirements)
- [packages/core/CLAUDE.md](./packages/core/CLAUDE.md) - Framework internals
- [WORKFLOW.md](./WORKFLOW.md) - Development workflows
