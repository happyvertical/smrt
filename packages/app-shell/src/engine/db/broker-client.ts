// The worker's side of the database broker (#5188; the host's side is
// `broker.ts`). The worker holds no connection: `createTransport` is its end of
// the MessagePort, `brokerClient` the PGlite-shaped client `@happyvertical/sql`
// accepts, and `BrokeredDatabase` the per-operation scope that decides which of
// the host's open transactions a statement belongs to.
//
// An operation runs inside `run`: the host opens its transaction (and writes
// the caller's role and settings) before the first statement, and the handle
// `current()` returns belongs to that operation alone. Operations of one
// worker run one at a time (`app-worker.ts`), so a statement's operation is
// always the one `AsyncLocalStorage` names; the handle is revoked (`ended`) when
// the operation finishes, whatever still holds it.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { MessagePort } from 'node:worker_threads';
import { OperationEndedError } from '../errors.ts';
import { BOOT_OP } from '../worker-protocol.ts';
import type { PGliteClient } from './types.ts';

type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

type Call =
  | { id: number; kind: 'open'; opId: number }
  | { id: number; kind: 'q'; opId: number; sql: string; params?: unknown[] }
  | { id: number; kind: 'x'; opId: number; sql: string };

type Reply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: Record<string, unknown> };

/** One operation's scope: its id, whether it is over, and the handle it was given. */
export interface OpScope {
  readonly opId: number;
  ended: boolean;
  /** Savepoint counter of this operation's transaction. */
  sp: number;
  handle?: any;
}

const store = new AsyncLocalStorage<OpScope>();

/** The running operation's scope, or `OperationEndedError`. */
export function currentOp(): OpScope {
  const s = store.getStore();
  if (!s || s.ended) throw new OperationEndedError();
  return s;
}

export interface Transport {
  call(m: DistributiveOmit<Call, 'id'>): Promise<any>;
}

/**
 * The error the host packed (`packError`): the adapter tells statement errors
 * by class, so rebuild one with the fields (`code`, `detail`, ...) PostgreSQL
 * gave, and rebuild each `cause` the same way so the SQLSTATE is found there.
 */
export function rebuildError(
  DatabaseError: new (m: string, n: number, l: string) => Error,
  packed: Record<string, unknown>,
): Error {
  const { message, cause, ...rest } = packed as {
    message: string;
    cause?: Record<string, unknown>;
  };
  const err = new DatabaseError(String(message), 0, 'error');
  Object.assign(err, rest);
  if (cause && typeof cause === 'object')
    (err as { cause?: unknown }).cause = rebuildError(DatabaseError, cause);
  return err;
}

/** The worker's end of the port: numbered calls and their replies. */
export async function createTransport(port: MessagePort): Promise<Transport> {
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
    else p.reject(rebuildError(messages.DatabaseError, r.error));
  });
  port.on('close', () => {
    for (const p of pending.values())
      p.reject(new Error('the database broker closed'));
    pending.clear();
  });
  return {
    call: (m) =>
      new Promise<any>((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        port.postMessage({ ...m, id });
      }),
  };
}

/**
 * The PGlite-shaped client over the transport. Every statement belongs to the
 * running operation; outside one, or after it ended, it throws. A nested
 * `transaction` is a savepoint inside the operation's transaction (the real
 * COMMIT is the host's, after the operation returns).
 */
export function brokerClient(transport: Transport): PGliteClient {
  const query = (scope: OpScope, sql: string, params?: unknown[]) => {
    if (scope.ended) throw new OperationEndedError();
    return transport.call({ kind: 'q', opId: scope.opId, sql, params });
  };
  const exec = (scope: OpScope, sql: string) => {
    if (scope.ended) throw new OperationEndedError();
    return transport.call({ kind: 'x', opId: scope.opId, sql });
  };
  return {
    query: async (sql, params) => query(currentOp(), sql, params),
    exec: async (sql) => exec(currentOp(), sql),
    async transaction(cb) {
      // The handle `cb` gets is pinned to the operation that opened it.
      const scope = currentOp();
      const name = `"sp_${++scope.sp}"`;
      await query(scope, `SAVEPOINT ${name}`);
      let closed = false;
      const settle = async (undo: boolean) => {
        closed = true;
        if (undo) await query(scope, `ROLLBACK TO SAVEPOINT ${name}`);
        await query(scope, `RELEASE SAVEPOINT ${name}`);
      };
      const tx = {
        query: async (sql: string, params?: unknown[]) =>
          query(scope, sql, params),
        exec: async (sql: string) => exec(scope, sql),
        async rollback() {
          if (!closed) await settle(true);
        },
        get closed() {
          return closed;
        },
      };
      let result: Awaited<ReturnType<typeof cb>>;
      try {
        result = await cb(tx);
      } catch (e) {
        if (!closed && !scope.ended) await settle(true).catch(() => {});
        throw e;
      }
      if (!closed) await settle(false);
      return result;
    },
    async close() {},
  };
}

/** `base` with every call pinned to `scope`: revoked when the operation ends. */
function pin<T extends object>(scope: OpScope, base: T): T {
  return new Proxy(base, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (scope.ended) return Promise.reject(new OperationEndedError());
        return store.run(scope, () =>
          (value as (...a: unknown[]) => unknown).apply(target, args),
        );
      };
    },
  });
}

/** Operations of one worker over its broker port, sharing one scoped database. */
export class BrokeredDatabase {
  private readonly transport: Transport;
  private readonly base: object;
  private readonly check?: (db: any) => Promise<void>;

  /** `check` runs first in the boot operation (the schema must exist). */
  constructor(
    transport: Transport,
    base: object,
    check?: (db: any) => Promise<void>,
  ) {
    this.transport = transport;
    this.base = base;
    this.check = check;
  }

  /** The handle of the running operation (`OperationEndedError` outside one). */
  current(): any {
    return currentOp().handle;
  }

  /**
   * Run `fn` as operation `opId`. The host opens its transaction first (a
   * `none` lane never does); when `fn` settles the operation's handle is
   * revoked. The host commits after the worker replies.
   */
  async run<T>(
    opId: number,
    lane: 'data' | 'owner' | 'none',
    fn: () => Promise<T>,
  ): Promise<T> {
    const scope: OpScope = { opId, ended: false, sp: 0 };
    scope.handle = pin(scope, this.base);
    try {
      if (lane !== 'none') await this.transport.call({ kind: 'open', opId });
      return await store.run(scope, async () => {
        if (opId === BOOT_OP && this.check) await this.check(scope.handle);
        return fn();
      });
    } finally {
      scope.ended = true;
    }
  }
}
