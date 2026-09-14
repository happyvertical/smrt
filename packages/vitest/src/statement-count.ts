/**
 * Statement-counting test helper (#2875).
 *
 * Turns the hand-rolled `db.query` wrapping in
 * `packages/core/src/__tests__/collection-read-plan-postgres.optional.test.ts`
 * into a reusable instrument, so asserting a database round-trip ceiling is
 * one call instead of a bespoke monkey-patch per test file.
 *
 * Motivated by #2874: a per-object schema-introspection regression (3.7x on
 * an agent-init/migration path) shipped in 0.47.2 and survived to 0.50.0
 * because nothing asserted how many statements initialization issues.
 * `happyvertical/have-config#725` proposes a statement-count ceiling as a
 * required test-design row for per-object/per-row/per-column database work;
 * this is the low-friction instrument that makes complying cheap.
 *
 * Deliberately does **not** offer a wall-clock timing assertion: runner
 * variance makes timing noisy, and its presence would let a required
 * statement-count row be satisfied by a timing check instead. Statement
 * counts are the same shape on SQLite and PostgreSQL, so a ceiling built on
 * this helper can live in the default unit lane rather than only the
 * Postgres-only lane.
 *
 * @packageDocumentation
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';

/** One SQL statement observed during a {@link withStatementCount} scope. */
export interface CountedStatement {
  /** Raw SQL text as issued (tagged-template segments joined with `?`). */
  readonly sql: string;
  /**
   * Whitespace-collapsed, literal-elided form used to group statements by
   * shape. See {@link normalizeStatement}.
   */
  readonly normalized: string;
}

/** One group of statements sharing a normalized shape. */
export interface StatementShapeGroup {
  /** The normalized statement shape shared by every statement in the group. */
  readonly shape: string;
  /** Number of statements matching this shape. */
  readonly count: number;
  /** Up to a few raw examples of statements matching this shape. */
  readonly examples: readonly string[];
}

/** Result of running a scope through {@link withStatementCount}. */
export interface StatementCountResult<T> {
  /** The wrapped callback's own return value. */
  readonly result: T;
  /** Every statement observed, in issue order. */
  readonly statements: readonly CountedStatement[];
  /** `statements.length`, provided directly for the common `expect(count)...` case. */
  readonly count: number;
  /** Statements grouped by normalized shape, descending by count. */
  readonly byShape: readonly StatementShapeGroup[];
}

/**
 * The raw-statement-issuing surface of `DatabaseInterface`: the string-SQL
 * `query()` plus the tagged-template `many`/`single`/`pluck`/`execute` and
 * their `oo`/`oO`/`ox`/`xx` aliases. Each of `oo`/`oO`/`ox`/`xx` is assigned
 * the *same* function reference as its long-form counterpart at construction
 * time in `@happyvertical/sql` (`oo: many`, `oO: single`, ...), not a
 * dynamic passthrough — wrapping `many` alone leaves calls made through
 * `db.oo` pointing at the original implementation, so every alias needs its
 * own independent wrap.
 *
 * The higher-level convenience methods (`insert`/`get`/`list`/`update`/
 * `upsert`/`delete`/`count`/`getOrInsert`/`table`) are intentionally *not*
 * instrumented: in every `@happyvertical/sql` adapter they call the
 * underlying transport directly through a private closure, not through the
 * object's own `query`/`many`/... properties, so wrapping those properties
 * cannot observe them from outside the adapter. The schema-introspection and
 * migration paths this helper exists to guard (`SchemaComparer.compare()`,
 * `detectRenameDataPending()`, `live-parity.ts`) issue their statements
 * through `query()`, matching this helper's scope; a test that instead
 * exercises code going through the convenience CRUD methods will not have
 * those statements counted.
 */
const STATEMENT_METHODS = [
  'query',
  'many',
  'single',
  'pluck',
  'execute',
  'oo',
  'oO',
  'ox',
  'xx',
] as const;

const MAX_EXAMPLES_PER_SHAPE = 3;

function extractSqlText(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') {
    return first;
  }
  if (Array.isArray(first)) {
    // Tagged-template call (many/single/pluck/execute and their oo/oO/ox/xx
    // aliases): `first` is the TemplateStringsArray. Join its literal
    // segments so the reconstructed text is still recognizable without
    // needing to interleave the actual bound values.
    return (first as readonly string[]).join('?');
  }
  return String(first);
}

