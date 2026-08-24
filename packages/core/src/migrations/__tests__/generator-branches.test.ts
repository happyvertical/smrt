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
    it('delegates to the engine DDL strategy for column modifiers + escaped defaults', () => {
      // #1378: with no pre-generated `ddl`, generateCreateTable delegates to
      // the engine DDL strategy (like the orchestrator) rather than building
      // the statement inline with abstract column types. Column modifiers and
      // escaped defaults still come through; FK constraints are intentionally
      // NOT emitted on this path (see the next test).
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [
          {
            tableName: 'orders',
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
      // The DDL strategy omits the redundant NOT NULL on a PRIMARY KEY column
      // (PK implies NOT NULL) — this is the orchestrator-aligned output.
      expect(up).toContain('"id" TEXT PRIMARY KEY');
      expect(up).toContain('"code" TEXT NOT NULL UNIQUE');
      expect(up).toContain('"quantity" INTEGER NOT NULL DEFAULT 0');
      // String default escapes single quotes.
      expect(up).toContain(`"note" TEXT DEFAULT 'O''Brien'`);
      // DOWN drops the table.
      expect(migration.down.join('\n')).toContain(
        'DROP TABLE IF EXISTS "orders"',
      );
    });

    it('emits inline FK constraints on the delegated path (orchestrator parity)', () => {
      // The DDL strategy (and thus the delegated generateCreateTable) does not
      // emit FOREIGN KEY constraints — SMRT manages relationships via
      // cross-package refs and avoids circular DDL FKs (#1333). This matches
      // the migration orchestrator's CREATE TABLE path.
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [
          {
            tableName: 'links',
            columns: {
              id: { type: 'TEXT', primaryKey: true },
              target_id: { type: 'TEXT' },
            },
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
      expect(up).toContain('CREATE TABLE IF NOT EXISTS "links"');
      expect(up).toContain(
        'CONSTRAINT "links_target_id_targets_id_fkey" FOREIGN KEY ("target_id") REFERENCES "targets" ("id")',
      );
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

    it('emits alter_column statements, comments orphan advisories by severity, and skips report-only relaxations (#2369)', () => {
      const diff: SchemaDiff = {
        has_changes: true,
        added_tables: [],
        dropped_tables: [],
        changes: [
          {
            type: 'alter_column',
            table: 'items',
            name: 'status',
            alteration: 'set_not_null',
            mismatch: { expected: 'NOT NULL', actual: 'NULL' },
            sql: 'ALTER TABLE "items" ALTER COLUMN "status" SET NOT NULL',
            sqlStatements: [
              `UPDATE "items" SET "status" = 'draft' WHERE "status" IS NULL`,
              'ALTER TABLE "items" ALTER COLUMN "status" SET NOT NULL',
            ],
          },
          {
            type: 'alter_column',
            table: 'items',
            name: 'note',
            alteration: 'drop_not_null',
            mismatch: { expected: 'NULL', actual: 'NOT NULL' },
            advisory: { severity: 'warning', message: 'relax me' },
          },
          {
            type: 'orphan_column',
            table: 'items',
            name: 'legacy',
            mismatch: { expected: '(not in manifest)', actual: 'TEXT' },
            advisory: {
              severity: 'info',
              message: 'harmless',
              suggestedSql: ['ALTER TABLE "items" DROP COLUMN "legacy"'],
            },
          },
          {
            type: 'orphan_column',
            table: 'items',
            name: 'old_code',
            mismatch: {
              expected: '(not in manifest)',
              actual: 'TEXT NOT NULL',
            },
            advisory: { severity: 'warning', message: 'breaks inserts' },
          },
        ],
      };

      const generator = new MigrationGenerator({ engine: 'postgres' });
      const migration = generator.generateFromDiff(diff, {
        name: '0002_column_drift',
      });

      const up = migration.up.join('\n');
      expect(migration.up).toEqual(
        expect.arrayContaining([
          `UPDATE "items" SET "status" = 'draft' WHERE "status" IS NULL`,
          'ALTER TABLE "items" ALTER COLUMN "status" SET NOT NULL',
        ]),
      );
      expect(up).not.toContain('DROP NOT NULL');
      expect(up).toContain('-- NOTE: Orphan column items.legacy (TEXT)');
      expect(up).toContain(
        '-- suggested: ALTER TABLE "items" DROP COLUMN "legacy"',
      );
      expect(up).toContain(
        '-- WARNING: Orphan column items.old_code (TEXT NOT NULL)',
      );
      expect(migration.down).toHaveLength(0);
    });

    it('records advisory-only foreign-key repair guidance in the migration', () => {
      const migration = new MigrationGenerator({
        engine: 'postgres',
      }).generateFromDiff(
        {
          has_changes: true,
          added_tables: [],
          dropped_tables: [],
          changes: [
            {
              type: 'add_foreign_key',
              table: 'children',
              name: 'children_parent_id_parents_id_fkey',
              advisory: {
                severity: 'warning',
                message: 'Existing orphan rows block this constraint.',
                suggestedSql: [
                  'SELECT parent_id FROM children WHERE parent_id IS NOT NULL',
                ],
              },
            },
          ],
        },
        { name: '0003_foreign_key_advisory' },
      );

      expect(migration.up.join('\n')).toContain(
        '-- WARNING: Foreign-key constraint children.children_parent_id_parents_id_fkey',
      );
      expect(migration.up.join('\n')).toContain(
        '-- Existing orphan rows block this constraint.',
      );
      expect(migration.up.join('\n')).toContain('-- suggested: SELECT');
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
