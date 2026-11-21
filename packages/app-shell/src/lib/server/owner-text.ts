// What database-driver text may leave the server as a tool error (#5464, the
// interim boundary; the full one is #5498). Two things are replaced with a
// generic sentence and a short reason, the raw text going to the server log:
//   (a) text that starts with `Database query failed:` (core's
//       DatabaseError.queryFailed: the SQL and the driver's cause), and
//   (b) text naming the configured database host or any IP address.
// Everything else is the owner's own message and passes through unchanged:
// runtime AppError texts, validation, a method's own text, constraint text.
import { isIP } from 'node:net';

const QUERY_FAILED = /^\s*(?:Error:\s*)?Database query failed:\s*(\w*)/i;
const WRITE_VERBS = new Set(['insert', 'update', 'delete', 'upsert']);

const SAVE_FAILED =
  'The request could not be completed: that change could not be saved, try again.';
const DB_UNAVAILABLE =
  'The request could not be completed: the database is unavailable, try again.';

const IPV4 =
  /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\w|\.\d)/;
const IPV6_CANDIDATE = /(?<![\w:])[0-9a-f:.]*:[0-9a-f:.]*(?![\w:])/gi;
// `addr:fd00::7`, `host=fd00::7`, `peer fd00::7`: an address after a label.
const IPV6_LABELLED =
  /\b(?:host|hostname|addr|address|ip|server|peer|remote|local|at|to|from)[:=\s]+\[?([0-9a-f:.]*:[0-9a-f:.]*)/gi;

/** Host names the shell's database is configured with (never user or db names). */
function configuredHosts(): string[] {
  const hosts = new Set<string>();
  const add = (h: string | undefined) => {
    const host = h?.trim().replace(/^\[|\]$/g, '');
    if (host && host.length > 1) hosts.add(host.toLowerCase());
  };
  const url = process.env.DATABASE_URL;
  if (url) {
    try {
      add(new URL(url).hostname);
    } catch {
      // an unparsable URL names no host
    }
  }
  for (const h of (process.env.PGHOST ?? '').split(',')) add(h);
  return [...hosts];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isV6(token: string): boolean {
  // A bare `12:30`, `a::b` or `::` is not an address: it needs a digit.
  return /\d/.test(token) && isIP(token) === 6;
}

function hasIp(text: string): boolean {
  if (IPV4.test(text)) return true;
  // `no route to fd00::7: timed out` ends in punctuation: strip it first.
  for (const m of text.matchAll(IPV6_CANDIDATE))
    if (isV6(m[0].replace(/[:.]+$/, ''))) return true;
  for (const m of text.matchAll(IPV6_LABELLED))
    if (isV6(m[1].replace(/[:.]+$/, ''))) return true;
  return false;
}

/** Whether `text` names the configured database host or any IP address. */
export function leaksHost(text: string): boolean {
  if (hasIp(text)) return true;
  return configuredHosts().some((host) =>
    new RegExp(`(?<![\\w.-])${escapeRegExp(host)}(?![\\w-])`, 'i').test(text),
  );
}

function generic(text: string): string | undefined {
  const failed = QUERY_FAILED.exec(text);
  if (failed)
    return WRITE_VERBS.has(failed[1].toLowerCase())
      ? SAVE_FAILED
      : DB_UNAVAILABLE;
  return leaksHost(text) ? DB_UNAVAILABLE : undefined;
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
