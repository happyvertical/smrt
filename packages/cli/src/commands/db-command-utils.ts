const SENSITIVE_QUERY_PARAMS = new Set([
  'access_token',
  'apikey',
  'api_key',
  'auth',
  'auth_token',
  'password',
  'token',
]);

// Matches the userinfo segment of a connection-string-shaped substring
// (`scheme://user:PASSWORD@`), wherever it appears — a standalone URL or
// embedded inside a larger message such as a thrown error's text or stack.
//
// The username is `*` (not `+`) so an empty-username form
// (`postgres://:secret@host/db`) still matches. The password is greedy, so
// regex backtracking matches through the LAST `@` in its span. Free-form
// error text is exactly where a malformed password shows up — a literal
// unescaped `@`, raw whitespace (`user:secret pass@host`, the input that
// makes URL parsing fail), or both (`user:sec ret@pa ss@host`) — and the
// scrubber cannot tell where such a password ends, so it redacts up to the
// last possible credential delimiter. The span is bounded by the end of the
// line and by the start of the next `scheme://`, so a second connection
// string keeps its own match and a stack trace's other frames survive. It
// can still over-redact a DSN followed on the same line by an unrelated `@`
// (an email); hiding too much text is the safe failure for a secret scrubber.
const CONNECTION_STRING_USERINFO_PATTERN =
  /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]*:)(?:(?![a-z][a-z0-9+.-]*:\/\/)[^\n])*@/gi;

const SENSITIVE_QUERY_PARAM_PATTERN =
  /([?&](?:access_token|apikey|api_key|auth|auth_token|password|token)=)[^&\s]+/gi;

type MaybeCloseableDatabase = {
  close?: () => unknown | Promise<unknown>;
  client?: {
    close?: () => unknown | Promise<unknown>;
    end?: () => unknown | Promise<unknown>;
  };
};

export function redactConnectionString(value: string): string {
  let redacted = value;

  try {
    const url = new URL(value);

    if (url.password) {
      url.password = '***';
    }

    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        url.searchParams.set(key, '***');
      }
    }

    redacted = url.toString();
  } catch {
    redacted = value.replace(CONNECTION_STRING_USERINFO_PATTERN, '$1***@');
  }

  return redacted.replace(SENSITIVE_QUERY_PARAM_PATTERN, '$1***');
}

/**
 * Redact connection-string credentials embedded anywhere inside arbitrary
 * text, rather than a standalone URL value.
 *
 * Command failure paths surface driver/error text (`error.message`,
 * `error.stack`, wrapped `originalError`/`sql` context) that can itself
 * contain the connection string a command was given — for example a
 * malformed-URL parse error, or a client library that echoes the DSN it
 * tried. `redactConnectionString` expects its whole input to parse as a URL;
 * this scrubs matches wherever they occur in a larger, unknown-shaped string
 * and never throws.
 */
export function redactConnectionStringsInText(text: string): string {
  if (!text) {
    return text;
  }

  return text
    .replace(CONNECTION_STRING_USERINFO_PATTERN, '$1***@')
    .replace(SENSITIVE_QUERY_PARAM_PATTERN, '$1***');
}

/**
 * Quote a SQL identifier (table name, column name, etc.).
 *
 * Uses double quotes, the ANSI SQL standard understood by SQLite, PostgreSQL,
 * and DuckDB, and escapes embedded double quotes by doubling them.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function formatDatabaseDisplayUrl(
  dbType: string,
  dbUrl: string,
): string {
  const displayUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(dbUrl)
    ? dbUrl
    : `${dbType}://${dbUrl}`;

  return redactConnectionString(displayUrl);
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
