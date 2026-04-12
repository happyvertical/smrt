/**
 * Migration Tracker
 *
 * Manages migration state, tracking which migrations have been applied,
 * and providing idempotent migration application.
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type {
  DriftReport,
  MigrationDefinition,
  MigrationResult,
  MigrationStatus,
  SchemaMigrationRecord,
} from '../schema/types.js';
import { CREATE_SMRT_SCHEMA_MIGRATIONS_TABLE } from '../system/schema.js';
import { computeChecksum, verifyChecksum } from './checksum.js';
import type {
  ApplyMigrationsOptions,
  DatabaseEngine,
  DatabaseInterface,
  MigrationTrackerOptions,
  RollbackOptions,
} from './types.js';

/**
 * Row type for _smrt_schema_migrations table
 */
interface MigrationRow {
  id: string;
  name: string;
  version: string;
  checksum: string;
  applied_checksum?: string | null;
  applied_at: string;
  execution_time_ms?: number | null;
  package_name?: string | null;
  source_file?: string | null;
  status: string;
  error_message?: string | null;
  attempts: number;
  is_reversible: number | boolean;
  rolled_back_at?: string | null;
  applied_by?: string | null;
  batch: number;
}

/**
 * Default options for MigrationTracker
 */
const DEFAULT_OPTIONS = {
  lockTimeout: 30000,
  statementTimeout: 60000,
  useConcurrentIndexes: true,
};

/**
 * MigrationTracker class
 *
 * Provides migration tracking and state management:
 * - Initializes the _smrt_schema_migrations tracking table
 * - Tracks applied migrations with checksums
 * - Provides idempotent migration application
 * - Supports rollback via DOWN scripts
 * - Handles PostgreSQL-specific concerns (CONCURRENTLY, lock timeout)
 */
export class MigrationTracker {
  private db: DatabaseInterface;
  private options: Required<Omit<MigrationTrackerOptions, 'db'>>;
  private dbEngine: DatabaseEngine;
  private initialized = false;
  private currentBatch: number | null = null;

  constructor(options: MigrationTrackerOptions) {
    this.db = options.db;
    this.options = {
      lockTimeout: options.lockTimeout ?? DEFAULT_OPTIONS.lockTimeout,
      statementTimeout:
        options.statementTimeout ?? DEFAULT_OPTIONS.statementTimeout,
      useConcurrentIndexes:
        options.useConcurrentIndexes ?? DEFAULT_OPTIONS.useConcurrentIndexes,
    };
    this.dbEngine = this.detectDbEngine();
  }

