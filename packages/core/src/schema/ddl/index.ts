/**
 * DDL Generator Module
 *
 * Per-engine DDL generation for SMRT schema management.
 * SMRT handles ALL database maintenance directly - SDK SQL remains a pure query/CRUD layer.
 */

export { BaseDDLStrategy } from './base-strategy.js';
export { DuckDBStrategy } from './duckdb-strategy.js';
export { JsonDuckDBStrategy } from './json-duckdb-strategy.js';
export { PostgresStrategy } from './postgres-strategy.js';
export { SQLiteStrategy } from './sqlite-strategy.js';
export * from './types.js';

import type { SchemaDefinition } from '../types.js';
import { DuckDBStrategy } from './duckdb-strategy.js';
import { JsonDuckDBStrategy } from './json-duckdb-strategy.js';
import { PostgresStrategy } from './postgres-strategy.js';
import { SQLiteStrategy } from './sqlite-strategy.js';
import type {
  DatabaseEngine,
  DDLStrategy,
  EngineSpecificDDL,
  MultiEngineDDL,
} from './types.js';

// Singleton instances for each strategy
const strategies: Record<DatabaseEngine, DDLStrategy> = {
  sqlite: new SQLiteStrategy(),
  duckdb: new DuckDBStrategy(),
  json: new JsonDuckDBStrategy(),
  postgres: new PostgresStrategy(),
};

/**
 * Get the DDL strategy for a specific database engine
 *
 * @param engine - The database engine type
 * @returns The DDL strategy for that engine
 */
export function getDDLStrategy(engine: DatabaseEngine): DDLStrategy {
  const strategy = strategies[engine];
  if (!strategy) {
    throw new Error(`Unknown database engine: ${engine}`);
  }
  return strategy;
}

/**
 * Get all available DDL strategies
 *
 * @returns Array of all DDL strategies
 */
export function getAllStrategies(): DDLStrategy[] {
  return Object.values(strategies);
}

/**
 * Generate DDL for a specific engine
 *
 * @param schema - The schema definition
 * @param engine - The target database engine
 * @returns Engine-specific DDL (createTable, indexes, triggers)
 */
export function generateDDLForEngine(
  schema: SchemaDefinition,
  engine: DatabaseEngine,
): EngineSpecificDDL {
  const strategy = getDDLStrategy(engine);

  return {
    createTable: strategy.generateCreateTable(schema),
    indexes: strategy.generateIndexes(schema),
    triggers: strategy.generateTriggers(schema),
  };
}

/**
 * Generate DDL for all supported engines
 *
 * Useful for storing pre-generated DDL in manifest at build time.
 *
 * @param schema - The schema definition
 * @returns DDL for all engines
 */
export function generateMultiEngineDDL(
  schema: SchemaDefinition,
): MultiEngineDDL {
  return {
    sqlite: generateDDLForEngine(schema, 'sqlite'),
    duckdb: generateDDLForEngine(schema, 'duckdb'),
    postgres: generateDDLForEngine(schema, 'postgres'),
  };
}

/**
 * Detect database engine from URL or connection type
 *
 * @param url - Database URL or path
 * @param type - Optional explicit type hint
 * @returns Detected database engine
 */
export function detectEngine(url: string, type?: string): DatabaseEngine {
  // Explicit type takes precedence
  if (type) {
    switch (type.toLowerCase()) {
      case 'sqlite':
      case 'libsql':
        return 'sqlite';
      case 'duckdb':
      case 'json':
        return 'duckdb'; // JSON adapter uses DuckDB internally
      case 'postgres':
      case 'postgresql':
      case 'pg':
        return 'postgres';
      default:
        // Fall through to URL detection
        break;
    }
  }

  // Detect from URL
  const urlLower = url.toLowerCase();

  if (
    urlLower.startsWith('postgres://') ||
    urlLower.startsWith('postgresql://')
  ) {
    return 'postgres';
  }

  if (urlLower.endsWith('.duckdb') || urlLower.includes('duckdb')) {
    return 'duckdb';
  }

  // JSON adapter detection - matches .json extension, /json/ path, or -json- in name
  // This is needed because JSON adapter uses DuckDB internally and requires
  // inline UNIQUE constraints for UPSERT to work
  if (
    urlLower.endsWith('.json') ||
    urlLower.includes('/json/') ||
    urlLower.includes('-json')
  ) {
    return 'duckdb'; // JSON adapter uses DuckDB
  }

  // Default to SQLite for file-based databases
  if (
    urlLower.endsWith('.db') ||
    urlLower.endsWith('.sqlite') ||
    urlLower.endsWith('.sqlite3') ||
    urlLower === ':memory:'
  ) {
    return 'sqlite';
  }

  // Default fallback
  return 'sqlite';
}