/**
 * Collapse whitespace and elide literal values so statements that differ
 * only by parameter values, positional placeholder numbers, or numeric
 * literals group under one shape.
 *
 * Exported so a caller with a more precise notion of "same shape" for their
 * own statements (e.g. eliding a loop-generated identifier) can post-process
 * {@link CountedStatement.sql} the same way this helper does by default.
 */
export function normalizeStatement(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\$\d+/g, '$N') // PostgreSQL positional placeholders: $1, $2, ...
    .replace(/'(?:[^'\\]|\\.)*'/g, "'?'") // single-quoted string literals
    .replace(/\b\d+\b/g, '?'); // standalone numeric literals
}

function groupByShape(
  statements: readonly CountedStatement[],
): StatementShapeGroup[] {
  const groups = new Map<string, { count: number; examples: string[] }>();
  for (const statement of statements) {
    let group = groups.get(statement.normalized);
    if (!group) {
      group = { count: 0, examples: [] };
      groups.set(statement.normalized, group);
    }
    group.count += 1;
    if (group.examples.length < MAX_EXAMPLES_PER_SHAPE) {
      group.examples.push(statement.sql);
    }
  }
  return [...groups.entries()]
    .map(([shape, { count, examples }]) => ({ shape, count, examples }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Instrument every statement-issuing method on `target` so each call is
 * recorded into `statements`, then delegates to the original implementation.
 *
 * Also instruments `transaction()`/`beginTransaction()`/`acquireSession()` so
 * any transaction or pinned-session handle a wrapped call produces is itself
 * instrumented before the caller ever sees it. Each is built from an
 * independent set of closures/state over its own connection in
 * `@happyvertical/sql` — a counter that only wraps the outer handle would
 * under-count work done inside `beginTransaction()`/`transaction(cb)` or on
 * an `acquireSession()` handle, and yield a falsely passing ceiling (the
 * #2862 bootstrap path is exactly this shape for transactions; the
 * PostgreSQL-only concurrent-index migration phase, pinned via
 * `acquireSession()`, is the same shape for sessions). Wrapping is applied
 * recursively, so a nested `tx.transaction()` is covered too.
 *
 * Transaction handles are scoped to a single callback/statement and
 * discarded afterwards — nothing else holds a reference to reuse them, so
 * they are never restored. `target` itself may be a long-lived handle shared
 * across tests, so restoring it is the caller's responsibility (see the
 * `finally` in {@link withStatementCount}).
 *
 * `instrumented` de-duplicates wrapping within one {@link withStatementCount}
 * session: on PostgreSQL, `@happyvertical/sql`'s nested-transaction scope
 * (`tx.transaction()` called on a handle already obtained from
 * `db.transaction()`/`db.beginTransaction()`) hands the nested callback the
 * *exact same object* as the enclosing handle, so it can see the enclosing
 * transaction's uncommitted rows on one pooled connection. Re-instrumenting
 * that shared object would wrap the wrapper, double-counting every statement
 * the handle issues for the rest of the enclosing transaction. SQLite,
 * DuckDB, and JSON mint a fresh scope object per nesting level and are
 * unaffected either way.
 *
 * @returns A `restore()` function that puts every method this call touched
 *   back to its original implementation on `target`. Safe to call more than
 *   once. A no-op when `target` was already instrumented by an earlier call
 *   in the same session — that earlier call owns the wrap and its restore.
 */
function instrument(
  target: DatabaseInterface,
  statements: CountedStatement[],
  instrumented: WeakSet<object> = new WeakSet(),
): () => void {
  if (instrumented.has(target)) {
    return () => {};
  }
  instrumented.add(target);

  const mutable = target as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();

  for (const method of STATEMENT_METHODS) {
    const original = mutable[method];
    if (typeof original !== 'function') {
      continue;
    }
    originals.set(method, original);
    mutable[method] = (...args: unknown[]) => {
      const sql = extractSqlText(args);
      statements.push({ sql, normalized: normalizeStatement(sql) });
      return (original as (...callArgs: unknown[]) => unknown).call(
        target,
        ...args,
      );
    };
  }

  const originalTransaction = target.transaction;
  if (typeof originalTransaction === 'function') {
    originals.set('transaction', originalTransaction);
    mutable.transaction = (
      callback: (tx: DatabaseInterface) => Promise<unknown>,
    ) =>
      originalTransaction.call(target, (tx: DatabaseInterface) => {
        instrument(tx, statements, instrumented);
        return callback(tx);
      });
  }

  const originalBeginTransaction = target.beginTransaction;
  if (typeof originalBeginTransaction === 'function') {
    originals.set('beginTransaction', originalBeginTransaction);
    mutable.beginTransaction = async (...args: unknown[]) => {
      const tx = await (
        originalBeginTransaction as (...callArgs: unknown[]) => unknown
      ).call(target, ...args);
      instrument(tx as DatabaseInterface, statements, instrumented);
      return tx;
    };
  }

  // Pinned single-connection session handles (DatabaseInterface#acquireSession)
  // are a third independent-handle accessor alongside transaction()/
  // beginTransaction() -- @happyvertical/sql's migration tracker uses one to
  // pin the concurrent-index phase on PostgreSQL (SET lock_timeout, the
  // pg_index invalid-index scan, DROP/CREATE INDEX CONCURRENTLY), falling
  // back to the plain db.query() on single-connection adapters. A
  // SessionHandle only exposes query/isActive/release -- no transaction of
  // its own -- but its query is a plain object property callers look up
  // dynamically (`session.query(...)`), not a closure-captured reference, so
  // instrumenting it here is externally observable exactly like the
  // STATEMENT_METHODS loop above. Left uninstrumented, a PostgreSQL-only
  // migration ceiling would silently under-count relative to the identical
  // SQLite run -- the same falsely-passing gap #2862 already guards against
  // for transactions, through this other accessor.
  const originalAcquireSession = target.acquireSession;
  if (typeof originalAcquireSession === 'function') {
    originals.set('acquireSession', originalAcquireSession);
    mutable.acquireSession = async (...args: unknown[]) => {
      const session = await (
        originalAcquireSession as (...callArgs: unknown[]) => unknown
      ).call(target, ...args);
      instrument(session as DatabaseInterface, statements, instrumented);
      return session;
    };
  }

  return () => {
    instrumented.delete(target);
    for (const [method, original] of originals) {
      mutable[method] = original;
    }
  };
}

/**
 * Run `fn` against `db`, counting every SQL statement issued through it —
 * including through any transaction handle `fn` opens with
 * `db.transaction()`/`db.beginTransaction()` — and returning both the total
 * and a grouped, normalized breakdown.
 *
 * Restores every method it touches on `db` in a `finally`, even if `fn`
 * throws, so instrumentation never leaks into a later use of a shared
 * handle (the failure mode of the hand-rolled precedent this replaces).
 *
 * @example Basic ceiling
 * ```typescript
 * const { result, count } = await withStatementCount(db, (countedDb) =>
 *   doWorkThatShouldNotScalePerObject(countedDb),
 * );
 * expect(count).toBeLessThanOrEqual(30); // 71 registered objects
 * ```
 *
 * @example Actionable failure via {@link expectStatementCeiling}
 * ```typescript
 * const statementResult = await withStatementCount(db, (countedDb) =>
 *   migrateSmrtSchemas(countedDb, manifest),
 * );
 * expectStatementCeiling(statementResult, 30);
 * ```
 */
export async function withStatementCount<T>(
  db: DatabaseInterface,
  fn: (countedDb: DatabaseInterface) => Promise<T>,
): Promise<StatementCountResult<T>> {
  const statements: CountedStatement[] = [];
  const restore = instrument(db, statements);
  try {
    const result = await fn(db);
    return {
      result,
      statements,
      count: statements.length,
      byShape: groupByShape(statements),
    };
  } finally {
    restore();
  }
}

const DEFAULT_TOP_SHAPES = 10;

/**
 * Assert a statement-count ceiling from a {@link withStatementCount} result,
 * formatting the grouped shape breakdown into the failure message so a blown
 * ceiling points at *which* statement multiplied instead of just a number.
 *
 * A no-op when `count <= ceiling`.
 *
 * @param statementResult - The `count`/`byShape` fields of a
 *   {@link withStatementCount} result (or a hand-built equivalent).
 * @param ceiling - The maximum number of statements allowed.
 * @param options.topShapes - How many of the highest-count shapes to include
 *   in the failure message. Defaults to 10.
 */
export function expectStatementCeiling(
  statementResult: Pick<StatementCountResult<unknown>, 'count' | 'byShape'>,
  ceiling: number,
  options: { topShapes?: number } = {},
): void {
  const { count, byShape } = statementResult;
  if (count <= ceiling) {
    return;
  }
  const topShapes = options.topShapes ?? DEFAULT_TOP_SHAPES;
  const breakdown = byShape
    .slice(0, topShapes)
    .map((group) => `  ${String(group.count).padStart(6)}  ${group.shape}`)
    .join('\n');
  expect.fail(
    `statement count ceiling exceeded: expected <= ${ceiling}, got ${count}\n` +
      `top statement shapes:\n${breakdown}`,
  );
}
