import {
  redactDatabaseUrl,
  redactDatabaseUrlsInText,
} from '@happyvertical/smrt-core/utils/database-url';

// The one redaction helper pair lives in smrt-core (#3527). The dependency-
// free subpath keeps it out of the root module that command tests mock;
// command modules import it from here alongside the other db utilities.
export { redactDatabaseUrl, redactDatabaseUrlsInText };

type MaybeCloseableDatabase = {
  close?: () => unknown | Promise<unknown>;
  client?: {
    close?: () => unknown | Promise<unknown>;
    end?: () => unknown | Promise<unknown>;
  };
};

/**
 * Quote a SQL identifier (table name, column name, etc.).
 *
 * Uses double quotes, the ANSI SQL standard understood by SQLite, PostgreSQL,
 * and DuckDB, and escapes embedded double quotes by doubling them.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Render the configured database for command output: scheme, username, host,
 * port and database at most — never the password or query string (#3527).
 * A bare local path (`./data/dev.db`, `:memory:`) is shown as
 * `<dbType>://<path>`.
 */
export function formatDatabaseDisplayUrl(
  dbType: string,
  dbUrl: string,
): string {
  const redacted = redactDatabaseUrl(dbUrl);
  return /^[a-z][a-z0-9+.-]*:/i.test(redacted) || redacted !== dbUrl
    ? redacted
    : `${dbType}://${redacted}`;
}

export async function closeDatabaseConnection(db: unknown): Promise<void> {
  if (!db || typeof db !== 'object') {
    return;
  }

  const closeable = db as MaybeCloseableDatabase;
  const close =
    closeable.close ?? closeable.client?.end ?? closeable.client?.close;

  if (typeof close !== 'function') {
    return;
  }

  try {
    await close.call(closeable.close ? closeable : closeable.client);
  } catch {
    // Diagnostics should not fail after the command already produced output.
  }
}
