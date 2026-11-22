/**
 * Shared harness for the migration lock's PostgreSQL lanes (#5435): a
 * database of its own per suite, pools standing in for processes, an admin
 * connection that observes and interferes (`pg_stat_activity`, `pg_locks`,
 * `pg_terminate_backend`), barriers that are observed states rather than
 * sleeps, and a TCP proxy that can stop forwarding the server's answers.
 */
import { randomUUID } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { MIGRATION_ADVISORY_LOCK_KEYS } from '../migration-lock.js';

export const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
export const adminUrl =
  process.env.SMRT_TEST_POSTGRES_ADMIN_URL ??
  process.env.SMRT_TEST_POSTGRES_URL;

export interface PgSuite {
  name: string;
  url: string;
  admin: DatabaseInterface;
  /**
   * A new pool (a process stand-in); closed by `close()`. Open pools before
   * registering the models a case migrates: in this test environment opening
   * a connection creates the tables of models already registered, which
   * would leave the migration nothing to do.
   */
  pool(options?: { max?: number; url?: string }): Promise<DatabaseInterface>;
  /** Admin statement in the suite's database. */
  sql(statement: string): Promise<Record<string, unknown>[]>;
  /** The pid granted the migration key, if any. */
  holderPid(): Promise<number | undefined>;
  /** Backends of this database waiting on a lock with a statement matching `match`. */
  waiting(match: RegExp): Promise<number[]>;
  /** Backends whose current statement matches `match` (any state). */
  running(match: RegExp): Promise<number[]>;
  kill(pid: number): Promise<void>;
  close(): Promise<void>;
}

export async function createPgSuite(prefix: string): Promise<PgSuite> {
  const root = await getDatabase({ type: 'postgres', url: adminUrl as string });
  const name = `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const parsed = new URL(pgUrl as string);
  const owner = `"${decodeURIComponent(parsed.username).replace(/"/g, '""')}"`;
  await root.query(`CREATE DATABASE ${name} OWNER ${owner}`);
  parsed.pathname = `/${name}`;
  const url = String(parsed);
  const adminParsed = new URL(adminUrl as string);
  adminParsed.pathname = `/${name}`;
  const admin = await getDatabase({
    type: 'postgres',
    url: String(adminParsed),
    dbid: randomUUID(),
  } as Parameters<typeof getDatabase>[0]);
  const pools: DatabaseInterface[] = [];
  const rows = async (statement: string) =>
    (await admin.query(statement)).rows as Record<string, unknown>[];
  return {
    name,
    url,
    admin,
    async pool(options = {}) {
      const db = await getDatabase({
        type: 'postgres',
        url: options.url ?? url,
        dbid: randomUUID(),
        ...(options.max ? { max: options.max } : {}),
      } as Parameters<typeof getDatabase>[0]);
      pools.push(db);
      return db;
    },
    sql: rows,
    async holderPid() {
      const found = await rows(
        `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 2 AND classid = (hashtext('smrt'))::oid AND objid = (hashtext('db:migrate'))::oid AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
      return found[0]?.pid === undefined ? undefined : Number(found[0].pid);
    },
    async waiting(match) {
      const found = await rows(
        `SELECT pid, query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
      );
      return found
        .filter((row) => match.test(String(row.query)))
        .map((row) => Number(row.pid));
    },
    async running(match) {
      const found = await rows(
        `SELECT pid, query FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
      );
      return found
        .filter((row) => match.test(String(row.query)))
        .map((row) => Number(row.pid));
    },
    async kill(pid) {
      await admin.query(`SELECT pg_terminate_backend(${pid})`);
    },
    async close() {
      for (const db of pools) await db.close?.().catch(() => {});
      await admin.close?.().catch(() => {});
      await root
        .query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        .catch(() => {});
      await root.close?.().catch(() => {});
    },
  };
}

/** Poll `check` until it returns a truthy value or `ms` passes. */
export async function until<T>(
  check: () => Promise<T | undefined | false> | T | undefined | false,
  ms = 10_000,
  label = 'condition',
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** A promise settled from outside, for caller-supplied code to await. */
export function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A session from `db` holding the migration key until `release()`. */
export async function holdKey(db: DatabaseInterface) {
  const session = await db.acquireSession!();
  await session.query(
    `SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEYS})`,
  );
  const pid = Number(
    (await session.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
  );
  return {
    pid,
    release: async () => {
      await session.query(
        `SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEYS})`,
      );
      await session.release();
    },
  };
}

/**
 * A TCP proxy in front of the server. `stall()` stops forwarding the
 * server's bytes to clients (a statement whose answer never arrives);
 * `resume()` forwards again. Closing a client side closes the server side.
 */
export async function createStallProxy(targetUrl: string) {
  const target = new URL(targetUrl);
  let stalled = false;
  const pairs = new Set<{ client: Socket; server: Socket }>();
  const server: Server = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    const pair = { client, server: upstream };
    pairs.add(pair);
    client.on('data', (chunk) => upstream.write(chunk));
    upstream.on('data', (chunk) => {
      if (!stalled) client.write(chunk);
    });
    const end = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on('close', end);
    upstream.on('close', end);
    client.on('error', end);
    upstream.on('error', end);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const proxied = new URL(targetUrl);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(port);
  return {
    url: String(proxied),
    stall() {
      stalled = true;
    },
    resume() {
      stalled = false;
    },
    async close() {
      for (const pair of pairs) {
        pair.client.destroy();
        pair.server.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
