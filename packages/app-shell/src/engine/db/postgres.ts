// PostgreSQL (server) and PGlite: the engine's dialect for them, the schema
// scope, and how a worker opens either one. Nothing outside `engine/db/` may
// contain PostgreSQL-specific SQL.
//
// Layout (decided, #5183): one PostgreSQL schema per app, addressed by a
// TRANSACTION-LOCAL `search_path` with UNQUALIFIED table names, so core needs
// no schema-qualified names. `scopeDatabase` is the only code that sets it, and
// it sits beneath the `DatabaseInterface` the engine and core receive, so
// every statement (collections, REST, tools, migrations) is scoped, with or
// without a transaction of its own.

import { getDatabase } from '@happyvertical/sql';
import { EngineError } from '../errors.ts';
import { createBridgeClient } from './pglite-bridge.ts';
import { assertAppSchema } from './schema-name.ts';
import type { WorkerDatabaseConfig } from './types.ts';

type Handle = any;

/** Statements that carry their own scope (they take the same arguments as on the raw handle). */
const STATEMENTS = [
  'query',
  'execute',
  'many',
  'single',
  'pluck',
  'oo',
  'oO',
  'ox',
  'xx',
  'get',
  'list',
  'insert',
  'update',
  'upsert',
  'delete',
  'count',
  'getOrInsert',
  'tableExists',
] as const;

/**
 * Wrap a PostgreSQL/PGlite handle so every statement runs with
 * `search_path = <schema>`, set transaction-locally (`set_config(…, true)`) as
 * the first statement of the transaction it runs in. A statement issued
 * outside any transaction gets a transaction of its own. Fail closed: only
 * the listed operations exist on the result; anything else (`table()`,
 * sessions, schema sync) is absent or throws, never an unscoped path.
 */
export function scopeDatabase<T extends object>(db: T, schema: string): T {
  const path = `"${assertAppSchema(schema)}"`;
  const raw = db as Handle;
  const apply = (h: Handle) =>
    h.query(`SELECT set_config('search_path', ?, true)`, [path]);
  const scoped = <R>(
    run: (tx: Handle) => Promise<R>,
    options?: { introspection?: boolean },
  ): Promise<R> =>
    raw.transaction(async (tx: Handle) => {
      await apply(tx);
      return run(tx);
    }, options);
  const members: Record<string, unknown> = {};
  for (const name of STATEMENTS)
    members[name] = (...args: unknown[]) => scoped((tx) => tx[name](...args));
  members.getTableSchema = (...args: unknown[]) =>
    scoped((tx) => tx.getTableSchema(...args), { introspection: true });
  members.transaction = (
    cb: (tx: Handle) => Promise<unknown>,
    options?: object,
  ) =>
    raw.transaction(async (tx: Handle) => {
      await apply(tx);
      return cb(tx);
    }, options);
  members.beginTransaction = async (options?: object) => {
    const h = await raw.beginTransaction(options);
    try {
      await apply(h);
    } catch (e) {
      await h.rollback?.().catch(() => {});
      throw e;
    }
    return h;
  };
  members.table = () => {
    throw new EngineError(
      'table() is not available on a schema-scoped database',
      'refused',
    );
  };
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.hasOwn(members, prop))
        return members[prop];
      const value = Reflect.get(target, prop, receiver);
      // Anything callable that is not listed would reach the raw handle with
      // the default search_path: hide it, so a caller cannot use it by mistake.
      if (typeof value === 'function' && !PASS_THROUGH.has(String(prop)))
        return undefined;
      return value;
    },
  }) as T;
}

/** Operations that do not touch tables, so need no scope. */
const PASS_THROUGH = new Set(['close', 'reopenOptions', 'constructor']);

/** Open the database a worker was told to open, scoped to its schema. */
export async function openPostgres(
  config: Extract<WorkerDatabaseConfig, { kind: 'postgres' | 'pglite' }>,
) {
  const schema = assertAppSchema(config.schema);
  const raw: Handle =
    config.kind === 'postgres'
      ? await getDatabase({ type: 'postgres', ...config.connection } as any)
      : await getDatabase({
          type: 'pglite',
          client: await createBridgeClient(config.port),
        } as any);
  const found = (
    await raw.query('SELECT 1 AS x FROM pg_namespace WHERE nspname = ?', [
      schema,
    ])
  ).rows;
  if (!found.length) {
    await raw.close?.();
    throw new EngineError(
      `schema ${schema} does not exist; the host creates an app's schema before it starts`,
      'refused',
    );
  }
  return scopeDatabase(raw, schema);
}
