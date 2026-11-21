/**
 * Graceful shutdown for a process that serves the shell (#5494).
 *
 * On SIGTERM or SIGINT: (1) stop accepting requests, (2) drain the shell
 * (`drainShell`: refuse new apps, wait for calls and wakes in flight, close
 * every open app), (3) exit 0 when everything finished inside the deadline,
 * non-zero when it did not. A repeated signal does nothing; it joins the
 * shutdown already running.
 *
 * Order matters: the HTTP server stops FIRST. `drainShell` refuses new apps
 * from its first line, so a request that arrives after it would be refused
 * mid-flight; closing the listener first lets every request already accepted
 * run to its end (it holds a lease, which the drain waits for) and turns the
 * rest away at the socket, where a load balancer retries elsewhere. Under
 * `build/index.js` (adapter-node) the adapter's own SIGTERM/SIGINT handler
 * closes the listener and announces `sveltekit:shutdown` once every request has
 * ended; this module waits for that event. An embedding host passes
 * `stopAccepting` instead.
 *
 * Kept free of SvelteKit and `$lib` imports (the caller passes `drain`), so the
 * package publishes it as `@happyvertical/smrt-app-shell/shutdown`.
 */

/** What `drainShell` reports. */
export interface DrainResult {
  closed: number;
  /** Apps that still had a call in flight when the drain gave up waiting. */
  busy: number;
}

export interface ShutdownOptions {
  /** `drainShell` of the shell host (`$lib/server/host`). */
  drain: (timeoutMs: number) => Promise<DrainResult>;
  /**
   * Milliseconds the whole shutdown may take. Default: the
   * `SMRT_APP_SHELL_SHUTDOWN_MS` environment variable, else 30000.
   */
  deadlineMs?: number;
  /** Called with the exit code once the shutdown is over. Default: `process.exit`. */
  onExit?: (code: number) => void;
  /**
   * Stop accepting requests and resolve once every accepted request has ended.
   * Default: wait for adapter-node's `sveltekit:shutdown` event (its own signal
   * handler has already closed the listener).
   */
  stopAccepting?: () => void | Promise<void>;
  /** Signals that start the shutdown. Default: SIGTERM and SIGINT. */
  signals?: readonly NodeJS.Signals[];
  /** Environment to read the deadline from. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface ShutdownResult {
  /** 0 drained inside the deadline; 1 not (a request, an app call or the close outlasted it). */
  code: number;
  closed: number;
  busy: number;
}

export interface ShutdownHandle {
  /** Start the shutdown (what a signal does); the same promise on every call. */
  shutdown(reason?: string): Promise<ShutdownResult>;
  /** Remove the signal handlers. Does not undo a shutdown already started. */
  uninstall(): void;
}

export const SHUTDOWN_ENV = 'SMRT_APP_SHELL_SHUTDOWN_MS';
export const DEFAULT_SHUTDOWN_MS = 30_000;
/** After the deadline a stuck drain gets this long before the process exits anyway. */
const EXIT_GRACE_MS = 1_000;

/** The deadline: an explicit option, else the environment, else the default. */
export function resolveDeadlineMs(
  explicit?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = explicit ?? env[SHUTDOWN_ENV];
  if (raw === undefined || raw === '') return DEFAULT_SHUTDOWN_MS;
  const ms = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new RangeError(
      `${explicit === undefined ? SHUTDOWN_ENV : 'deadlineMs'} must be a positive whole number of milliseconds (got ${JSON.stringify(raw)})`,
    );
  }
  return ms;
}

let installed: ShutdownHandle | null = null;

/**
 * Wire SIGTERM/SIGINT to a drain-then-exit shutdown. Idempotent: a second call
 * returns the handle of the first (its options win).
 */
export function installShutdown(options: ShutdownOptions): ShutdownHandle {
  if (installed) return installed;
  const deadlineMs = resolveDeadlineMs(options.deadlineMs, options.env);
  const onExit = options.onExit ?? ((code: number) => process.exit(code));
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  let running: Promise<ShutdownResult> | null = null;

  const stopAccepting =
    options.stopAccepting ??
    (() =>
      new Promise<void>((resolve) => {
        // adapter-node emits this after `server.close()` completes.
        (process as NodeJS.EventEmitter).once('sveltekit:shutdown', () =>
          resolve(),
        );
      }));

  const run = async (reason: string): Promise<ShutdownResult> => {
    const started = Date.now();
    const left = () => Math.max(0, deadlineMs - (Date.now() - started));
    process.stderr.write(
      `[shutdown] ${reason}: draining (deadline ${deadlineMs} ms)\n`,
    );
    let finished = false;
    let result: ShutdownResult = { code: 1, closed: 0, busy: 0 };
    const finish = (r: ShutdownResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(hard);
      result = r;
      onExit(r.code);
    };
    // Last resort: a drain, or a listener close, that never returns.
    const hard = setTimeout(() => {
      process.stderr.write('[shutdown] deadline hit: exiting\n');
      finish({ ...result, code: 1 });
    }, deadlineMs + EXIT_GRACE_MS);
    try {
      // Listener first, within half the deadline; the drain gets the rest.
      const gate = Promise.resolve(stopAccepting());
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(
          () => resolve('timeout'),
          Math.floor(deadlineMs / 2),
        );
      });
      const outcome = await Promise.race([
        gate.then(() => 'ok' as const),
        timedOut,
      ]);
      clearTimeout(timer);
      const stopped = outcome === 'ok';
      if (!stopped) {
        process.stderr.write(
          '[shutdown] requests still in flight: draining anyway\n',
        );
      }
      const drained = await options.drain(left());
      const clean = stopped && drained.busy === 0 && left() > 0;
      if (!clean) {
        process.stderr.write(
          `[shutdown] not clean: ${drained.busy} app(s) busy${stopped ? '' : ', requests open'}\n`,
        );
      }
      finish({
        code: clean ? 0 : 1,
        closed: drained.closed,
        busy: drained.busy,
      });
    } catch (error) {
      process.stderr.write(
        `[shutdown] failed: ${error instanceof Error ? error.name : 'error'}\n`,
      );
      finish({ ...result, code: 1 });
    }
    return result;
  };

  const shutdown = (reason = 'requested'): Promise<ShutdownResult> => {
    running ??= run(reason);
    return running;
  };
  const handlers = signals.map((signal) => {
    const handler = () => void shutdown(signal);
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  installed = {
    shutdown,
    uninstall() {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      installed = null;
    },
  };
  return installed;
}

/** Start the shutdown of the installed handler (the signal path, callable). */
export function shutdown(reason?: string): Promise<ShutdownResult> {
  if (!installed) {
    return Promise.reject(
      new Error('installShutdown() has not been called in this process'),
    );
  }
  return installed.shutdown(reason);
}
