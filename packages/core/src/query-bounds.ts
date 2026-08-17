/**
 * Query bounds for list surfaces (#2367).
 *
 * Every generated read surface — REST, SvelteKit routes, the MCP server and the
 * MCP runtime bootstrap — takes `limit`/`offset` straight from untrusted input.
 * Before this module each one parsed them by hand, and each got it wrong in a
 * different way: `Number.parseInt('abc')` produced `LIMIT NaN` (a 500 from the
 * driver, not a 400 from the API), `Number(x) || 50` silently turned `0` into
 * `50`, and none of them capped the value, so `?limit=100000000` was a
 * single-request table scan on every generated endpoint.
 *
 * This is the one parser they all share. It is deliberately strict on the input
 * (a bound is a non-negative integer or it is a client error) and deliberately
 * forgiving on magnitude (an oversized page is clamped, not rejected, so a
 * caller paging with a too-large window still makes progress instead of
 * receiving an error it cannot act on).
 *
 * The bounds themselves are also available to `SmrtCollection.list()` through
 * the `defaultListLimit` / `maxListLimit` collection options. Those are opt-in:
 * `list()` is the framework's own bulk-read primitive and dozens of internal
 * callers (relationship loaders, junction hydration, `listByIds`) legitimately
 * expect every matching row, so a framework-wide implicit default would
 * silently truncate results rather than bound an attack surface. The bound
 * belongs where untrusted input arrives, which is why the generated surfaces
 * apply it unconditionally and direct programmatic callers opt in.
 */

import { ValidationError } from './errors';

/**
 * Page size a generated list surface uses when the caller supplies none.
 *
 * Matches the value the REST and SvelteKit generators already hard-coded, so
 * adopting the shared parser is not a behavior change for callers that omit
 * `limit`.
 */
export const DEFAULT_LIST_LIMIT = 50;

/**
 * Largest page a generated list surface will serve.
 *
 * Matches the cap `MCPGenerator` already applied in-process, now enforced on
 * every generated surface rather than one of them.
 */
export const MAX_LIST_LIMIT = 1000;

/**
 * A `limit`/`offset` value that cannot be honored.
 *
 * Extends `ValidationError` so the retry classifier never retries it, and
 * carries `status`/`publicMessage` so `normalizeTypedHttpError()` renders it as
 * a structured 400 instead of letting a caller typo become a 500.
 */
export class QueryBoundsError extends ValidationError {
  readonly status = 400;
  readonly publicMessage: string;

  constructor(
    message: string,
    code = 'INVALID_QUERY_BOUNDS',
    details?: Record<string, unknown>,
  ) {
    super(message, code, details);
    this.name = 'QueryBoundsError';
    this.publicMessage = message;
  }
}

/**
 * An `orderBy` term that cannot be honored (#2367).
 *
 * `orderBy` reaches SQL in the identifier position, and until this rail existed
 * it was checked only against `/^[a-zA-Z0-9_]+$/` — so an unknown column
 * produced a driver error and a *sensitive* column produced a working ordering
 * oracle: `?orderBy=api_secret&limit=1` reveals the extreme value of a secret
 * one request at a time, even though the column itself is never serialized.
 * `where` and `select` have rejected sensitive fields since #1540/#1902; this
 * is the same rail for the third identifier-position input.
 */
export class QueryOrderByError extends ValidationError {
  readonly status = 400;
  readonly publicMessage: string;

  constructor(
    message: string,
    publicMessage: string,
    code = 'INVALID_ORDER_BY',
    details?: Record<string, unknown>,
  ) {
    super(message, code, details);
    this.name = 'QueryOrderByError';
    this.publicMessage = publicMessage;
  }
}

/**
 * Options for {@link resolveListLimit} / {@link resolveListOffset}.
 */
export interface ListBoundOptions {
  /** Value used when the input is absent (`null`, `undefined`, or `''`). */
  defaultValue?: number;
  /** Upper bound; larger values are clamped down to it. Omit for none. */
  maxValue?: number;
  /** Parameter name used in the rejection message. */
  parameterName?: string;
}

