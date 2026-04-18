/**
 * DDL Generator Types for Per-Engine SQL Generation
 *
 * SMRT handles ALL database maintenance directly. SDK SQL remains a pure query/CRUD layer.
 * Each database engine has different DDL requirements:
 * - SQLite: No CAST in DEFAULT, INTEGER for booleans
 * - DuckDB: Inline UNIQUE constraints required for UPSERT to work
 * - PostgreSQL: JSONB type, full trigger support
 */

import type { SchemaDefinition, SQLDataType } from '../types.js';

/**
 * Supported database engines
 * - sqlite: SQLite/LibSQL databases
 * - duckdb: DuckDB databases (including JSON adapter which uses DuckDB internally)
 * - postgres: PostgreSQL databases
 */
export type DatabaseEngine = 'sqlite' | 'duckdb' | 'postgres';

/**
 * Engine-specific DDL output
 */
export interface EngineSpecificDDL {
  /** CREATE TABLE statement */
  createTable: string;
  /** CREATE INDEX statements (separate from table for SQLite/Postgres) */
  indexes: string[];
  /** CREATE TRIGGER statements (not supported by DuckDB) */
  triggers: string[];
}

/**
 * Multi-engine DDL for manifest storage
 */
export interface MultiEngineDDL {
  sqlite: EngineSpecificDDL;
  duckdb: EngineSpecificDDL;
  postgres: EngineSpecificDDL;
}

/**
 * DDL Generator Strategy Interface
 *
 * Each database engine implements this interface to generate
 * engine-specific DDL from a SchemaDefinition.
 */
export interface DDLStrategy {
  /** The database engine this strategy generates DDL for */
  readonly engine: DatabaseEngine;

  /**
   * Generate CREATE TABLE statement
   * @param schema - The schema definition to generate DDL for
   * @returns CREATE TABLE SQL statement
   */
  generateCreateTable(schema: SchemaDefinition): string;

  /**
   * Generate CREATE INDEX statements
   * For DuckDB, UNIQUE indexes should be inline constraints, not separate indexes
   * @param schema - The schema definition
   * @returns Array of CREATE INDEX SQL statements
   */
  generateIndexes(schema: SchemaDefinition): string[];

  /**
   * Generate CREATE TRIGGER statements
   * DuckDB does not support triggers - returns empty array
   * @param schema - The schema definition
   * @returns Array of CREATE TRIGGER SQL statements
   */
  generateTriggers(schema: SchemaDefinition): string[];

  /**
   * Map abstract SQL type to engine-specific type
   * @param type - Abstract SQL data type
   * @returns Engine-specific SQL type string
   */
  mapType(type: SQLDataType): string;

  /**
   * Format a default value for the engine
   * SQLite: No CAST expressions
   * DuckDB/Postgres: Can use CAST
   * @param value - The default value
   * @param type - The column type
   * @returns Formatted default value SQL
   */
  formatDefaultValue(value: any, type: SQLDataType): string;

  /**
   * Whether this engine supports database triggers
   * @returns true if triggers are supported
   */
  supportsTriggers(): boolean;

  /**
   * Whether this engine requires inline UNIQUE constraints for UPSERT
   * DuckDB requires this due to issue #12684
   * @returns true if UNIQUE must be inline
   */
  requiresInlineUnique(): boolean;

  /**
   * Generate a single column definition for use in ALTER TABLE ADD COLUMN
   * @param columnName - The column name
   * @param columnDef - The column definition
   * @returns Column definition SQL fragment (e.g. '"name" TEXT DEFAULT '')
   */
  generateColumnDefinition(
    columnName: string,
    columnDef: import('../types').ColumnDefinition,
  ): string;
}

/**
 * Column generation options
 */
export interface ColumnGenerationOptions {
  /** Include NOT NULL constraint */
  includeNotNull?: boolean;
  /** Include DEFAULT clause */
  includeDefault?: boolean;
  /** Include PRIMARY KEY constraint */
  includePrimaryKey?: boolean;
}

/**
 * Table generation options
 */
export interface TableGenerationOptions {
  /** Whether to use IF NOT EXISTS */
  ifNotExists?: boolean;
  /** Additional table constraints to append */
  additionalConstraints?: string[];
}
