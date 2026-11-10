// What the server log says when a model call fails. The provider's own message
// and HTTP status are what make a rejected request diagnosable (for example
// "input_schema does not support anyOf at the top level"), so they are logged,
// redacted: no keys or tokens, no credentials or query strings in URLs, no
// request body, and a hard length cap. Nothing here reaches the browser.

const MAX = 300;

/** Remove anything that looks like a secret from provider text. */
export function redact(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
      try {
        const u = new URL(raw);
        return `${u.protocol}//${u.host}${u.pathname}`;
      } catch {
        return '[url]';
      }
    })
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{3,}/g, '[redacted-key]')
    .replace(
      /\b(x-api-key|api[-_ ]?key|authorization|token|secret|password)\b(\s*[:=]\s*)\S+/gi,
      '$1$2[redacted]',
    )
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX);
}

/** `Name/CODE status=NNN: redacted provider message`. */
export function describeModelError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const e = error as Error & {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  const code = e.code ? `/${String(e.code)}` : '';
  const status = Number(e.status ?? e.statusCode);
  const message = redact(String(e.message ?? ''));
  return `${e.name}${code}${Number.isFinite(status) && status > 0 ? ` status=${status}` : ''}${message ? `: ${message}` : ''}`;
}