/**
 * Parse one bound from untrusted input.
 *
 * Accepts a non-negative safe integer, or a string of digits (optionally
 * surrounded by whitespace). Everything else — `'abc'`, `'1.5'`, `'-1'`,
 * `'1e3'`, `NaN`, `Infinity`, booleans, objects — is a client error, because
 * silently substituting a default for a malformed bound hides the caller's bug
 * and returns a page they did not ask for.
 *
 * `0` is preserved rather than folded into the default: `limit=0` means "no
 * rows", which is what the REST surface already did and what the SvelteKit
 * surface's `|| 50` fallback got wrong.
 */
function resolveListBound(raw: unknown, options: ListBoundOptions): number {
  const { defaultValue = 0, maxValue, parameterName = 'bound' } = options;

  if (raw === null || raw === undefined || raw === '') {
    return maxValue !== undefined
      ? Math.min(defaultValue, maxValue)
      : defaultValue;
  }

  let parsed: number;
  if (typeof raw === 'number') {
    parsed = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    // Strict digits only. `Number.parseInt` would accept '12abc' and
    // `Number()` would accept '1e3' and ' 0x10 '; both would then be
    // interpolated into a page size the caller never wrote.
    if (!/^\d+$/.test(trimmed)) {
      throw new QueryBoundsError(
        `Invalid ${parameterName}: '${raw}' is not a non-negative integer.`,
        'INVALID_QUERY_BOUNDS',
        { parameterName, value: raw },
      );
    }
    parsed = Number(trimmed);
  } else {
    throw new QueryBoundsError(
      `Invalid ${parameterName}: expected a non-negative integer, got ${typeof raw}.`,
      'INVALID_QUERY_BOUNDS',
      { parameterName, value: raw },
    );
  }

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new QueryBoundsError(
      `Invalid ${parameterName}: '${String(raw)}' is not a non-negative integer.`,
      'INVALID_QUERY_BOUNDS',
      { parameterName, value: raw },
    );
  }

  return maxValue !== undefined ? Math.min(parsed, maxValue) : parsed;
}

/**
 * Resolve a page size from untrusted input: default when absent, rejected when
 * malformed, clamped when oversized.
 *
 * @throws {QueryBoundsError} when the input is not a non-negative integer
 */
export function resolveListLimit(
  raw: unknown,
  options: ListBoundOptions = {},
): number {
  return resolveListBound(raw, {
    defaultValue: options.defaultValue ?? DEFAULT_LIST_LIMIT,
    maxValue: options.maxValue ?? MAX_LIST_LIMIT,
    parameterName: options.parameterName ?? 'limit',
  });
}

/**
 * Resolve a page offset from untrusted input.
 *
 * Unbounded above by default: an offset past the end of the table returns an
 * empty page, and capping it would silently serve the wrong page instead.
 *
 * @throws {QueryBoundsError} when the input is not a non-negative integer
 */
export function resolveListOffset(
  raw: unknown,
  options: ListBoundOptions = {},
): number {
  return resolveListBound(raw, {
    defaultValue: options.defaultValue ?? 0,
    maxValue: options.maxValue,
    parameterName: options.parameterName ?? 'offset',
  });
}

/**
 * Deterministic default ordering for a generated list page.
 *
 * `LIMIT`/`OFFSET` without `ORDER BY` is not pagination: PostgreSQL may return
 * rows in any order and is free to choose a different one per query, so page 2
 * can repeat or skip rows from page 1. `created_at DESC` alone is not enough
 * either — rows sharing a timestamp still tie — so the primary key follows as a
 * total-order tiebreak.
 *
 * The index that makes this ordering cheap is #2363.
 */
export const DEFAULT_LIST_ORDER_BY: readonly string[] = [
  'created_at DESC',
  'id ASC',
];

/**
 * Deterministic default ordering for a model whose primary key may not be `id`.
 *
 * A class declaring `@field({ primaryKey: true })` on its own column has no
 * synthetic `id` column — schema generation omits `id`/`slug`/`context` for
 * custom-primary-key classes — so `ORDER BY ... id ASC` would name a column
 * that does not exist and fail the whole page. The tiebreak therefore follows
 * the declared key.
 *
 * @param primaryKeyField - the model's primary-key field name in SMRT (not
 *   column) form; `collection.list()` maps it to the column
 */
export function buildDefaultListOrderBy(primaryKeyField = 'id'): string[] {
  return ['created_at DESC', `${primaryKeyField} ASC`];
}
