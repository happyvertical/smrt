/**
 * MigrationGenerator branch coverage
 *
 * Targets branches not exercised by generator.test.ts:
 * - generateCreateTable building DDL from columns (no pre-supplied `ddl`),
 *   including primaryKey / notNull / unique / defaultValue parts and FK
 *   constraints with ON DELETE / ON UPDATE actions.
 * - generateChangeSQL fallbacks that synthesize SQL from a column/index
 *   definition (rather than `sqlStatements`/`sql`), plus drop_column,
 *   drop_index, and type_mismatch warning emission.
 * - formatDefaultValue across null / string / boolean / number.
 * - SQL file header `-- @package:` line.
 */

import { describe, expect, it } from 'vitest';
import type { SchemaDefinition, SchemaDiff } from '../../schema/types.js';
import { MigrationGenerator } from '../generator.js';

describe('MigrationGenerator branch coverage', () => {
  describe('generateCreateTable from columns (no pre-supplied ddl)', () => {
    it('builds CREATE TABLE with all column modifiers and FK constraints', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [
          {
            tableName: 'orders',
            // No `ddl` field — forces the column-by-column build path.
            columns: {
              id: { type: 'TEXT', primaryKey: true, notNull: true },
              code: { type: 'TEXT', unique: true, notNull: true },
              quantity: { type: 'INTEGER', notNull: true, defaultValue: 0 },
              note: { type: 'TEXT', defaultValue: "O'Brien" },
              customer_id: {
                type: 'TEXT',
                foreignKey: {
                  table: 'customers',
                  column: 'id',
                  onDelete: 'CASCADE',
                  onUpdate: 'RESTRICT',
                },
              },
            },
            indexes: [],
            triggers: [],
            foreignKeys: [
              {
                column: 'customer_id',
                referencesTable: 'customers',
                referencesColumn: 'id',
                onDelete: 'CASCADE',
                onUpdate: 'RESTRICT',
              },
            ],
            dependencies: [],
            version: '1.0.0',
          } as SchemaDefinition,
        ],
        dropped_tables: [],
        changes: [],
      };

      const generator = new MigrationGenerator({
        engine: 'sqlite',
        format: 'sql',
        includeDown: true,
      });

      const migration = generator.generateFromDiff(diff, {
        name: '0001_create_orders',
      });

      const up = migration.up.join('\n');
      expect(up).toContain('CREATE TABLE IF NOT EXISTS "orders"');
      expect(up).toContain('"id" TEXT PRIMARY KEY NOT NULL');
      expect(up).toContain('"code" TEXT NOT NULL UNIQUE');
      expect(up).toContain('"quantity" INTEGER NOT NULL DEFAULT 0');
      // String default escapes single quotes.
      expect(up).toContain(`"note" TEXT DEFAULT 'O''Brien'`);
      // FK constraint with both actions.
      expect(up).toContain(
        'FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE RESTRICT',
      );
      // DOWN drops the table.
      expect(migration.down.join('\n')).toContain(
        'DROP TABLE IF EXISTS "orders"',
      );
    });

    it('omits ON DELETE/ON UPDATE when the FK declares no actions', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [
          {
            tableName: 'links',
            columns: { id: { type: 'TEXT', primaryKey: true } },
            indexes: [],
            triggers: [],
            foreignKeys: [
              {
                column: 'target_id',
                referencesTable: 'targets',
                referencesColumn: 'id',
              },
            ],
            dependencies: [],
            version: '1.0.0',
          } as SchemaDefinition,
        ],
        dropped_tables: [],
        changes: [],
      };

      const generator = new MigrationGenerator({ engine: 'sqlite' });
      const migration = generator.generateFromDiff(diff, {
        name: '0001_links',
      });

      const up = migration.up.join('\n');
      expect(up).toContain(
        'FOREIGN KEY ("target_id") REFERENCES "targets"("id")',
      );
      expect(up).not.toContain('ON DELETE');
      expect(up).not.toContain('ON UPDATE');
    });
  });

  describe('generateChangeSQL synthesis fallbacks', () => {
    it('synthesizes ADD COLUMN SQL from a column definition with modifiers', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [],
        dropped_tables: [],
        changes: [
          {
            type: 'add_column',
            table: 'users',
            name: 'nickname',
            // No sqlStatements/sql -> generateAddColumn path.
            column: {
              type: 'TEXT',
              notNull: true,
              unique: true,
              defaultValue: 'anon',
            },
          },
        ],
      };

      const generator = new MigrationGenerator({ engine: 'sqlite' });
      const migration = generator.generateFromDiff(diff, {
        name: '0001_add_nickname',
      });

      const up = migration.up.join('\n');
      expect(up).toContain(
        `ALTER TABLE "users" ADD COLUMN "nickname" TEXT NOT NULL UNIQUE DEFAULT 'anon'`,
      );
      // DOWN drops the column.
      expect(migration.down.join('\n')).toContain(
        'ALTER TABLE "users" DROP COLUMN "nickname"',
      );
    });

    it('synthesizes DROP COLUMN SQL when no explicit SQL provided', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [],
        dropped_tables: [],
        changes: [{ type: 'drop_column', table: 'users', name: 'legacy' }],
      };

      const generator = new MigrationGenerator({ engine: 'sqlite' });
      const migration = generator.generateFromDiff(diff, {
        name: '0001_drop_legacy',
      });

      expect(migration.up.join('\n')).toContain(
        'ALTER TABLE "users" DROP COLUMN "legacy"',
      );
      // Drops have no automatic DOWN.
      expect(migration.down).toHaveLength(0);
    });

    it('synthesizes ADD INDEX SQL from an index definition (sqlite, non-concurrent)', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [],
        dropped_tables: [],
        changes: [
          {
            type: 'add_index',
            table: 'users',
            name: 'idx_users_handle',
            index: {
              name: 'idx_users_handle',
              columns: ['handle'],
              unique: true,
            },
          },
        ],
      };

      const generator = new MigrationGenerator({ engine: 'sqlite' });
      const migration = generator.generateFromDiff(diff, {
        name: '0001_add_handle_idx',
      });

      const up = migration.up.join('\n');
      expect(up).toContain(
        'CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_handle" ON "users" ("handle")',
      );
      expect(up).not.toContain('CONCURRENTLY');
      expect(migration.down.join('\n')).toContain(
        'DROP INDEX IF EXISTS "idx_users_handle"',
      );
    });

    it('emits DROP INDEX with no automatic DOWN', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [],
        dropped_tables: [],
        changes: [
          { type: 'drop_index', table: 'users', name: 'idx_users_old' },
        ],
      };

      const generator = new MigrationGenerator({ engine: 'sqlite' });
      const migration = generator.generateFromDiff(diff, {
        name: '0001_drop_old_idx',
      });

      expect(migration.up.join('\n')).toContain(
        'DROP INDEX IF EXISTS "idx_users_old"',
      );
      expect(migration.down).toHaveLength(0);
    });

    it('emits warning comments for type_mismatch changes', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [],
        dropped_tables: [],
        changes: [
          {
            type: 'type_mismatch',
            table: 'products',
            name: 'price',
            mismatch: { expected: 'REAL', actual: 'TEXT' },
          },
        ],
      };

      const generator = new MigrationGenerator({ engine: 'sqlite' });
      const migration = generator.generateFromDiff(diff, {
        name: '0001_price_mismatch',
      });

      const up = migration.up.join('\n');
      expect(up).toContain('-- WARNING: Type mismatch for products.price');
      expect(up).toContain('-- Expected: REAL, Actual: TEXT');
      expect(up).toContain('-- Manual migration required');
      expect(migration.down).toHaveLength(0);
    });

    it('ignores unknown change types without emitting SQL', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [],
        dropped_tables: [],
        changes: [
          // `add_table` is not handled by generateChangeSQL's switch.
          { type: 'add_table', table: 'ghost' },
        ],
      };

      const generator = new MigrationGenerator({ engine: 'sqlite' });
      const migration = generator.generateFromDiff(diff, {
        name: '0001_unknown',
      });

      expect(migration.up).toHaveLength(0);
      expect(migration.down).toHaveLength(0);
    });

    it('drops a table named in dropped_tables', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [],
        dropped_tables: ['obsolete'],
        changes: [],
      };

      const generator = new MigrationGenerator({ engine: 'sqlite' });
      const migration = generator.generateFromDiff(diff, {
        name: '0001_drop_obsolete',
      });

      expect(migration.up.join('\n')).toContain(
        'DROP TABLE IF EXISTS "obsolete"',
      );
    });
  });

  describe('formatDefaultValue branches', () => {
    it('renders NULL, boolean, and numeric defaults correctly in ADD COLUMN', () => {
      const generator = new MigrationGenerator({ engine: 'sqlite' });

      const nullDiff: SchemaDiff = {
        has_changes: true,
        added_tables: [],
        dropped_tables: [],
        changes: [
          {
            type: 'add_column',
            table: 't',
            name: 'maybe',
            column: { type: 'TEXT', defaultValue: null },
          },
        ],
      };
      expect(
        generator
          .generateFromDiff(nullDiff, { name: '0001_null' })
          .up.join('\n'),
      ).toContain('DEFAULT NULL');

      const boolDiff: SchemaDiff = {
        has_changes: true,
        added_tables: [],
        dropped_tables: [],
        changes: [
          {
            type: 'add_column',
            table: 't',
            name: 'active',
            column: { type: 'BOOLEAN', defaultValue: true },
          },
          {
            type: 'add_column',
            table: 't',
            name: 'archived',
            column: { type: 'BOOLEAN', defaultValue: false },
          },
        ],
      };
      const boolUp = generator
        .generateFromDiff(boolDiff, { name: '0001_bool' })
        .up.join('\n');
      expect(boolUp).toContain('"active" BOOLEAN DEFAULT 1');
      expect(boolUp).toContain('"archived" BOOLEAN DEFAULT 0');

      const numDiff: SchemaDiff = {
        has_changes: true,
        added_tables: [],
        dropped_tables: [],
        changes: [
          {
            type: 'add_column',
            table: 't',
            name: 'score',
            column: { type: 'REAL', defaultValue: 4.5 },
          },
        ],
      };
      expect(
        generator.generateFromDiff(numDiff, { name: '0001_num' }).up.join('\n'),
      ).toContain('DEFAULT 4.5');
    });
  });

  describe('SQL file header', () => {
    it('includes the @package line when packageName is configured', () => {
      const generator = new MigrationGenerator({
        engine: 'sqlite',
        format: 'sql',
        packageName: '@happyvertical/smrt-core',
      });

      const migration = generator.generateEmpty({ name: '0001_pkg' });

      expect(migration.content).toContain(
        '-- @package: @happyvertical/smrt-core',
      );
    });
  });
});
