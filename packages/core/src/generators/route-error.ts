/** Server-only diagnostics for opaque HTTP failures. Never pass request data to the logger. */
import { createLogger } from '@happyvertical/logger';
import { redactSecretValues } from '@happyvertical/smrt-config';
import { redactDatabaseUrlsInText } from '../utils/database-url.js';

function diagnosticCause(value: unknown, depth = 0): Record<string, unknown> {
  if (!(value instanceof Error)) return { name: 'NonErrorThrow' };
  const scrub = (text: string) =>
    redactDatabaseUrlsInText(redactSecretValues(text))
      .replace(/\{[\s\S]*\}/g, '[redacted structured data]')
      .slice(0, 8000);
  const code = (value as Error & { code?: unknown }).code;
  return {
    name: scrub(value.name),
    message: scrub(value.message),
    ...(typeof code === 'string' ? { code: scrub(code) } : {}),
    ...(value.stack ? { stack: scrub(value.stack) } : {}),
    ...(depth < 4 && value.cause instanceof Error
      ? { cause: diagnosticCause(value.cause, depth + 1) }
      : {}),
  };
}

/** Log a redacted cause and return only a server-created reference to the client. */
export function reportUnexpectedHttpError(cause: unknown, request: Request) {
  const requestId = crypto.randomUUID();
  try {
    createLogger({ level: 'error' }).error('SMRT HTTP request failed', {
      requestId,
      method: request.method,
      route: new URL(request.url).pathname,
      cause: diagnosticCause(cause),
    });
  } catch {
    // A logger failure must never hide the reference or replace the response.
  }
  return { error: 'Internal server error', requestId };
}
