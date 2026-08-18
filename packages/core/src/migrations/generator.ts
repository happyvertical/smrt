/**
 * Migration Generator
 *
 * Generates migration files from schema diffs.
 * Supports both SQL and TypeScript formats.
 */

import { createLogger } from '@happyvertical/logger';
import { getDDLStrategy } from '../schema/ddl/index.js';
import { materializeManifestDDLForEngine } from '../schema/ddl/materialize-manifest.js';
import { cachedDdlTableConstraints } from '../schema/manifest-schema.js';
import type {
  MigrationDefinition,
  SchemaChange,
  SchemaDefinition,
  SchemaDiff,
} from '../schema/types.js';
import { renderIndexTarget } from '../schema/utils.js';
import { computeChecksum } from './checksum.js';
import type { DatabaseEngine } from './types.js';

const logger = createLogger({ level: 'info' });

/**
 * Options for migration generation
 */
export interface GenerateMigrationOptions {
  /** Migration name (without sequence number) */
  name: string;
  /** Output format */
  format?: 'sql' | 'typescript';
  /** Database engine for engine-specific SQL */
  engine?: DatabaseEngine;
  /** Include generated DOWN statements */
  includeDown?: boolean;
  /** Package name for metadata */
  packageName?: string;
  /** Description for the migration */
  description?: string;
}

/**
 * Result of migration generation
 */
export interface GeneratedMigration {
  /** Full migration ID (e.g., '0001_add_users') */
  id: string;
  /** Filename (e.g., '0001_add_users.sql') */
  filename: string;
  /** File content */
  content: string;
  /** UP SQL statements */
  up: string[];
  /** DOWN SQL statements (if includeDown is true) */
  down: string[];
  /** Checksum of the migration */
  checksum: string;
}

/**
 * MigrationGenerator class for creating migration files
 */
export class MigrationGenerator {
  private engine: DatabaseEngine;
  private format: 'sql' | 'typescript';
  private includeDown: boolean;
  private packageName?: string;
  private materializeStructuredSchema: boolean;

  constructor(
    options: {
      engine?: DatabaseEngine;
      format?: 'sql' | 'typescript';
      includeDown?: boolean;
      packageName?: string;
      /**
       * Render new tables from their structured columns through the engine's
       * DDL strategy (default, `true`) — the same renderer `db:migrate` uses,
       * so column types, indexes and triggers match what the differ expects
       * on the next run.
       *
       * @deprecated Passing `false` re-enables the retired cached-`ddl` string
       * path for the CREATE TABLE only (#2358): it emits the manifest's
       * engine-neutral CREATE TABLE with only bare PostgreSQL `TIMESTAMP`
       * rewritten, so `REAL`/`JSON` drift on PostgreSQL. The table's indexes
       * and triggers are still rendered through the engine strategy either
       * way — the flag never suppresses them. Schemas that expose no
       * structured columns always fall back to their cached `ddl` regardless
       * of this flag.
       */
      materializeStructuredSchema?: boolean;
    } = {},
  ) {
    this.engine = options.engine || 'sqlite';
    this.format = options.format || 'sql';
    this.includeDown = options.includeDown ?? true;
    this.packageName = options.packageName;
    this.materializeStructuredSchema =
      options.materializeStructuredSchema ?? true;
  }

  /**
   * Generate a migration from a schema diff
   */
  generateFromDiff(
    diff: SchemaDiff,
    options: GenerateMigrationOptions,
  ): GeneratedMigration {
    const upStatements: string[] = [];
    const downStatements: string[] = [];

    // Handle new tables: CREATE TABLE plus the table's indexes and triggers,
    // exactly as the migration orchestrator emits them (#2358). The differ
    // only produces `add_index` changes for tables that already exist, so
    // there is no double emission against `diff.changes`.
    for (const schema of diff.added_tables) {
      upStatements.push(this.generateCreateTable(schema));
      upStatements.push(...this.generateTableIndexes(schema));
      upStatements.push(...this.generateTableTriggers(schema));
      if (this.includeDown || options.includeDown) {
        downStatements.push(this.generateDropTable(schema.tableName));
      }
    }

    // Handle column and index changes
    for (const change of diff.changes) {
      const { up, down } = this.generateChangeSQL(change);
      upStatements.push(...up);
      if ((this.includeDown || options.includeDown) && down.length > 0) {
        downStatements.push(...down);
      }
    }

    // Handle dropped tables (already in SQL form if present)
    for (const tableName of diff.dropped_tables) {
      upStatements.push(this.generateDropTable(tableName));
      // No automatic DOWN for drops - too dangerous
    }

    return this.generateMigration(upStatements, downStatements, options);
  }

