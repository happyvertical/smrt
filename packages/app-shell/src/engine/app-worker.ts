// The worker entry: runs one AppRuntime in its own thread. The host's handle
// on it is in worker-handle.ts. Messages are plain JSON-safe values.

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { AppLimits } from './app-limits.ts';
import type { WorkerDatabaseConfig } from './db/types.ts';
import type { AppDefinition, Migration } from './definition.ts';
import type {
  LimitInfo,
  WorkerCall,
  WorkerOp,
  WorkerReply,
} from './worker-protocol.ts';
import { OP_LANES, WORKER_OPS } from './worker-protocol.ts';

/**
 * `@happyvertical/sql` starts an HMAC key generation on the libuv pool when it
 * loads (a Postgres cache key). Node aborts the whole process if a worker is
 * terminated while that job is still pending, so the worker reports ready (or
 * failed) only after it has settled. Everything the host does to a worker
 * (retire, terminate) happens after that message.
 */
const settleStartupJobs = async () => {
  const pending = (globalThis as Record<string, unknown>)
    .__haveSqlPostgresCacheHmacKey;
  if (pending && typeof (pending as Promise<unknown>).then === 'function')
    await (pending as Promise<unknown>).catch(() => {});
};

if (!isMainThread && workerData?.appWorker) {
  const { AppRuntime } = await import('./app-runtime.ts');
  const { AppError, NoPrincipalError, PermissionDeniedError, isStaleFence } =
    await import('./errors.ts');
  const { AppLimitError } = await import('./app-limits.ts');
  const { CallQueue } = await import('./call-queue.ts');
  const { authorizeOp } = await import('./authorize.ts');
  const { readPrincipal, runAsPrincipal } = await import('./principal.ts');
  const {
    dataDir,
    def,
    version,
    migration,
    readOnly,
    validateOnly,
    database,
    appLimits,
    tenantId,
    bootPrincipal,
  } = workerData as {
    dataDir: string;
    /** The app's tenant; every call's principal must belong to it (#5188). */
    tenantId: string;
    /** The engine's own principal, handed in at thread start: boot runs as it. */
    bootPrincipal: unknown;
    /** Where the app's data lives; chosen by the host (default SQLite). */
    database?: WorkerDatabaseConfig;
    def: AppDefinition;
    version: number;
    migration?: Migration;
    readOnly?: boolean;
    validateOnly?: boolean;
    appLimits?: AppLimits;
  };
  const limitOf = (e: {
    cap: string;
    limit: number;
    current: number;
    requested: number;
  }): LimitInfo => ({
    cap: e.cap,
    limit: e.limit,
    current: e.current,
    requested: e.requested,
  });
  let rt: InstanceType<typeof AppRuntime>;
  const port = parentPort as NonNullable<typeof parentPort>;
  let ok = false;
  try {
    // Boot is the engine's own work: refuse to start without its principal.
    if (readPrincipal(bootPrincipal, tenantId).kind !== 'system')
      throw new Error('the app can only be started by the engine');
    rt = new AppRuntime(dataDir, def, version, database, appLimits);
    const t0 = performance.now();
    const booted = await rt.boot(migration, readOnly, validateOnly);
    ok = true;
    await settleStartupJobs();
    port.postMessage({
      ready: true,
      ...booted,
      bootMs: Math.round(performance.now() - t0),
    });
  } catch (e) {
    await settleStartupJobs();
    port.postMessage({
      ready: false,
      error: (e as Error).message,
      user:
        (migration?.direction === 'down' && e instanceof AppError) ||
        e instanceof AppLimitError,
      stale: isStaleFence(e),
      ...(e instanceof AppLimitError ? { limit: limitOf(e) } : {}),
    });
  }
  // One operation at a time: an operation owns the broker's transaction (or
  // SQLite's connection) from its first statement to its reply, so another
  // one can never interleave statements into it.
  // The queue is bounded (`MAX_QUEUED_CALLS`, the shared pool's `maxQueued`):
  // a call that finds it full is answered at once with a busy reply, never
  // held, so a flood cannot grow an unbounded backlog behind one operation.
  const queue = new CallQueue();
  if (ok)
    port.on('message', (call: WorkerCall) => {
      try {
        void queue.push(() => handle(call));
      } catch (e) {
        port.postMessage({
          id: call?.id,
          ok: false,
          error: (e as Error).message,
          user: false,
          busy: true,
        } satisfies WorkerReply);
      }
    });
  async function handle({ id, op, args, principal }: WorkerCall) {
    let reply: WorkerReply;
    try {
      if (!(WORKER_OPS as readonly string[]).includes(op))
        throw new Error(`bad op ${op}`);
      // Every call names its caller: no principal, a malformed one or one of
      // another tenant is refused before the runtime is touched.
      const caller = readPrincipal(principal, tenantId);
      authorizeOp(rt.def, caller, op as WorkerOp, args);
      reply = {
        id,
        ok: true,
        value: await rt.runOp(id, OP_LANES[op as WorkerOp], () =>
          runAsPrincipal(caller, () =>
            (
              rt as unknown as Record<
                string,
                (...a: unknown[]) => Promise<unknown>
              >
            )[op](...args),
          ),
        ),
      };
    } catch (e) {
      // Only a report run can fail with a report error, and by then the
      // package is loaded; any other op must not load it to find out.
      const RuntimeReportError =
        op === 'runReport'
          ? (await import('@happyvertical/smrt-reports')).RuntimeReportError
          : null;
      reply = {
        id,
        ok: false,
        error: (e as Error).message,
        user: e instanceof AppError,
        ...(isStaleFence(e) ? { stale: true } : {}),
        ...(e instanceof NoPrincipalError
          ? { code: 'unauthorized' as const }
          : {}),
        ...(e instanceof PermissionDeniedError
          ? { code: 'forbidden' as const }
          : {}),
        ...(e instanceof AppLimitError ? { limit: limitOf(e) } : {}),
        ...(RuntimeReportError && e instanceof RuntimeReportError
          ? {
              reportError: {
                code: e.code,
                path: e.path,
                ...(e.code === 'invalid_spec'
                  ? {
                      reason: e.message.startsWith(`${e.path}: `)
                        ? e.message.slice(e.path.length + 2)
                        : e.message,
                    }
                  : {}),
              },
            }
          : {}),
      };
    }
    port.postMessage(reply);
  }
}
