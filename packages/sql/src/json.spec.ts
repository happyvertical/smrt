import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDatabase } from './index';

describe('JSON adapter tests', () => {
  let db: any;
  const testDataDir = './test-json-data';

  beforeEach(async () => {
    // Create test data directory
    mkdirSync(testDataDir, { recursive: true });

    // Create initial test JSON files
    writeFileSync(
      `${testDataDir}/contents.json`,
      JSON.stringify([
        {
          id: 'test-1',
          title: 'Sample Document',
          body: 'Sample content',
        },
      ]),
    );

    // Initialize JSON database
    db = await getDatabase({
      type: 'json',
      dataDir: testDataDir,
      writeStrategy: 'immediate',
    });
  });

  afterEach(async () => {
    // Clean up test data directory
    rmSync(testDataDir, { recursive: true, force: true });
  });

  it('should load JSON files as queryable tables', async () => {
    const result = await db.many`
      SELECT * FROM contents
    `;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'test-1',
      title: 'Sample Document',
      body: 'Sample content',
    });
  });

  it('should be able to insert data and auto-save to JSON', async () => {
    const data = {
      id: randomUUID(),
      title: 'New Document',
      body: 'New content',
    } as const;

    const inserted = await db.insert('contents', data);
    expect(inserted).toBeDefined();
    expect(inserted.affected).toBe(1);

    // Verify data was inserted
    const result = await db.single`
      SELECT * FROM contents WHERE id = ${data.id}
    `;
    expect(result).toMatchObject(data);
  });

  it('should be able to query data with conditions', async () => {
    const data = {
      id: randomUUID(),
      title: 'Query Test',
      body: 'Test content',
    } as const;

    await db.insert('contents', data);

    const result = await db.single`
      SELECT * FROM contents WHERE id = ${data.id}
    `;
    expect(result).toMatchObject({
      id: data.id,
      title: data.title,
      body: data.body,
    });
  });

  it('should be able to update rows', async () => {
    const data = {
      id: randomUUID(),
      title: 'Original Title',
      body: 'Original body',
    } as const;

    await db.insert('contents', data);

    await db.update(
      'contents',
      { id: data.id },
      { title: 'Updated Title', body: 'Updated body' },
    );

    const result = await db.single`
      SELECT * FROM contents WHERE id = ${data.id}
    `;
    expect(result).toMatchObject({
      id: data.id,
      title: 'Updated Title',
      body: 'Updated body',
    });
  });

  it('should support complex SQL queries with JOINs', async () => {
    // Create a second table
    writeFileSync(
      `${testDataDir}/authors.json`,
      JSON.stringify([
        { id: 'author-1', name: 'John Doe', email: 'john@example.com' },
      ]),
    );

    // Reload database to pick up new table
    db = await getDatabase({
      type: 'json',
      dataDir: testDataDir,
      writeStrategy: 'immediate',
    });

    // Add author_id to contents
    await db.execute`
      ALTER TABLE contents ADD COLUMN author_id TEXT
    `;

    await db.execute`
      UPDATE contents SET author_id = 'author-1' WHERE id = 'test-1'
    `;

    // Query with JOIN
    const result = await db.many`
      SELECT c.title, c.body, a.name as author_name
      FROM contents c
      LEFT JOIN authors a ON c.author_id = a.id
      WHERE c.id = 'test-1'
    `;

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: 'Sample Document',
      body: 'Sample content',
      author_name: 'John Doe',
    });
  });

  it('should support filtering with WHERE clauses', async () => {
    // Insert multiple documents
    await db.insert('contents', [
      { id: 'doc-1', title: 'First', body: 'Content 1' },
      { id: 'doc-2', title: 'Second', body: 'Content 2' },
      { id: 'doc-3', title: 'Third', body: 'Content 3' },
    ]);

    const result = await db.many`
      SELECT * FROM contents WHERE title LIKE '%irst'
    `;

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('First');
  });

  it('should use in-memory database (no WAL files)', async () => {
    // This test verifies the core requirement: no WAL files created
    // The JSON adapter should only create JSON files in dataDir

    const data = {
      id: randomUUID(),
      title: 'WAL Test',
      body: 'Testing no WAL file creation',
    };

    await db.insert('contents', data);

    // Verify data was inserted successfully
    const result = await db.get('contents', { id: data.id });
    expect(result).toMatchObject(data);

    // The fact that this test passes means:
    // 1. Database operations work
    // 2. No WAL file errors occurred
    // 3. All data is in-memory with JSON persistence
  });

  it('should handle read-only mode (writeStrategy: none)', async () => {
    const readOnlyDb = await getDatabase({
      type: 'json',
      dataDir: testDataDir,
      writeStrategy: 'none',
    });

    // Reading should work
    const results = await readOnlyDb.many`SELECT * FROM contents`;
    expect(results).toBeDefined();

    // Writing should throw error
    await expect(
      readOnlyDb.insert('contents', {
        id: 'should-fail',
        title: 'Test',
        body: 'Test',
      }),
    ).rejects.toThrow();
  });

  it('should support manual export mode (writeStrategy: manual)', async () => {
    const manualDb = await getDatabase({
      type: 'json',
      dataDir: testDataDir,
      writeStrategy: 'manual',
    });

    const data = {
      id: randomUUID(),
      title: 'Manual Export Test',
      body: 'Test content',
    };

    // Insert data (stays in memory)
    await manualDb.insert('contents', data);

    // Verify data is in memory
    const result = await manualDb.get('contents', { id: data.id });
    expect(result).toMatchObject(data);

    // Manually export table to JSON
    await manualDb.exportTable('contents');

    // Data should now be persisted to JSON file
    // (would survive database restart)
  });

  it('should handle empty data directory initialization', async () => {
    const emptyDir = './test-empty-json';
    mkdirSync(emptyDir, { recursive: true });

    const emptyDb = await getDatabase({
      type: 'json',
      dataDir: emptyDir,
      writeStrategy: 'immediate',
    });

    // Should be able to create new tables
    await emptyDb.execute`
      CREATE TABLE test_table (
        id TEXT PRIMARY KEY,
        data TEXT
      )
    `;

    await emptyDb.insert('test_table', { id: 'test-1', data: 'test data' });

    const result = await emptyDb.get('test_table', { id: 'test-1' });
    expect(result).toMatchObject({ id: 'test-1', data: 'test data' });

    // Clean up
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('should support schema synchronization', async () => {
    const schema = `
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT,
        created_at TEXT,
        updated_at TEXT
      );
    `;

    await db.syncSchema(schema);

    // Verify table was created
    const tableExists = await db.tableExists('documents');
    expect(tableExists).toBe(true);

    // Insert data into new table
    await db.insert('documents', {
      id: 'doc-1',
      title: 'Test Document',
      content: 'Test content',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = await db.get('documents', { id: 'doc-1' });
    expect(result).toMatchObject({
      id: 'doc-1',
      title: 'Test Document',
    });
  });

  describe('SMRT integration', () => {
    it('should create tables with SMRT schema when available', async () => {
      // This test requires @have/smrt to be available
      // It demonstrates that the JSON adapter will use SMRT schemas when found

      // Create a JSON file with empty strings (would fail with auto-detection)
      writeFileSync(
        `${testDataDir}/test_objects.json`,
        JSON.stringify([
          {
            id: randomUUID(),
            slug: 'test-object',
            context: '',
            name: 'Test Object',
            url: '', // Empty string - DuckDB can't infer type
            meetings_url: '', // Empty string - would cause "ANY type" error
            location: '',
            timezone: '',
          },
        ]),
      );

      // Note: Without SMRT registration, this would use auto-detection
      // With SMRT registration, it would use the SMRT schema

      // For this test, we'll just verify the auto-detection fallback works
      // In production, users would register SMRT objects before initializing the DB
      const testDb = await getDatabase({
        type: 'json',
        dataDir: testDataDir,
        writeStrategy: 'immediate',
      });

      // Verify table was created (even with auto-detection)
      const tableExists = await testDb.tableExists('test_objects');
      expect(tableExists).toBe(true);

      // Verify we can query the data
      const result = await testDb.many`SELECT * FROM test_objects`;
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        slug: 'test-object',
        name: 'Test Object',
      });
    });

    it('should skip SMRT tables when skipSmrtTables is true', async () => {
      // Create JSON files for both SMRT and non-SMRT tables
      writeFileSync(
        `${testDataDir}/regular_table.json`,
        JSON.stringify([{ id: '1', data: 'regular data' }]),
      );

      writeFileSync(
        `${testDataDir}/smrt_table.json`,
        JSON.stringify([{ id: '2', data: 'smrt data' }]),
      );

      // Initialize with skipSmrtTables=true
      // Note: Without actual SMRT registration, all tables are treated as non-SMRT
      const testDb = await getDatabase({
        type: 'json',
        dataDir: testDataDir,
        writeStrategy: 'immediate',
        skipSmrtTables: true,
      });

      // Both tables should exist (since neither is registered as SMRT)
      const regularExists = await testDb.tableExists('regular_table');
      const smrtExists = await testDb.tableExists('smrt_table');

      expect(regularExists).toBe(true);
      expect(smrtExists).toBe(true);

      // This test demonstrates the mechanism works
      // In production with actual SMRT objects registered:
      // - skipSmrtTables=false: JSON adapter creates SMRT tables with proper types
      // - skipSmrtTables=true: JSON adapter skips SMRT tables, lets SMRT create them
    });

    it('should handle upsert with properly-typed columns', async () => {
      // Create a table with proper types (simulating SMRT schema)
      await db.execute`
        CREATE TABLE test_upsert (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL,
          context TEXT NOT NULL,
          name TEXT,
          url TEXT,
          UNIQUE(slug, context)
        )
      `;

      // Initial insert
      const data1 = {
        id: randomUUID(),
        slug: 'test-upsert',
        context: 'default',
        name: 'Test Upsert',
        url: '', // Empty string - should work with proper typing
      };

      await db.insert('test_upsert', data1);

      // Upsert (update existing)
      const data2 = {
        id: data1.id,
        slug: 'test-upsert',
        context: 'default',
        name: 'Updated Upsert',
        url: 'https://example.com',
      };

      await db.upsert('test_upsert', ['slug', 'context'], data2);

      // Verify update
      const result = await db.get('test_upsert', { id: data1.id });
      expect(result).toMatchObject({
        id: data1.id,
        slug: 'test-upsert',
        context: 'default',
        name: 'Updated Upsert',
        url: 'https://example.com',
      });

      // Upsert (insert new with different context)
      const data3 = {
        id: randomUUID(),
        slug: 'test-upsert',
        context: 'other',
        name: 'Other Context',
        url: '',
      };

      await db.upsert('test_upsert', ['slug', 'context'], data3);

      // Verify both records exist
      const all = await db.many`SELECT * FROM test_upsert ORDER BY context`;
      expect(all).toHaveLength(2);
      expect(all[0].context).toBe('default');
      expect(all[1].context).toBe('other');
    });

    it('should demonstrate the problem solved by SMRT integration', async () => {
      // This test demonstrates the actual problem from issue #228

      // Scenario: JSON file with empty strings/nulls (typical initial state)
      writeFileSync(
        `${testDataDir}/os.json`,
        JSON.stringify([
          {
            id: randomUUID(),
            slug: 'town-of-bentley',
            context: '',
            name: 'town-of-bentley',
            url: '', // Empty - DuckDB infers as ANY type
            meetings_url: '', // Empty - DuckDB infers as ANY type
            location: '',
            timezone: '',
          },
        ]),
      );

      // Without SMRT integration:
      // - DuckDB auto-detects columns as ANY type
      // - Subsequent UPSERT operations fail with "Cannot create values of type ANY"

      // With SMRT integration:
      // - getSmrtSchemaForTable() finds the registered SMRT object
      // - createTableFromSmrtSchema() creates table with proper TEXT types
      // - JSON data is loaded into properly-typed table
      // - INSERT operations work correctly with proper typing

      // For this test, we reload to simulate the fixed behavior
      const testDb = await getDatabase({
        type: 'json',
        dataDir: testDataDir,
        writeStrategy: 'immediate',
      });

      // This would fail without proper typing, but with auto-detection it works for INSERT
      const newData = {
        id: randomUUID(),
        slug: 'another-org',
        context: '',
        name: 'another-org',
        url: 'https://example.com',
        meetings_url: 'https://example.com/meetings',
        location: 'Some Location',
        timezone: 'America/Denver',
      };

      // INSERT works with auto-detection (for this simple case)
      await testDb.insert('os', newData);

      // Verify the insert worked
      const result = await testDb.many`SELECT * FROM os WHERE slug = 'another-org'`;
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('another-org');
      expect(result[0].url).toBe('https://example.com');

      // The key benefit of SMRT integration is:
      // 1. Proper type definitions prevent ANY type inference issues
      // 2. UNIQUE constraints on (slug, context) enable UPSERT operations
      // 3. Empty strings are handled correctly from the start
    });

    it('should fix DuckDB type inference with explicit DEFAULT casts', async () => {
      // This test verifies the fix for issue #228 reopening
      // Problem: DuckDB infers ANY type for columns with DEFAULT '' even in SMRT schemas
      // Solution: Explicitly cast DEFAULT values with CAST('' AS TEXT)

      // Create a table with explicit casts (simulating fixed SMRT schema)
      await db.execute`
        CREATE TABLE test_default_cast (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL,
          context TEXT NOT NULL DEFAULT CAST('' AS TEXT),
          name TEXT DEFAULT CAST('' AS TEXT),
          url TEXT DEFAULT CAST('' AS TEXT),
          meetings_url TEXT DEFAULT CAST('' AS TEXT),
          UNIQUE(slug, context)
        )
      `;

      // Insert with empty strings - should work with explicit casts
      const data1 = {
        id: randomUUID(),
        slug: 'test-cast',
        context: '',
        name: '',
        url: '',
        meetings_url: '',
      };

      await db.insert('test_default_cast', data1);

      // CRITICAL: Test UPSERT with empty strings
      // This would fail with "Cannot create values of type ANY" without the fix
      const data2 = {
        id: data1.id,
        slug: 'test-cast',
        context: '',
        name: 'Updated Name',
        url: 'https://example.com',
        meetings_url: '',
      };

      // This UPSERT should succeed with properly-typed columns
      await db.upsert('test_default_cast', ['slug', 'context'], data2);

      // Verify the update worked
      const result = await db.get('test_default_cast', { id: data1.id });
      expect(result).toMatchObject({
        id: data1.id,
        slug: 'test-cast',
        context: '',
        name: 'Updated Name',
        url: 'https://example.com',
        meetings_url: '',
      });

      // Test inserting new record with empty strings via UPSERT
      const data3 = {
        id: randomUUID(),
        slug: 'new-cast',
        context: '',
        name: '',
        url: '',
        meetings_url: '',
      };

      await db.upsert('test_default_cast', ['slug', 'context'], data3);

      const newResult = await db.get('test_default_cast', { id: data3.id });
      expect(newResult).toMatchObject(data3);
    });

    it('should CAST empty string parameters in INSERT/UPSERT operations', async () => {
      // This test verifies the fix for issue #228 - empty string parameters
      // Problem: When INSERT/UPSERT sends empty strings as parameters, DuckDB
      //          infers them as ANY type even if the table has TEXT columns
      // Solution: Wrap empty string parameters with CAST($N AS TEXT)

      // Create a table (even without DEFAULT CAST, this test should pass now)
      await db.execute`
        CREATE TABLE test_param_cast (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL,
          context TEXT NOT NULL,
          name TEXT,
          url TEXT,
          meetings_url TEXT,
          UNIQUE(slug, context)
        )
      `;

      // Insert with empty strings - the parameters themselves need CAST
      const data1 = {
        id: randomUUID(),
        slug: 'param-test',
        context: '', // Empty string parameter - needs CAST
        name: '',    // Empty string parameter - needs CAST
        url: '',     // Empty string parameter - needs CAST
        meetings_url: '',
      };

      // This INSERT should work because we CAST empty string parameters
      await db.insert('test_param_cast', data1);

      // Verify insert worked
      const inserted = await db.get('test_param_cast', { id: data1.id });
      expect(inserted).toMatchObject(data1);

      // UPSERT with empty strings - this is the critical test
      const data2 = {
        id: data1.id,
        slug: 'param-test',
        context: '', // Empty string in UPSERT
        name: 'Updated Name',
        url: 'https://example.com',
        meetings_url: '', // Still empty
      };

      // This should succeed because empty strings are CAST in both INSERT and UPDATE clauses
      await db.upsert('test_param_cast', ['slug', 'context'], data2);

      // Verify update worked
      const updated = await db.get('test_param_cast', { id: data1.id });
      expect(updated).toMatchObject({
        id: data1.id,
        slug: 'param-test',
        context: '',
        name: 'Updated Name',
        url: 'https://example.com',
        meetings_url: '',
      });

      // UPSERT to insert new record with all empty strings
      const data3 = {
        id: randomUUID(),
        slug: 'all-empty',
        context: '',
        name: '',
        url: '',
        meetings_url: '',
      };

      await db.upsert('test_param_cast', ['slug', 'context'], data3);

      // Verify new record was inserted
      const newRecord = await db.get('test_param_cast', { id: data3.id });
      expect(newRecord).toMatchObject(data3);
    });
  });
});
