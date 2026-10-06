/**
 * Database connection-string redaction (#3527).
 *
 * Every place SMRT prints a database URL — the CLI `✓ Connected to …` banner,
 * `db:*` headers, verbose logs, connection errors — routes through these two
 * helpers so a password or query-string secret never reaches a terminal, a
 * Kubernetes log, or a log shipper.
 *
 * - {@link redactDatabaseUrl} renders ONE connection value for display: scheme,
 *   username, host, port and database path at most. The password becomes
 *   `***`; the query string and fragment are dropped. A value that cannot be
 *   parsed is never echoed back raw.
 * - {@link redactDatabaseUrlsInText} scrubs connection strings and secret
 *   `key=value` pairs embedded anywhere inside free text (driver errors,
 *   stacks) and never throws.
 */

/** Marker that replaces a credential. */
const MASK = '***';

/** Shown instead of a connection value that cannot be parsed safely. */
const UNPARSEABLE = '[redacted: unparseable connection string]';

/**
 * Whether a parameter name (query string or libpq keyword) names a secret.
 * Names are normalized (lowercase, `_`/`-` stripped) so `authToken`,
 * `auth_token` and `auth-token` all match.
 */
export function isSensitiveConnectionParam(name: string): boolean {
  const key = name.toLowerCase().replace(/[_-]/g, '');
  return (
    /password|passwd|passphrase|secret|token|credential|connectionstring/.test(
      key,
    ) ||
    key.endsWith('key') ||
    key === 'pwd' ||
    key === 'pass' ||
    key === 'auth' ||
    key === 'dsn'
  );
}

// The userinfo segment of a connection-string-shaped substring
// (`scheme://user:PASSWORD@`). The username is `*` so an empty username
// (`postgres://:secret@host`) still matches. The password run is greedy
// `[^\n]*@`: it backtracks to the LAST `@` on the line, because a malformed
// password (literal `@`, raw whitespace, scheme-like text) has no reliable end
// short of that. The match never crosses a newline, so other stack frames
// survive. Over-redaction is the accepted, safe failure.
const USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]*:)[^\n]*@/gi;

// A `key=value` pair in free text, a query string, or a libpq keyword DSN.
// Boundary: start, `?`, `&`, `;`, `,`, `(`, or whitespace. The value may be
// single- or double-quoted (libpq allows `password='a b'`).
const KEY_VALUE_PATTERN =
  /((?:^|[?&;,(\s])([a-z][a-z0-9_-]{0,40})\s*=\s*)('(?:[^'\\\n]|\\.)*'?|"(?:[^"\\\n]|\\.)*"?|[^&;,\s)'"]+)/gi;

/** A libpq keyword/value DSN: starts with `key=` (`host=h port=5432 …`). */
const KEYWORD_DSN_PATTERN = /^\s*[a-z][a-z0-9_]*\s*=/i;

const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;

/** libpq keyword/value DSN keys that are safe to display. */
const SAFE_KEYWORD_DSN_KEYS = new Set([
  'host',
  'hostaddr',
  'port',
  'dbname',
  'user',
]);

function maskKeyValuePairs(text: string): string {
  return text.replace(
    KEY_VALUE_PATTERN,
    (match, prefix: string, key: string) =>
      isSensitiveConnectionParam(key) ? `${prefix}${MASK}` : match,
  );
}

function renderParsedUrl(url: URL): string {
  if (url.password) {
    url.password = MASK;
  }
  url.search = '';
  url.hash = '';
  return url.href;
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function redactKeywordDsn(value: string): string {
  const safe: string[] = [];
  for (const match of value.matchAll(KEY_VALUE_PATTERN)) {
    const key = match[2].toLowerCase();
    if (SAFE_KEYWORD_DSN_KEYS.has(key)) {
      safe.push(`${key}=${match[3]}`);
    }
  }
  return safe.length > 0 ? safe.join(' ') : UNPARSEABLE;
}

/**
 * Render a database connection value for display without credentials.
 *
 * - `postgres://user:pw@host:5432/db?sslpassword=x` →
 *   `postgres://user:***@host:5432/db` (password masked, query and fragment
 *   dropped).
 * - A URL that WHATWG `URL` cannot parse (an unencoded `#`, whitespace or `@`
 *   in the password) is first stripped of its userinfo password and parsed
 *   again; if it still does not parse, only its scheme is shown. The raw
 *   string is never returned.
 * - A libpq keyword DSN (`host=h user=u password=p dbname=d`) keeps only
 *   `host`, `hostaddr`, `port`, `dbname` and `user`.
 * - A bare file path or `:memory:` (SQLite/DuckDB) is returned unchanged.
 *
 * @param value - Connection string, URL, or local database path.
 * @returns A display-safe rendering of `value`.
 */
export function redactDatabaseUrl(value: string): string {
  if (typeof value !== 'string' || value === '') {
    return '';
  }

  const scheme = SCHEME_PATTERN.exec(value)?.[1];
  // A one-letter "scheme" is a Windows drive (`C:\data\dev.db`), not a URL.
  if (!scheme || scheme.length === 1) {
    if (KEYWORD_DSN_PATTERN.test(value)) {
      return redactKeywordDsn(value);
    }
    // A local database path (`./data/dev.db`, `:memory:`): nothing secret.
    return value;
  }

  // Trust a direct parse only when the parser saw the same userinfo a reader
  // would: the `@` sits inside the authority (before the first `/`, `?` or
  // `#`), or there is no userinfo-shaped `scheme://user:…@` at all. Otherwise
  // a password holding an unencoded `/`, `?` or `#` after digits
  // (`owner:2024/Xy9@host`) parses as host `owner`, port `2024`, and the
  // password would ride along in the path; strip the userinfo through the
  // last `@` on the line and parse that instead.
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1];
  USERINFO_PATTERN.lastIndex = 0;
  const hasUserinfoShape = USERINFO_PATTERN.test(value);
  USERINFO_PATTERN.lastIndex = 0;
  const direct =
    hasUserinfoShape && !authority?.includes('@') ? null : tryParseUrl(value);
  const parsed =
    direct ?? tryParseUrl(value.replace(USERINFO_PATTERN, `$1${MASK}@`));
  // Defence in depth: an `@` left in the path is userinfo the parser did not
  // recognise (an opaque `user:pw@host/db`, or a misread authority) — never
  // echo it.
  if (parsed && !parsed.pathname.includes('@')) {
    return renderParsedUrl(parsed);
  }
  return `${scheme.toLowerCase()}://${UNPARSEABLE}`;
}

/**
 * Redact connection-string credentials and secret `key=value` pairs embedded
 * anywhere inside arbitrary text, such as a driver error message or stack.
 *
 * URL passwords become `***` (through the last `@` on the line, so a
 * malformed password cannot leak a tail); any `password=`, `sslpassword=`,
 * `token=`, `authToken=`, `sslkey=`, … value becomes `***`. Non-secret text
 * is left intact. Never throws.
 *
 * @param text - Free text that may quote a connection string.
 * @returns `text` with credentials masked.
 */
export function redactDatabaseUrlsInText(text: string): string {
  if (typeof text !== 'string' || text === '') {
    return typeof text === 'string' ? text : '';
  }
  return maskKeyValuePairs(text.replace(USERINFO_PATTERN, `$1${MASK}@`));
}
