// What database-driver text may leave the server as a tool error (#5464, the
// interim boundary; the full one is #5498). Only one thing is replaced with a
// generic sentence and a short reason, the raw text going to the server log:
// text that starts with `Database query failed:` (core's
// DatabaseError.queryFailed: the SQL and the driver's cause). Address-shaped
// leaks (host names, IPs) in other text are left to the full boundary (#5498).
// Everything else is the owner's own message and passes through unchanged:
// runtime AppError texts, validation, a method's own text, constraint text.
const QUERY_FAILED = /^\s*(?:Error:\s*)?Database query failed:\s*(\w*)/i;
const WRITE_VERBS = new Set(['insert', 'update', 'delete', 'upsert']);

const SAVE_FAILED =
  'The request could not be completed: that change could not be saved, try again.';
const DB_UNAVAILABLE =
  'The request could not be completed: the database is unavailable, try again.';

function generic(text: string): string | undefined {
  const failed = QUERY_FAILED.exec(text);
  if (failed)
    return WRITE_VERBS.has(failed[1].toLowerCase())
      ? SAVE_FAILED
      : DB_UNAVAILABLE;
  return undefined;
}

function log(where: string, raw: string): void {
  // biome-ignore lint/suspicious/noConsole: the server log is the one place the raw driver text goes (#5464)
  console.error(`[owner-text] ${where}: ${raw.slice(0, 1000)}`);
}

/** The text an owner may see: `raw` unchanged, or the generic text (raw is logged). */
export function ownerText(raw: string, where = 'tool error'): string {
  const replaced = generic(raw);
  if (replaced === undefined) return raw;
  log(where, raw);
  return replaced;
}

/** `value` with every string owner-safe; the same object when nothing changed. */
function scrubValue(value: unknown, where: string): unknown {
  if (typeof value === 'string') return ownerText(value, where);
  if (!value || typeof value !== 'object') return value;
  const isArray = Array.isArray(value);
  const entries = Object.entries(value as object);
  let changed = false;
  const next = entries.map(([k, v]) => {
    const clean = scrubValue(v, where);
    if (clean !== v) changed = true;
    return [k, clean] as const;
  });
  if (!changed) return value;
  return isArray ? next.map(([, v]) => v) : Object.fromEntries(next);
}

function withText<C extends { text: string }>(c: C, where: string): C {
  const text = scrubContentText(c.text, where);
  return text === c.text ? c : { ...c, text };
}

function scrubContentText(text: string, where: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      const clean = scrubValue(parsed, where);
      return JSON.stringify(clean) === JSON.stringify(parsed)
        ? text
        : JSON.stringify(clean);
    } catch {
      // not JSON: treat as text
    }
  }
  return ownerText(text, where);
}

/** An error result's texts, scrubbed; any other result is returned as is. */
export function ownerResult<T>(result: T, where = 'tool result'): T {
  const r = result as
    | { isError?: boolean; content?: unknown; structuredContent?: unknown }
    | null
    | undefined;
  if (!r || typeof r !== 'object' || r.isError !== true) return result;
  const content = Array.isArray(r.content)
    ? r.content.map((c) =>
        c &&
        typeof c === 'object' &&
        typeof (c as { text?: unknown }).text === 'string'
          ? withText(c as { text: string }, where)
          : c,
      )
    : r.content;
  const structuredContent =
    r.structuredContent === undefined
      ? undefined
      : scrubValue(r.structuredContent, where);
  const same =
    structuredContent === r.structuredContent &&
    (!Array.isArray(content) ||
      (content as unknown[]).every(
        (c, i) => c === (r.content as unknown[])[i],
      ));
  if (same) return result;
  return {
    ...r,
    content,
    ...(structuredContent === undefined ? {} : { structuredContent }),
  } as T;
}

/**
 * A returned non-2xx REST response (`{ status, body }`, no `isError`) with its
 * string `body` made owner-safe by the same rule; the same object otherwise.
 */
export function ownerRestFailure<T>(result: T, where = 'rest result'): T {
  const r = result as { status?: unknown; body?: unknown } | null | undefined;
  if (
    !r ||
    typeof r !== 'object' ||
    typeof r.status !== 'number' ||
    (r.status >= 200 && r.status <= 299) ||
    typeof r.body !== 'string'
  )
    return result;
  const body = scrubContentText(r.body, where);
  return body === r.body ? result : ({ ...r, body } as T);
}

/** A thrown error, its message made owner-safe in place (class and codes kept). */
export function ownerError(error: unknown, where = 'tool error'): unknown {
  if (!(error instanceof Error)) return error;
  const replaced = generic(error.message);
  if (replaced === undefined) return error;
  log(where, error.stack ?? error.message);
  error.message = replaced;
  return error;
}

/** Run `fn`; its result and any thrown error leave owner-safe. */
export async function ownerSafe<T>(
  where: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return ownerResult(await fn(), where);
  } catch (error) {
    throw ownerError(error, where);
  }
}
