import { DatabaseInterface, DuckDBOptions } from './shared/types';
/**
 * Creates a DuckDB database adapter
 *
 * @param options - DuckDB connection options
 * @returns Database interface for DuckDB
 */
export declare function getDatabase(options?: DuckDBOptions): Promise<DatabaseInterface>;
//# sourceMappingURL=duckdb.d.ts.map