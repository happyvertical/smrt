/**
 * Redact secret-shaped substrings from a job error message before it is
 * persisted to the `_smrt_jobs.last_error` column.
 *
 * @remarks
 * `last_error` is durable and readable through generated `list`/`get` routes
 * (now tenant-scoped — see {@link "./smrt-job".SmrtJob}). Error messages thrown
 * from a failing job frequently echo back the arguments or environment that
 * caused the failure: a database URL with embedded credentials, a `Bearer`
 * token, an `Authorization` header, an API key, or a `key=value` secret pair.
 * Persisting those verbatim turns a transient failure into a durable credential
 * leak (S5 audit #1402).
 *
 * The policy biases toward over-redaction: matching a benign string is a
 * cosmetic loss, while leaking a credential is a security incident. Patterns are
 * intentionally conservative and order-independent — each is applied globally so
 * multiple secrets in one message are all masked.
 */

const REDACTED = '***REDACTED***';

/**
 * Credentials embedded in a URL userinfo segment:
 * `scheme://user:pass@host` → `scheme://***REDACTED***@host`.
 * The host is preserved so the message stays diagnosable.
 */
const CREDENTIAL_URL_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]+@/gi;

/**
 * `Bearer <token>` / `token <token>` style authorization values.
 */
const BEARER_TOKEN_RE = /\b(bearer|token)\s+[A-Za-z0-9._\-+/=]{8,}/gi;

/**
 * An `Authorization:` header value (covers Basic/Bearer/etc.). Captures the
 * scheme word plus the credential token that follows it so the whole value is
 * masked, not just the scheme.
 */
const AUTHORIZATION_HEADER_RE =
  /\bauthorization\s*[:=]\s*(?:[A-Za-z]+\s+)?[^\s,;)]+/gi;

/**
 * Common secret-bearing `key=value` / `key: value` pairs. The key portion is
 * preserved so the shape of the failure remains legible; only the value is
 * masked. Matches camelCase / snake_case / kebab / UPPER variants.
 */
const SECRET_KEY_VALUE_RE =
  /\b([A-Za-z0-9_-]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|token|credential|auth)[A-Za-z0-9_-]*)\s*([:=])\s*("[^"]*"|'[^']*'|[^\s,;)]+)/gi;

/**
 * Secret-bearing keys written as JSON object members, e.g.
 * `{"password":"x"}` or `{ "apiKey" : "y" }`. The generic key=value rule above
 * cannot see these because the key is wrapped in quotes (so the separator does
 * not immediately follow the key word). The quoted key is preserved; only the
 * quoted value is masked (S5 audit #1402).
 */
const JSON_SECRET_KEY_VALUE_RE =
  /("(?:[A-Za-z0-9_-]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|token|credential|auth)[A-Za-z0-9_-]*)")\s*:\s*"[^"]*"/gi;

/**
 * Provider-recognizable standalone secrets that may appear without a key:
 * OpenAI `sk-...` (incl. hyphenated project keys like `sk-proj-...`) /
 * `sk_live_...` / `sk_test_...`, AWS access key id (`AKIA...`), GitHub tokens
 * (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`), Google API keys (`AIza...`), and Slack
 * bot/user tokens (`xoxb-`/`xoxp-`) (S5 audit #1402).
 *
 * The OpenAI patterns allow internal hyphens/underscores in the token *body*
 * (after the `sk-`/`sk_` prefix) so segmented keys such as `sk-proj-ABC123...`
 * are matched whole rather than truncated at the first separator. The body must
 * end on an alphanumeric so a trailing separator is not swallowed, and a length
 * floor keeps short benign `sk-foo` tokens from over-matching.
 */
const STANDALONE_SECRET_RE =
  /\b(sk-[A-Za-z0-9_-]{14,}[A-Za-z0-9]|sk_(?:live|test)_[A-Za-z0-9_-]{14,}[A-Za-z0-9]|AKIA[0-9A-Z]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|xox[bp]-[A-Za-z0-9-]{10,})\b/g;

/**
 * Mask secret-shaped substrings in an error message.
 *
 * Strictly `string => string`: pass a known message here. For an arbitrary
 * throwable of unknown shape (e.g. a caught `unknown`), call
 * {@link redactErrorForPersistence} instead — it coerces non-`Error` values to
 * a string first. The runtime non-string guard below is defensive depth only;
 * the type contract is that callers supply a string.
 *
 * @param message - Raw error message (e.g. `error.message`).
 * @returns The message with credential-like substrings replaced by
 *   `***REDACTED***`. Empty input is returned unchanged.
 *
 * @example
 * ```ts
 * redactErrorMessage('connect failed: postgres://u:p@db/app')
 * // => 'connect failed: postgres://***REDACTED***@db/app'
 * redactErrorMessage('401 from api: apiKey=<the-key>')
 * // => '401 from api: apiKey=***REDACTED***'
 * ```
 */
export function redactErrorMessage(message: string): string {
  if (typeof message !== 'string' || message.length === 0) {
    return message;
  }

  return (
    message
      .replace(CREDENTIAL_URL_RE, `$1${REDACTED}@`)
      // Authorization headers run before the generic key=value rule so the
      // full `<scheme> <token>` value is masked rather than just the scheme.
      .replace(AUTHORIZATION_HEADER_RE, `authorization=${REDACTED}`)
      .replace(BEARER_TOKEN_RE, `$1 ${REDACTED}`)
      // JSON-shaped secrets run before the generic key=value rule (which cannot
      // match a quoted key) so `{"password":"x"}` is masked to a valid shape.
      .replace(JSON_SECRET_KEY_VALUE_RE, `$1:"${REDACTED}"`)
      .replace(SECRET_KEY_VALUE_RE, `$1$2${REDACTED}`)
      .replace(STANDALONE_SECRET_RE, REDACTED)
  );
}

/**
 * Redact an arbitrary error's message, tolerating non-Error throwables.
 *
 * @param error - Anything thrown (`Error`, string, or unknown).
 * @returns A redacted message string suitable for persistence.
 */
export function redactErrorForPersistence(error: unknown): string {
  if (error instanceof Error) {
    return redactErrorMessage(error.message);
  }
  return redactErrorMessage(String(error));
}
