// A PGlite cannot be shared across threads, and two instances on one storage
// corrupt it, yet a new app worker boots while the old one is still serving.
// So the HOST thread owns the one PGlite and each app worker reaches it through
// a MessagePort: `serveBridge` (host side) executes, `createBridgeClient`
// (worker side) is the `client` `@happyvertical/sql`'s PGlite adapter accepts.
// Transactions hold the real PGlite transaction open on the host until the
// worker ends it; a worker that dies mid-transaction rolls it back.

import type { MessagePort } from 'node:worker_threads';
import type { PGliteClient } from './types.ts';

type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

type Call =
  | { id: number; op: 'query'; sql: string; params?: unknown[] }
  | { id: number; op: 'exec'; sql: string }
  | { id: number; op: 'begin' }
  | { id: number; op: 'tq'; tid: number; sql: string; params?: unknown[] }
  | { id: number; op: 'te'; tid: number; sql: string }
  | { id: number; op: 'rollback'; tid: number }
  | { id: number; op: 'end'; tid: number; commit: boolean };

type Reply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: Record<string, unknown> };

const plain = (r: any) => ({
  rows: r.rows,
  fields: r.fields,
  affectedRows: r.affectedRows,
  rowCount: r.rowCount,
  command: r.command,
});

const packError = (e: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (e && typeof e === 'object')
    for (const k of Object.getOwnPropertyNames(e)) {
      const v = (e as Record<string, unknown>)[k];
      if (typeof v !== 'function') out[k] = v;
    }
  out.message ??= String(e);
  return out;
};

/** Serve `client` (a PGlite owned by this thread) to the worker on the other end of `port`. */
export function serveBridge(client: PGliteClient, port: MessagePort) {
  type Open = {
    tx: any;
    finish: () => void;
    done: Promise<unknown>;
  };
  const open = new Map<number, Open>();
  let nextTx = 1;
  const txOf = (tid: number) => {
    const t = open.get(tid);
    if (!t) throw new Error('the transaction is not open');
    return t.tx;
  };
  const reply = (r: Reply) => port.postMessage(r);
  const handle = async (m: Call): Promise<unknown> => {
    switch (m.op) {
      case 'query':
        return plain(await client.query(m.sql, m.params));
      case 'exec':
        return (await client.exec(m.sql)).map(plain);
      case 'begin': {
        const tid = nextTx++;
        const entry: Partial<Open> = {};
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
          started = resolve;
        });
        const done = client.transaction(async (tx) => {
          await new Promise<void>((finish) => {
            Object.assign(entry, { tx, finish });
            open.set(tid, entry as Open);
            started();
          });
        });
        entry.done = done;
        done.catch(() => {});
        // A transaction that fails to start rejects before it is ready.
        await Promise.race([ready, done]);
        return tid;
      }
      case 'tq':
        return plain(await txOf(m.tid).query(m.sql, m.params));
      case 'te':
        return (await txOf(m.tid).exec(m.sql)).map(plain);
      case 'rollback':
        await txOf(m.tid).rollback();
        return null;
      case 'end': {
        const t = open.get(m.tid);
        open.delete(m.tid);
        if (!t) return null;
        if (!m.commit && !t.tx.closed) await t.tx.rollback().catch(() => {});
        t.finish();
        await t.done;
        return null;
      }
    }
  };
  port.on('message', (m: Call) => {
    handle(m).then(
      (value) => reply({ id: m.id, ok: true, value }),
      (e) => reply({ id: m.id, ok: false, error: packError(e) }),
    );
  });
  const closeAll = () => {
    for (const t of open.values()) {
      if (!t.tx.closed) t.tx.rollback().catch(() => {});
      t.finish();
    }
    open.clear();
  };
  port.on('close', closeAll);
  return () => {
    closeAll();
    port.close();
  };
}

/** Worker side: a PGlite-shaped client over the port. It never closes the real database. */
export async function createBridgeClient(
  port: MessagePort,
): Promise<PGliteClient> {
  const { importPGlite } = await import('@happyvertical/sql/pglite');
  const { messages } = await importPGlite();
  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: unknown) => void }
  >();
  let next = 1;
  port.on('message', (r: Reply) => {
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    if (r.ok) p.resolve(r.value);
    else {
      // The adapter tells statement errors by class: rebuild one, with the
      // fields (`code`, `detail`, ...) PostgreSQL gave.
      const { message, ...rest } = r.error as { message: string };
      const err = new messages.DatabaseError(String(message), 0, 'error');
      Object.assign(err, rest);
      p.reject(err);
    }
  });
  port.on('close', () => {
    for (const p of pending.values())
      p.reject(new Error('the database bridge closed'));
    pending.clear();
  });
  const call = (m: DistributiveOmit<Call, 'id'>) =>
    new Promise<any>((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      port.postMessage({ ...m, id });
    });
  return {
    query: (sql, params) => call({ op: 'query', sql, params }),
    exec: (sql) => call({ op: 'exec', sql }),
    async transaction(cb) {
      const tid: number = await call({ op: 'begin' });
      let closed = false;
      const tx = {
        query: (sql: string, params?: unknown[]) =>
          call({ op: 'tq', tid, sql, params }),
        exec: (sql: string) => call({ op: 'te', tid, sql }),
        async rollback() {
          closed = true;
          await call({ op: 'rollback', tid });
        },
        get closed() {
          return closed;
        },
      };
      let result: Awaited<ReturnType<typeof cb>>;
      try {
        result = await cb(tx);
      } catch (e) {
        await call({ op: 'end', tid, commit: false }).catch(() => {});
        throw e;
      }
      await call({ op: 'end', tid, commit: true });
      return result;
    },
    async close() {},
  };
}
