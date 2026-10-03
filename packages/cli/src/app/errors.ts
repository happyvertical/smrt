/**
 * Shared error helpers for the `smrt app` command group.
 */

/** Read a Node `code` from an unknown thrown value. */
export function errorCode(error: unknown): string | undefined {
  return error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

/** Error carrying a process exit code from a failed child command. */
export class AppCommandError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1, options?: { cause?: unknown }) {
    super(message);
    this.name = 'AppCommandError';
    this.exitCode = exitCode;
    if (options && 'cause' in options) {
      // Kept non-enumerable: a child failure may carry environment material.
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        configurable: true,
      });
    }
  }
}

/**
 * A `smrt app start` whose web process never proved readiness. Carries the
 * already-redacted, bounded tail of that process's output and the private
 * log it came from, for the error envelope.
 */
export class ApplicationStartError extends Error {
  readonly output: string;
  readonly logFile: string;

  constructor(message: string, output: string, logFile: string) {
    super(message);
    this.name = 'ApplicationStartError';
    this.output = output;
    this.logFile = logFile;
  }
}

/** Replacement marker for every redacted value. */
const REDACTED = '[redacted]';

/** Minimum length before an environment value is treated as redactable. */
const MIN_REDACTED_VALUE_LENGTH = 8;

/** Environment names whose values must never reach operator output. */
const SECRET_ENVIRONMENT_NAME =
  /(?:^|_)(?:DATABASE_URL|URL|DSN|TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIALS?|AUTH)(?:_|$)/i;

/** Options for {@link redactSecrets}. */
export interface RedactSecretsOptions {
  /**
   * Redact every non-empty secret-named environment value and every Bearer
   * token, whatever its length. The default keeps an 8-character floor so a
   * short flag value (`SMRT_AUTH_ENABLED=1`) does not erase every `1` from an
   * operator message; arbitrary child-process output (the `start` tail) has
   * no such guarantee about what it prints, so it is redacted strictly.
   */
  strict?: boolean;
}

/**
 * Remove secret material from an operator-facing message.
 *
 * Errors raised by drivers, config loaders, and providers routinely echo a
 * connection string, credential, or bootstrap token. Redaction covers:
 * literal values of secret-named environment variables, URL userinfo,
 * `token=`/`password=`/`secret=` query values, and bearer tokens.
 */
export function redactSecrets(
  message: string,
  environment: Record<string, string | undefined> = process.env,
  options: RedactSecretsOptions = {},
): string {
  const secretValues = Object.entries(environment)
    .filter(
      ([name, value]) =>
        typeof value === 'string' &&
        value !== '' &&
        SECRET_ENVIRONMENT_NAME.test(name),
    )
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
  let redacted = message;
  for (const value of secretValues) {
    if (value.length < MIN_REDACTED_VALUE_LENGTH) continue;
    redacted = redacted.replaceAll(value, REDACTED);
  }
  redacted = redacted
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]*(?::[^\s/@'"]*)?@/gi,
      `$1${REDACTED}@`,
    )
    .replace(
      /([?&;](?:token|password|secret|key|access_token)=)[^&\s"'<>]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, `Bearer ${REDACTED}`);
  if (!options.strict) return redacted;
  // Strict pass, after the patterns so a short value (`/`, `:`) can never
  // break the URL/query/Bearer syntax they match. Existing markers are left
  // intact; only the text between them is searched.
  redacted = redacted.replace(
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
    `Bearer ${REDACTED}`,
  );
  const shortValues = secretValues.filter(
    (value) => value.length < MIN_REDACTED_VALUE_LENGTH,
  );
  if (shortValues.length === 0) return redacted;
  // One alternation (longest first), so a marker inserted for one value is
  // never re-scanned for another.
  const shortPattern = new RegExp(
    shortValues
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|'),
    'g',
  );
  return redacted
    .split(REDACTED)
    .map((segment) => segment.replace(shortPattern, REDACTED))
    .join(REDACTED);
}
