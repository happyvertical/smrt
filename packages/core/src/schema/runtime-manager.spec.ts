import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeSchemaManager } from './runtime-manager';
import type { SchemaDefinition } from './types';

describe('RuntimeSchemaManager DEFAULT CAST', () => {
  let manager: RuntimeSchemaManager;
  let mockDb: any;
  let executedSQL: string[];

  beforeEach(() => {
    manager = RuntimeSchemaManager.getInstance();
    manager.reset();
    executedSQL = [];

    // Mock database interface
    mockDb = {
      tableExists: async () => false,
      query: async (sql: string) => {
        executedSQL.push(sql);
        return { rows: [], rowCount: 0 };
      },
    };
  });

  it('should add CAST for TEXT columns with empty string default', async () => {
    const schemas: Record<string, SchemaDefinition> = {
      test_table: {
        tableName: 'test_table',
        version: '1.0.0',
        dependencies: [],
        columns: {
          id: {
            type: 'TEXT',
            primaryKey: true,
          },
          name: {
            type: 'TEXT',
            defaultValue: "''",
          },
          url: {
            type: 'TEXT',
            defaultValue: "''",
          },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
      },
    };

    await manager.initializeSchemas({
      db: mockDb,
      schemas,
    });

    expect(executedSQL).toHaveLength(1);
    const createTableSQL = executedSQL[0];

    // Should have CAST for empty string defaults
    expect(createTableSQL).toContain("DEFAULT CAST('' AS TEXT)");
    // Should NOT have DEFAULT '' without CAST
    expect(createTableSQL).not.toMatch(/DEFAULT\s+''\s*(?!AS TEXT)/);
  });

  it('should add CAST for TEXT columns with NULL default', async () => {
    const schemas: Record<string, SchemaDefinition> = {
      test_table: {
        tableName: 'test_table',
        version: '1.0.0',
        dependencies: [],
        columns: {
          id: {
            type: 'TEXT',
            primaryKey: true,
          },
          optional_field: {
            type: 'TEXT',
            defaultValue: 'NULL',
          },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
      },
    };

    await manager.initializeSchemas({
      db: mockDb,
      schemas,
    });

    expect(executedSQL).toHaveLength(1);
    const createTableSQL = executedSQL[0];

    // Should have CAST for NULL defaults
    expect(createTableSQL).toContain('DEFAULT CAST(NULL AS TEXT)');
  });

  it('should NOT add CAST for TEXT columns with non-empty default', async () => {
    const schemas: Record<string, SchemaDefinition> = {
      test_table: {
        tableName: 'test_table',
        version: '1.0.0',
        dependencies: [],
        columns: {
          id: {
            type: 'TEXT',
            primaryKey: true,
          },
          status: {
            type: 'TEXT',
            defaultValue: "'active'",
          },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
      },
    };

    await manager.initializeSchemas({
      db: mockDb,
      schemas,
    });

    expect(executedSQL).toHaveLength(1);
    const createTableSQL = executedSQL[0];

    // Should have DEFAULT 'active' without CAST
    expect(createTableSQL).toContain("DEFAULT 'active'");
    expect(createTableSQL).not.toContain("CAST('active'");
  });

  it('should NOT add CAST for INTEGER columns', async () => {
    const schemas: Record<string, SchemaDefinition> = {
      test_table: {
        tableName: 'test_table',
        version: '1.0.0',
        dependencies: [],
        columns: {
          id: {
            type: 'TEXT',
            primaryKey: true,
          },
          count: {
            type: 'INTEGER',
            defaultValue: '0',
          },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
      },
    };

    await manager.initializeSchemas({
      db: mockDb,
      schemas,
    });

    expect(executedSQL).toHaveLength(1);
    const createTableSQL = executedSQL[0];

    // Should have DEFAULT 0 without CAST (not a TEXT column)
    expect(createTableSQL).toContain('DEFAULT 0');
    expect(createTableSQL).not.toContain('CAST(0');
  });

  it('should work with VARCHAR columns same as TEXT', async () => {
    const schemas: Record<string, SchemaDefinition> = {
      test_table: {
        tableName: 'test_table',
        version: '1.0.0',
        dependencies: [],
        columns: {
          id: {
            type: 'TEXT',
            primaryKey: true,
          },
          description: {
            type: 'VARCHAR',
            defaultValue: "''",
          },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
      },
    };

    await manager.initializeSchemas({
      db: mockDb,
      schemas,
    });

    expect(executedSQL).toHaveLength(1);
    const createTableSQL = executedSQL[0];

    // VARCHAR should also get CAST
    expect(createTableSQL).toContain("DEFAULT CAST('' AS TEXT)");
  });
});
