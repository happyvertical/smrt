/**
 * JSON Adapter DDL Strategy
 *
 * The JSON adapter is backed by DuckDB, so it needs DuckDB's inline UNIQUE
 * constraints for UPSERT. However, DuckDB's Node API currently round-trips
 * native UUID values as their 128-bit numeric representation, so SMRT stores
 * UUID columns as TEXT for JSON-backed databases.
 */

import type { SQLDataType } from '../types.js';
import { DuckDBStrategy } from './duckdb-strategy.js';
import type { DatabaseEngine } from './types.js';

export class JsonDuckDBStrategy extends DuckDBStrategy {
  readonly engine: DatabaseEngine = 'json';

  mapType(type: SQLDataType): string {
    if (type === 'UUID') {
      return 'TEXT';
    }

    return super.mapType(type);
  }
}
