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
  const minimumLength = options.strict ? 1 : MIN_REDACTED_VALUE_LENGTH;
  let redacted = message;
  const values = Object.entries(environment)
    .filter(
      ([name, value]) =>
        typeof value === 'string' &&
        value.length >= minimumLength &&
        SECRET_ENVIRONMENT_NAME.test(name),
    )
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
  for (const value of values) {
    redacted = redacted.replaceAll(value, '[redacted]');
  }
  return redacted
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]*(?::[^\s/@'"]*)?@/gi,
      '$1[redacted]@',
    )
    .replace(
      /([?&;](?:token|password|secret|key|access_token)=)[^&\s"'<>]+/gi,
      '$1[redacted]',
    )
    .replace(
      options.strict
        ? /\bBearer\s+[A-Za-z0-9._~+/=-]+/g
        : /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
      'Bearer [redacted]',
    );
}
