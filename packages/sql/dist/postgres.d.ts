import { DatabaseInterface } from './shared/types';
/**
 * Configuration options for PostgreSQL database connections
 */
export interface PostgresOptions {
    /**
     * Connection URL for PostgreSQL
     */
    url?: string;
    /**
     * Database name
     */
    database?: string;
    /**
     * Database server hostname
     */
    host?: string;
    /**
     * Username for authentication
     */
    user?: string;
    /**
     * Password for authentication
     */
    password?: string;
    /**
     * Port number for the PostgreSQL server
     */
    port?: number;
}
/**
 * Creates a PostgreSQL database adapter
 *
 * @param options - PostgreSQL connection options
 * @returns Database interface for PostgreSQL
 */
export declare function getDatabase(options?: PostgresOptions): DatabaseInterface;
//# sourceMappingURL=postgres.d.ts.map