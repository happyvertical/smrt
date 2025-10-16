import { DatabaseInterface, JSONOptions } from './shared/types';
/**
 * Creates a JSON database adapter using DuckDB in-memory engine
 *
 * This adapter provides SQL query capabilities over JSON files without creating
 * persistent database files or WAL files. All data is stored in-memory during
 * runtime and written back to JSON files based on the write strategy.
 *
 * @param options - JSON database options
 * @returns Database interface for JSON files
 */
export declare function getDatabase(options: JSONOptions): Promise<DatabaseInterface>;
//# sourceMappingURL=json.d.ts.map