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

/** URL userinfo (`scheme://user:pass@`); group 2 is the credential span. */
const URL_USERINFO =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:'"]*(?::[^\s/@'"]*)?)@/dgi;

/** Query/parameter credential (`?token=…`); group 2 is the value span. */
const QUERY_CREDENTIAL =
  /([?&;](?:token|password|secret|key|access_token)=)([^&\s"'<>]+)/dgi;

/** Bearer token; group 2 is the token span (8+ characters unless strict). */
const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/dg;
const BEARER_ANY_LENGTH = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]+)/dg;

type Span = [start: number, end: number];

function structuralSpans(text: string, strict: boolean): Span[] {
  const spans: Span[] = [];
  for (const pattern of [
    URL_USERINFO,
    QUERY_CREDENTIAL,
    strict ? BEARER_ANY_LENGTH : BEARER,
  ]) {
    for (const match of text.matchAll(pattern)) {
      const span = match.indices?.[2];
      // An empty userinfo (`scheme://@`) still gets a marker, as it always did.
      if (span && (span[1] > span[0] || pattern === URL_USERINFO)) {
        spans.push([span[0], span[1]]);
      }
    }
  }
  return spans;
}

function literalSpans(text: string, values: readonly string[]): Span[] {
  const spans: Span[] = [];
  for (const value of values) {
    for (
      let index = text.indexOf(value);
      index !== -1;
      index = text.indexOf(value, index + 1)
    ) {
      spans.push([index, index + value.length]);
    }
  }
  return spans;
}

/** Replace the union of `spans` (overlapping or touching spans merge). */
function maskSpans(text: string, spans: Span[]): string {
  if (spans.length === 0) return text;
  spans.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  let result = '';
  let cursor = 0;
  let [start, end] = spans[0];
  const flush = () => {
    result += text.slice(cursor, start) + REDACTED;
    cursor = end;
  };
  for (const [nextStart, nextEnd] of spans.slice(1)) {
    if (nextStart <= end) {
      end = Math.max(end, nextEnd);
      continue;
    }
    flush();
    [start, end] = [nextStart, nextEnd];
  }
  flush();
  return result + text.slice(cursor);
}

/**
 * Remove secret material from an operator-facing message.
 *
 * Errors raised by drivers, config loaders, and providers routinely echo a
 * connection string, credential, or bootstrap token. Redaction covers:
 * literal values of secret-named environment variables, URL userinfo,
 * `token=`/`password=`/`secret=` query values, and bearer tokens.
 *
 * Every span is located on the raw text and the union is masked at once, so
 * a literal value can never split a structural match (an env value that is
 * a Bearer-token prefix, or a URL's scheme and host, used to leave the rest
 * of the token or the URL password visible). A final structural pass over
 * the masked text keeps everything the earlier sequential order masked.
 */
export function redactSecrets(
  message: string,
  environment: Record<string, string | undefined> = process.env,
  options: RedactSecretsOptions = {},
): string {
  const strict = options.strict === true;
  const minimumLength = strict ? 1 : MIN_REDACTED_VALUE_LENGTH;
  const secretValues = Object.entries(environment)
    .filter(
      ([name, value]) =>
        typeof value === 'string' &&
        value.length >= minimumLength &&
        SECRET_ENVIRONMENT_NAME.test(name),
    )
    .map(([, value]) => value as string);
  const masked = maskSpans(message, [
    ...structuralSpans(message, strict),
    ...literalSpans(message, secretValues),
  ]);
  // Monotone cleanup: only adds masks (e.g. a host the literal pass exposed
  // to the userinfo pattern, or an empty `scheme://@` userinfo).
  return maskSpans(masked, structuralSpans(masked, strict));
}