  /**
   * Detect the database engine from the connection URL
   */
  private detectDbEngine(): DatabaseEngine {
    const url = this.db.url || '';
    if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
      return 'postgres';
    }
    if (url.endsWith('.duckdb') || url.includes('duckdb')) {
      return 'duckdb';
    }
    return 'sqlite';
  }

  /**
   * Get the current database engine
   */
  getEngine(): DatabaseEngine {
    return this.dbEngine;
  }

  /**
   * Initialize the migrations tracking table
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Parse and execute each statement in the DDL
    const statements = CREATE_SMRT_SCHEMA_MIGRATIONS_TABLE.split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      await this.db.query(statement);
    }

    this.initialized = true;
  }

  /**
   * Get all applied migrations ordered by applied_at
   */
  async getAppliedMigrations(): Promise<SchemaMigrationRecord[]> {
    await this.initialize();

    const result = await this.db.query(
      `SELECT * FROM _smrt_schema_migrations WHERE status = 'completed' ORDER BY applied_at ASC`,
    );

    return (result.rows as MigrationRow[]).map((row) => ({
      ...row,
      applied_at: new Date(row.applied_at),
      rolled_back_at: row.rolled_back_at ? new Date(row.rolled_back_at) : null,
      is_reversible: Boolean(row.is_reversible),
    })) as SchemaMigrationRecord[];
  }

  /**
   * Get pending migrations (defined but not applied)
   */
  async getPendingMigrations(
    definitions: MigrationDefinition[],
  ): Promise<MigrationDefinition[]> {
    const applied = await this.getAppliedMigrations();
    const appliedNames = new Set(applied.map((m) => m.name));
    return definitions.filter((d) => !appliedNames.has(d.id));
  }

  /**
   * Check if a migration has been applied
   */
  async isApplied(migrationId: string): Promise<boolean> {
    await this.initialize();

    const result = await this.db.query(
      `SELECT 1 FROM _smrt_schema_migrations WHERE name = ? AND status = 'completed' LIMIT 1`,
      migrationId,
    );

    return result.rows.length > 0;
  }

  /**
   * Get a single migration record by name
   */
  async getMigration(name: string): Promise<SchemaMigrationRecord | null> {
    await this.initialize();

    const result = await this.db.query(
      `SELECT * FROM _smrt_schema_migrations WHERE name = ? LIMIT 1`,
      name,
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0] as MigrationRow;
    return {
      ...row,
      applied_at: new Date(row.applied_at),
      rolled_back_at: row.rolled_back_at ? new Date(row.rolled_back_at) : null,
      is_reversible: Boolean(row.is_reversible),
    } as SchemaMigrationRecord;
  }

  /**
   * Get the next batch number
   */
  async getNextBatch(): Promise<number> {
    await this.initialize();

    const result = await this.db.query(
      `SELECT MAX(batch) as max_batch FROM _smrt_schema_migrations`,
    );

    const row = result.rows[0] as { max_batch: number | null } | undefined;
    return (row?.max_batch ?? 0) + 1;
  }

  /**
   * Detect drift between migration definitions and applied migrations
   */
  async detectDrift(
    definitions: MigrationDefinition[],
  ): Promise<DriftReport[]> {
    const applied = await this.getAppliedMigrations();
    const reports: DriftReport[] = [];

    const appliedMap = new Map(applied.map((m) => [m.name, m]));
    const definitionMap = new Map(definitions.map((d) => [d.id, d]));

    // Check each applied migration against definitions
    for (const record of applied) {
      const definition = definitionMap.get(record.name);

      if (!definition) {
        // Migration applied but definition is missing
        reports.push({
          migration_name: record.name,
          expected_checksum: 'N/A',
          actual_checksum: record.checksum,
          drift_type: 'unknown_in_db',
          recommendation:
            'Migration exists in database but definition is missing. Manual cleanup may be required.',
        });
        continue;
      }

      // Check checksum
      const currentChecksum = computeChecksum(definition.up);
      const verification = verifyChecksum(
        currentChecksum,
        record.checksum,
        record.applied_checksum,
      );

      if (!verification.valid) {
        reports.push({
          migration_name: record.name,
          expected_checksum: record.checksum,
          actual_checksum: currentChecksum,
          drift_type: verification.drift!,
          recommendation:
            verification.drift === 'file_modified'
              ? 'Migration file was modified after application. Create a new migration instead.'
              : 'Database schema was modified outside of migrations. Review and reconcile manually.',
        });
      }
    }

    return reports;
  }

  /**
   * Apply a single migration
   */
  async apply(
    definition: MigrationDefinition,
    options: ApplyMigrationsOptions = {},
  ): Promise<MigrationResult> {
    await this.initialize();
    const startTime = Date.now();
    const checksum = computeChecksum(definition.up);

    // Check if migration record already exists
    const existing = await this.getMigration(definition.id);

    if (existing) {
      // Handle based on existing status
      switch (existing.status) {
        case 'completed':
          if (!options.force && !options.reconcile) {
            // Verify checksum matches
            if (existing.checksum !== checksum) {
              return {
                success: false,
                applied: false,
                skipped: false,
                name: definition.id,
                checksum,
                execution_time_ms: 0,
                error: `Migration ${definition.id} checksum mismatch. Was already applied with different checksum. Use --force to override.`,
              };
            }
            // Already applied, skip
            return {
              success: true,
              applied: false,
              skipped: true,
              name: definition.id,
              checksum,
              execution_time_ms: 0,
            };
          }
          break;

        case 'failed':
          if (!options.force && !options.reconcile) {
            return {
              success: false,
              applied: false,
              skipped: false,
              name: definition.id,
              checksum,
              execution_time_ms: 0,
              error: `Migration ${definition.id} previously failed: ${existing.error_message || 'Unknown error'}. Use --force to retry.`,
            };
          }
          // Will retry below
          break;

        case 'running':
          if (!options.force && !options.reconcile) {
            return {
              success: false,
              applied: false,
              skipped: false,
              name: definition.id,
              checksum,
              execution_time_ms: 0,
              error: `Migration ${definition.id} is currently running or was interrupted. Use --force to retry if the previous run crashed.`,
            };
          }
          // Will retry below
          break;

        case 'rolled_back':
          // Rolled back migrations can be re-applied without --force
          break;
      }
    }

    // Get batch number
    if (this.currentBatch === null) {
      this.currentBatch = await this.getNextBatch();
    }

    // Determine if we're updating an existing record or inserting new
    const id = existing?.id || randomUUID();
    const attempts = (existing?.attempts || 0) + 1;

    if (existing) {
      // Update existing record to 'running'
      await this.db.query(
        `UPDATE _smrt_schema_migrations
         SET status = 'running', checksum = ?, attempts = ?, error_message = NULL, batch = ?, applied_by = ?
         WHERE id = ?`,
        checksum,
        attempts,
        this.currentBatch,
        hostname(),
        id,
      );
    } else {
      // Insert new record
      await this.db.query(
        `INSERT INTO _smrt_schema_migrations
         (id, name, version, checksum, status, attempts, is_reversible, package_name, source_file, applied_by, batch)
         VALUES (?, ?, ?, ?, 'running', 1, ?, ?, ?, ?, ?)`,
        id,
        definition.id,
        definition.version,
        checksum,
        (definition.is_reversible ?? definition.down.length > 0) ? 1 : 0,
        definition.package_name ?? null,
        definition.source_file ?? null,
        hostname(),
        this.currentBatch,
      );
    }

    if (options.dryRun) {
      if (existing) {
        // Restore the existing record to its previous state
        await this.db.query(
          `UPDATE _smrt_schema_migrations
           SET status = ?, checksum = ?, attempts = ?, error_message = ?
           WHERE id = ?`,
          existing.status,
          existing.checksum,
          existing.attempts,
          existing.error_message,
          id,
        );
      } else {
        // Remove the newly inserted running record
        await this.db.query(
          `DELETE FROM _smrt_schema_migrations WHERE id = ?`,
          id,
        );
      }
      return {
        success: true,
        applied: false,
        skipped: false,
        name: definition.id,
        checksum,
        execution_time_ms: Date.now() - startTime,
      };
    }

    try {
      // Execute the migration
      await this.executeStatements(definition.up, options);

      // Mark as completed
      const executionTime = Date.now() - startTime;
      await this.db.query(
        `UPDATE _smrt_schema_migrations
         SET status = 'completed', execution_time_ms = ?, applied_checksum = ?, applied_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        executionTime,
        checksum,
        id,
      );

      return {
        success: true,
        applied: true,
        skipped: false,
        name: definition.id,
        checksum,
        execution_time_ms: executionTime,
      };
    } catch (error) {
      // Mark as failed
      await this.db.query(
        `UPDATE _smrt_schema_migrations
         SET status = 'failed', error_message = ?
         WHERE id = ?`,
        error instanceof Error ? error.message : String(error),
        id,
      );

      return {
        success: false,
        applied: false,
        skipped: false,
        name: definition.id,
        checksum,
        execution_time_ms: Date.now() - startTime,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Apply multiple migrations in order
   */
  async applyAll(
    definitions: MigrationDefinition[],
    options: ApplyMigrationsOptions = {},
  ): Promise<MigrationResult[]> {
    const results: MigrationResult[] = [];
    this.currentBatch = await this.getNextBatch();

    for (const definition of definitions) {
      const result = await this.apply(definition, options);
      results.push(result);

      if (!result.success && !options.continueOnError) {
        break;
      }
    }

    this.currentBatch = null;
    return results;
  }

  /**
   * Rollback a migration
   */
  async rollback(
    name: string,
    definition: MigrationDefinition,
    options: RollbackOptions = {},
  ): Promise<MigrationResult> {
    await this.initialize();
    const startTime = Date.now();
    const checksum = computeChecksum(definition.down);

    const record = await this.getMigration(name);
    if (!record) {
      return {
        success: false,
        name,
        checksum,
        execution_time_ms: 0,
        error: new Error(`Migration ${name} not found in database`),
      };
    }

    if (record.status !== 'completed') {
      return {
        success: false,
        name,
        checksum,
        execution_time_ms: 0,
        error: new Error(
          `Migration ${name} is not in completed state (current: ${record.status})`,
        ),
      };
    }

    if (!definition.down.length) {
      return {
        success: false,
        name,
        checksum,
        execution_time_ms: 0,
        error: new Error(
          `Migration ${name} is not reversible (no down statements)`,
        ),
      };
    }

    if (options.dryRun) {
      return {
        success: true,
        name,
        checksum,
        execution_time_ms: Date.now() - startTime,
        rolled_back: true,
      };
    }

    try {
      // Execute DOWN statements
      await this.executeStatements(definition.down, {});

      // Mark as rolled back
      await this.db.query(
        `UPDATE _smrt_schema_migrations
         SET status = 'rolled_back', rolled_back_at = CURRENT_TIMESTAMP
         WHERE name = ?`,
        name,
      );

      return {
        success: true,
        name,
        checksum,
        execution_time_ms: Date.now() - startTime,
        rolled_back: true,
      };
    } catch (error) {
      return {
        success: false,
        name,
        checksum,
        execution_time_ms: Date.now() - startTime,
        error: error instanceof Error ? error : new Error(String(error)),
        rolled_back: false,
      };
    }
  }

  /**
   * Get migration history with optional filtering
   */
  async getHistory(
    options: { limit?: number; since?: Date; status?: MigrationStatus } = {},
  ): Promise<SchemaMigrationRecord[]> {
    await this.initialize();

    let sql = `SELECT * FROM _smrt_schema_migrations WHERE 1=1`;
    const params: unknown[] = [];

    if (options.status) {
      sql += ` AND status = ?`;
      params.push(options.status);
    }

    if (options.since) {
      sql += ` AND applied_at >= ?`;
      params.push(options.since.toISOString());
    }

    sql += ` ORDER BY applied_at DESC`;

    if (options.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const result = await this.db.query(sql, ...params);

    return (result.rows as MigrationRow[]).map((row) => ({
      ...row,
      applied_at: new Date(row.applied_at),
      rolled_back_at: row.rolled_back_at ? new Date(row.rolled_back_at) : null,
      is_reversible: Boolean(row.is_reversible),
    })) as SchemaMigrationRecord[];
  }

  /**
   * Execute SQL statements with appropriate transaction handling
   */
  private async executeStatements(
    statements: string[],
    options: ApplyMigrationsOptions,
  ): Promise<void> {
    if (this.dbEngine === 'postgres' && options.postgresSafe) {
      await this.executePostgresStatements(statements);
    } else {
      await this.executeWithTransaction(statements);
    }
  }

  /**
   * Execute statements within a transaction (SQLite/DuckDB)
   */
  private async executeWithTransaction(statements: string[]): Promise<void> {
    if (this.db.transaction) {
      await this.db.transaction(async (tx) => {
        for (const sql of statements) {
          await tx.query(sql);
        }
      });
    } else {
      // Fallback to sequential execution
      for (const sql of statements) {
        await this.db.query(sql);
      }
    }
  }

  /**
   * Execute statements with PostgreSQL-specific handling
   *
   * - CONCURRENTLY statements run outside transaction
   * - Regular statements run in transaction with lock_timeout
   */
  private async executePostgresStatements(statements: string[]): Promise<void> {
    // Separate CONCURRENTLY statements (cannot be in transaction)
    const concurrentStatements = statements.filter((s) =>
      /CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(s),
    );
    const regularStatements = statements.filter(
      (s) => !/CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(s),
    );

    // Transform regular CREATE INDEX to CONCURRENTLY if enabled
    const transformedStatements = this.options.useConcurrentIndexes
      ? regularStatements.map((s) => {
          if (/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)/i.test(s)) {
            return s.replace(
              /CREATE\s+(UNIQUE\s+)?INDEX\s+/i,
              'CREATE $1INDEX CONCURRENTLY ',
            );
          }
          return s;
        })
      : regularStatements;

    // Re-separate after transformation
    const finalConcurrent = transformedStatements.filter((s) =>
      /CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(s),
    );
    const finalRegular = transformedStatements.filter(
      (s) => !/CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(s),
    );

    // Execute regular statements in transaction with timeouts
    if (finalRegular.length > 0 && this.db.transaction) {
      await this.db.transaction(async (tx) => {
        // Set session-level timeouts
        await tx.query(
          `SET LOCAL lock_timeout = '${this.options.lockTimeout}ms'`,
        );
        await tx.query(
          `SET LOCAL statement_timeout = '${this.options.statementTimeout}ms'`,
        );

        for (const sql of finalRegular) {
          await tx.query(sql);
        }
      });
    } else if (finalRegular.length > 0) {
      for (const sql of finalRegular) {
        await this.db.query(sql);
      }
    }

    // Execute CONCURRENTLY statements outside transaction
    const allConcurrent = [...concurrentStatements, ...finalConcurrent];
    for (const sql of allConcurrent) {
      // Set lock timeout for the session
      await this.db.query(`SET lock_timeout = '${this.options.lockTimeout}ms'`);
      await this.db.query(sql);
    }
  }
}
