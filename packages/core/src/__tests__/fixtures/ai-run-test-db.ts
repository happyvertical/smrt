/**
 * Real in-memory databases with the system tables, for the AI run lifecycle
 * and accounting tests (#5005). SQLite and DuckDB always; PGlite when the
 * lane sets `SMRT_TEST_PGLITE=1` (`pnpm test:pglite`). Never mocks the
 * database.
 */

import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { ensureSystemTables } from '../../system/bootstrap';
import { getTestDatabase } from '../../testing/database';

export type AiRunTestEngine = 'sqlite' | 'duckdb' | 'pglite';

export const aiRunTestEngines: AiRunTestEngine[] = [
  'sqlite',
  'duckdb',
  ...(process.env.SMRT_TEST_PGLITE === '1' ? (['pglite'] as const) : []),
];

const open: DatabaseInterface[] = [];

export async function closeAiRunTestDatabases(): Promise<void> {
  for (const db of open.splice(0)) await db.close?.();
}

export async function newAiRunTestDatabase(
  engine: AiRunTestEngine,
  url = ':memory:',
): Promise<DatabaseInterface> {
  const db =
    engine === 'pglite'
      ? await getTestDatabase({
          type: 'pglite',
          classes: [],
          includeSystemTables: false,
        })
      : ((await getDatabase({ type: engine, url })) as DatabaseInterface);
  open.push(db);
  await ensureSystemTables(db, engine === 'pglite' ? 'postgres' : engine);
  return db;
}

export function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** A normalized usage event for a call. */
export function usageEvent(
  totalTokens: number | null,
  estimatedCost?: number,
  tags: Record<string, string> = {},
): SmrtAiUsageEvent {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    operation: 'message',
    usage:
      totalTokens === null
        ? undefined
        : {
            promptTokens: Math.floor(totalTokens / 2),
            completionTokens: totalTokens - Math.floor(totalTokens / 2),
            totalTokens,
          },
    duration: 5,
    timestamp: new Date(),
    tags,
    ...(estimatedCost !== undefined ? { estimatedCost } : {}),
  };
}

/**
 * Record every statement run on `db`, on the handle and inside its
 * transactions; returns the restore function.
 */
export function recordStatements(
  db: DatabaseInterface,
  onStatement: (sql: string, params: unknown[]) => void,
): () => void {
  const wrap = (handle: DatabaseInterface): DatabaseInterface =>
    new Proxy(handle, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === 'query' && typeof value === 'function') {
          return (sql: string, ...params: unknown[]) => {
            onStatement(sql.replace(/\s+/g, ' ').trim(), params);
            return value.call(target, sql, ...params);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const mutable = db as unknown as {
    query: DatabaseInterface['query'];
    transaction?: DatabaseInterface['transaction'];
  };
  const originalQuery = mutable.query;
  const originalTransaction = mutable.transaction;
  mutable.query = ((sql: string, ...params: unknown[]) => {
    onStatement(sql.replace(/\s+/g, ' ').trim(), params);
    return originalQuery.call(db, sql, ...params);
  }) as DatabaseInterface['query'];
  if (originalTransaction) {
    mutable.transaction = ((
      operation: (tx: DatabaseInterface) => Promise<unknown>,
      ...rest: unknown[]
    ) =>
      (originalTransaction as (...args: unknown[]) => Promise<unknown>).call(
        db,
        (tx: DatabaseInterface) => operation(wrap(tx)),
        ...rest,
      )) as DatabaseInterface['transaction'];
  }
  return () => {
    mutable.query = originalQuery;
    if (originalTransaction) mutable.transaction = originalTransaction;
  };
}

/** Whether a statement names its tenant as a predicate. */
export function hasTenantPredicate(sql: string): boolean {
  return /tenant_id (=|IS NULL)/.test(sql);
}