  /**
   * Generate a migration from explicit SQL statements
   */
  generateFromSQL(
    upStatements: string[],
    downStatements: string[],
    options: GenerateMigrationOptions,
  ): GeneratedMigration {
    return this.generateMigration(upStatements, downStatements, options);
  }

  /**
   * Generate an empty migration template
   */
  generateEmpty(options: GenerateMigrationOptions): GeneratedMigration {
    return this.generateMigration([], [], options);
  }

  /**
   * Core migration generation logic
   */
  private generateMigration(
    upStatements: string[],
    downStatements: string[],
    options: GenerateMigrationOptions,
  ): GeneratedMigration {
    const id = options.name;
    const description = options.description || `Migration: ${options.name}`;
    const format = options.format || this.format;
    const filename = `${id}.${format === 'sql' ? 'sql' : 'ts'}`;
    const checksum = computeChecksum(upStatements);

    let content: string;
    if (format === 'sql') {
      content = this.generateSQLFile(
        id,
        description,
        upStatements,
        downStatements,
      );
    } else {
      content = this.generateTypeScriptFile(
        id,
        description,
        upStatements,
        downStatements,
      );
    }

    return {
      id,
      filename,
      content,
      up: upStatements,
      down: downStatements,
      checksum,
    };
  }

  /**
   * Generate SQL migration file content
   */
  private generateSQLFile(
    id: string,
    description: string,
    upStatements: string[],
    downStatements: string[],
  ): string {
    const lines: string[] = [
      `-- @id: ${id}`,
      `-- @description: ${description}`,
      `-- @generated: ${new Date().toISOString()}`,
    ];

    if (this.packageName) {
      lines.push(`-- @package: ${this.packageName}`);
    }

    lines.push('');
    lines.push('-- @up');

    if (upStatements.length === 0) {
      lines.push('-- Add your UP statements here');
    } else {
      for (const stmt of upStatements) {
        lines.push(this.terminateStatement(stmt));
      }
    }

    lines.push('');
    lines.push('-- @down');

    if (downStatements.length === 0) {
      lines.push('-- Add your DOWN statements here');
    } else {
      for (const stmt of downStatements) {
        lines.push(this.terminateStatement(stmt));
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  /**
   * Generate TypeScript migration file content
   */
  private generateTypeScriptFile(
    id: string,
    description: string,
    upStatements: string[],
    downStatements: string[],
  ): string {
    const upStatementsStr =
      upStatements.length > 0
        ? upStatements
            .map((s) => `      await db.query(\`${this.escapeTemplate(s)}\`);`)
            .join('\n')
        : '      // Add your UP statements here';

    const downStatementsStr =
      downStatements.length > 0
        ? downStatements
            .map((s) => `      await db.query(\`${this.escapeTemplate(s)}\`);`)
            .join('\n')
        : '      // Add your DOWN statements here';

    return `/**
 * Migration: ${id}
 * ${description}
 *
 * Generated: ${new Date().toISOString()}
 */

import type { Migration } from '@happyvertical/smrt-core';

export default {
  id: '${id}',
  description: '${description.replace(/'/g, "\\'")}',
  version: '1.0.0',

  up: async (db) => {
${upStatementsStr}
  },

  down: async (db) => {
${downStatementsStr}
  },
} satisfies Migration;
`;
  }

  /**
   * Generate CREATE TABLE SQL from schema definition
   */
  private generateCreateTable(schema: SchemaDefinition): string {
    if (Object.keys(schema.columns).length === 0 && schema.ddl?.trim()) {
      // Structured materialization cannot preserve constraints or vendor SQL
      // when an older/custom manifest exposes only executable DDL. Retain the
      // only valid representation even when materialization was requested.
      return materializeManifestDDLForEngine(schema.ddl, this.engine);
    }

    if (!this.materializeStructuredSchema && schema.ddl?.trim()) {
      // Deprecated opt-out (#2358): the cached string is engine-neutral and
      // index-less; only bare PostgreSQL TIMESTAMP is rewritten.
      return materializeManifestDDLForEngine(schema.ddl, this.engine);
    }

    // The manifest's pre-generated `ddl` is deliberately engine-neutral and
    // may contain abstract TIMESTAMP/JSON/UUID types. Materialize the
    // structured columns through the selected engine strategy; executing the
    // cached string on PostgreSQL would otherwise bypass TIMESTAMPTZ and lose
    // JavaScript Date offsets (#2069). This matches the migration orchestrator
    // and also prevents JSON/REAL/UUID drift after a create.
    if (schema.ddl?.trim()) {
      // Table-level constraints that live only in a hand-authored cached
      // string cannot be represented structurally and are dropped — as
      // `db:migrate` already drops them. Say so instead of losing them
      // silently (#2358).
      const constraints = cachedDdlTableConstraints(schema.ddl);
      if (constraints.length > 0) {
        logger.warn(
          `[MigrationGenerator] cached ddl for table "${schema.tableName}" declares ` +
            `${constraints.length} table constraint(s) that structured columns cannot ` +
            `carry (${constraints.join('; ')}); the structured schema is authoritative ` +
            `and they are not rendered (#2358).`,
        );
      }
    }
    return getDDLStrategy(this.engine).generateCreateTable(schema);
  }

  /**
   * Generate the CREATE INDEX statements for a new table through the engine
   * strategy (partial `WHERE`, JSON-path targets, inline-UNIQUE engines).
   */
  private generateTableIndexes(schema: SchemaDefinition): string[] {
    return getDDLStrategy(this.engine).generateIndexes(schema);
  }

  /**
   * Generate the CREATE TRIGGER statements for a new table (engines without
   * trigger support return none).
   */
  private generateTableTriggers(schema: SchemaDefinition): string[] {
    return getDDLStrategy(this.engine).generateTriggers(schema);
  }

  /**
   * Generate DROP TABLE SQL
   */
  private generateDropTable(tableName: string): string {
    return `DROP TABLE IF EXISTS ${this.quoteIdentifier(tableName)}`;
  }

  /**
   * Generate SQL for a schema change
   */
  private generateChangeSQL(change: SchemaChange): {
    up: string[];
    down: string[];
  } {
    const up: string[] = [];
    const down: string[] = [];
    const sqlStatements =
      change.sqlStatements ?? (change.sql ? [change.sql] : []);

    switch (change.type) {
      case 'add_column':
        if (sqlStatements.length > 0) {
          up.push(...sqlStatements);
        } else if (change.column && change.name) {
          up.push(
            this.generateAddColumn(change.table, change.name, change.column),
          );
        }
        if (change.name) {
          down.push(this.generateDropColumn(change.table, change.name));
        }
        break;

      case 'drop_column':
        if (sqlStatements.length > 0) {
          up.push(...sqlStatements);
        } else if (change.name) {
          up.push(this.generateDropColumn(change.table, change.name));
        }
        // No automatic DOWN for drops
        break;

      case 'add_index':
        if (sqlStatements.length > 0) {
          up.push(...sqlStatements);
        } else if (change.index) {
          up.push(this.generateAddIndex(change.table, change.index));
        }
        if (change.name) {
          down.push(this.generateDropIndex(change.name));
        }
        break;

      case 'drop_index':
        if (change.name) {
          up.push(this.generateDropIndex(change.name));
        }
        // No automatic DOWN for index drops
        break;

      case 'type_upgrade':
        // Type upgrades are safe conversions that SMRT can handle automatically
        // The SQL is generated by the differ based on engine-specific requirements
        if (sqlStatements.length > 0) {
          for (const sql of sqlStatements) {
            // Skip comment-only SQL (indicates a no-op migration)
            if (!sql.startsWith('--')) {
              up.push(sql);
            }
          }
        }
        // No automatic DOWN for type changes - could lose data
        break;

      case 'type_mismatch':
        // Type mismatches require manual intervention
        up.push(`-- WARNING: Type mismatch for ${change.table}.${change.name}`);
        up.push(
          `-- Expected: ${change.mismatch?.expected}, Actual: ${change.mismatch?.actual}`,
        );
        up.push(`-- Manual migration required`);
        break;

      default:
        // Unknown change type
        break;
    }

    return { up, down };
  }

  /**
   * Generate ADD COLUMN SQL
   */
  private generateAddColumn(
    tableName: string,
    colName: string,
    colDef: import('../schema/types.js').ColumnDefinition,
  ): string {
    const parts: string[] = [this.quoteIdentifier(colName), colDef.type];

    if (colDef.notNull) {
      parts.push('NOT NULL');
    }
    if (colDef.unique) {
      parts.push('UNIQUE');
    }
    if (colDef.defaultValue !== undefined) {
      parts.push(`DEFAULT ${this.formatDefaultValue(colDef.defaultValue)}`);
    }

    return `ALTER TABLE ${this.quoteIdentifier(tableName)} ADD COLUMN ${parts.join(' ')}`;
  }

  /**
   * Generate DROP COLUMN SQL
   */
  private generateDropColumn(tableName: string, colName: string): string {
    return `ALTER TABLE ${this.quoteIdentifier(tableName)} DROP COLUMN ${this.quoteIdentifier(colName)}`;
  }

  /**
   * Generate ADD INDEX SQL
   */
  private generateAddIndex(
    tableName: string,
    index: import('../schema/types.js').IndexDefinition,
  ): string {
    const uniqueStr = index.unique ? 'UNIQUE ' : '';
    const target = renderIndexTarget(index, this.engine);
    // Partial-index predicate. DuckDB (and the JSON adapter backed by it)
    // rejects partial indexes, so the declaration degrades to a full index
    // there — matching the differ and the DuckDB DDL strategy.
    const whereClause =
      this.engine !== 'duckdb' && index.where ? ` WHERE ${index.where}` : '';

    if (this.engine === 'postgres') {
      // PostgreSQL: use CONCURRENTLY for production safety
      return `CREATE ${uniqueStr}INDEX CONCURRENTLY IF NOT EXISTS ${this.quoteIdentifier(index.name)} ON ${this.quoteIdentifier(tableName)} (${target})${whereClause}`;
    }

    return `CREATE ${uniqueStr}INDEX IF NOT EXISTS ${this.quoteIdentifier(index.name)} ON ${this.quoteIdentifier(tableName)} (${target})${whereClause}`;
  }

  /**
   * Generate DROP INDEX SQL
   */
  private generateDropIndex(indexName: string): string {
    if (this.engine === 'postgres') {
      return `DROP INDEX CONCURRENTLY IF EXISTS ${this.quoteIdentifier(indexName)}`;
    }
    return `DROP INDEX IF EXISTS ${this.quoteIdentifier(indexName)}`;
  }

  /**
   * Quote a SQL identifier
   */
  private quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * Format a default value for SQL
   */
  private formatDefaultValue(value: unknown): string {
    if (value === null) return 'NULL';
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'number') return String(value);
    return String(value);
  }

  /**
   * Terminate a statement with exactly one `;` for the SQL file format.
   *
   * Strategy-rendered statements (`generateCreateTable`, `generateIndexes`,
   * `generateTriggers`) already end with `;`, while differ-produced ALTERs do
   * not — appending unconditionally wrote `;;` (#2406 review).
   */
  private terminateStatement(stmt: string): string {
    return stmt.trimEnd().endsWith(';') ? stmt : `${stmt};`;
  }

  /**
   * Escape template literal content
   */
  private escapeTemplate(str: string): string {
    return str.replace(/`/g, '\\`').replace(/\$/g, '\\$');
  }
}

/**
 * Generate a migration definition from UP and DOWN statements
 */
export function createMigrationDefinition(
  id: string,
  upStatements: string[],
  downStatements: string[] = [],
  options: {
    description?: string;
    version?: string;
    packageName?: string;
    sourceFile?: string;
  } = {},
): MigrationDefinition {
  return {
    id,
    description: options.description || `Migration: ${id}`,
    version: options.version || '1.0.0',
    up: upStatements,
    down: downStatements,
    package_name: options.packageName,
    source_file: options.sourceFile,
  };
}

/**
 * Generate a sequence number for a new migration
 */
export function generateMigrationSequence(existingIds: string[]): string {
  const sequences = existingIds
    .map((id) => {
      const match = id.match(/^(\d+)_/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((n) => !Number.isNaN(n));

  const maxSequence = sequences.length > 0 ? Math.max(...sequences) : 0;
  return String(maxSequence + 1).padStart(4, '0');
}

/**
 * Generate a timestamp-based migration ID
 */
export function generateMigrationTimestamp(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
}
