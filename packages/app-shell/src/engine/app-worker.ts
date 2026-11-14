// The worker entry: runs one AppRuntime in its own thread. The host's handle
// on it is in worker-handle.ts. Messages are plain JSON-safe values.

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { RuntimeReportError } from '@happyvertical/smrt-reports';
import type { AppDefinition, Migration } from './definition.ts';
import type { WorkerCall, WorkerReply } from './worker-protocol.ts';
import { WORKER_OPS } from './worker-protocol.ts';

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
  const { AppError } = await import('./errors.ts');
  const { dataDir, def, version, migration, readOnly, validateOnly } =
    workerData as {
      dataDir: string;
      def: AppDefinition;
      version: number;
      migration?: Migration;
      readOnly?: boolean;
      validateOnly?: boolean;
    };
  const rt = new AppRuntime(dataDir, def, version);
  const port = parentPort as NonNullable<typeof parentPort>;
  let ok = false;
  try {
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
    port.postMessage({ ready: false, error: (e as Error).message });
  }
  if (ok)
    port.on('message', async ({ id, op, args }: WorkerCall) => {
      let reply: WorkerReply;
      try {
        if (!(WORKER_OPS as readonly string[]).includes(op))
          throw new Error(`bad op ${op}`);
        reply = {
          id,
          ok: true,
          value: await (
            rt as unknown as Record<string, (...a: unknown[]) => unknown>
          )[op](...args),
        };
      } catch (e) {
        reply = {
          id,
          ok: false,
          error: (e as Error).message,
          user: e instanceof AppError,
          ...(op === 'runReport' && e instanceof RuntimeReportError
            ? { reportError: { code: e.code, path: e.path } }
            : {}),
        };
      }
      port.postMessage(reply);
    });
}
