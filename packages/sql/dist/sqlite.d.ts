import { DatabaseInterface } from './shared/types';
/**
 * Configuration options for SQLite database connections
 */
export interface SqliteOptions {
    /**
     * Connection URL for SQLite database
     * Supported schemes:
     * - ':memory:' for in-memory databases
     * - 'file:path/to/database.db' for local file databases
     * - 'libsql://...' for remote LibSQL/Turso databases
     */
    url?: string;
    /**
     * Authentication token for Turso/LibSQL remote connections
     */
    authToken?: string;
    /**
     * Encryption key for encrypted SQLite databases (LibSQL feature)
     */
    encryptionKey?: string;
}
/**
 * Creates a SQLite database adapter
 *
 * @param options - SQLite connection options
 * @returns Database interface for SQLite
 */
export declare function getDatabase(options?: SqliteOptions): Promise<DatabaseInterface>;
//# sourceMappingURL=sqlite.d.ts.map