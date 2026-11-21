/**
 * Graceful shutdown for a process that serves the shell (#5494).
 *
 * On SIGTERM or SIGINT, in this order: (1) end long-lived streams (`endStreams`),
 * (2) stop accepting requests and let accepted ones end (`stopAccepting`),
 * (3) stop background work and wait for its jobs (`stopWork`), (4) drain the
 * shell (`drainShell`: refuse new apps, wait for calls and wakes in flight,
 * close every open app), (5) exit, only after all of those returned: 0 when
 * everything finished inside the deadline, non-zero when it did not. A failed
 * or timed-out step makes the exit non-zero but never skips the later ones. A repeated signal does nothing; it joins the
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
   * First step: end long-lived response streams (SSE) and refuse new ones.
   * An open stream holds the listener's close until the deadline.
   */
  endStreams?: () => void | Promise<void>;
  /**
   * Third step, after the listener stopped: stop background work and wait for
   * the jobs it is running (workbook imports), before the apps close.
   */
  stopWork?: () => void | Promise<void>;
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
const TIMED_OUT = Symbol('timed out');

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

  // adapter-node emits `sveltekit:shutdown` once `server.close()` completed,
  // which on an idle server is the tick after the signal: listen from install
  // time, not from the step that waits for it.
  let httpStopped: Promise<void> | undefined;
  if (!options.stopAccepting) {
    httpStopped = new Promise<void>((resolve) => {
      (process as NodeJS.EventEmitter).once('sveltekit:shutdown', () =>
        resolve(),
      );
    });
  }
  const stopAccepting = () => options.stopAccepting?.() ?? httpStopped;

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
    // Last resort: a step that never returns.
    const hard = setTimeout(() => {
      process.stderr.write('[shutdown] deadline hit: exiting\n');
      finish({ ...result, code: 1 });
    }, deadlineMs + EXIT_GRACE_MS);
    let clean = true;
    // One step, bounded by `ms`: a throw or a timeout makes the exit non-zero
    // but never skips the steps after it.
    const step = async <T>(
      name: string,
      ms: number,
      fn: () => T | Promise<T>,
    ): Promise<T | undefined> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const out = await Promise.race([
          Promise.resolve().then(fn),
          new Promise<typeof TIMED_OUT>((resolve) => {
            timer = setTimeout(() => resolve(TIMED_OUT), ms);
          }),
        ]);
        if (out === TIMED_OUT) {
          clean = false;
          process.stderr.write(
            `[shutdown] ${name}: still running at its limit\n`,
          );
          return undefined;
        }
        return out;
      } catch (error) {
        clean = false;
        process.stderr.write(
          `[shutdown] ${name} failed: ${error instanceof Error ? error.name : 'error'}\n`,
        );
        return undefined;
      } finally {
        clearTimeout(timer);
      }
    };
    // 1. Long-lived streams end, or the listener could never close.
    if (options.endStreams)
      await step('endStreams', left(), options.endStreams);
    // 2. The listener stops and every accepted request ends (at most half the
    //    deadline; a request still running then is cut by the exit below).
    await step('stopAccepting', Math.floor(deadlineMs / 2), stopAccepting);
    // 3. Background work (imports) stops and its jobs in flight finish, while
    //    the apps they use are still open.
    if (options.stopWork) await step('stopWork', left(), options.stopWork);
    // 4. Close the apps. Runs even when an earlier step failed.
    const drained = await step('drain', left() + 500, () =>
      options.drain(left()),
    );
    if (drained === undefined) clean = false;
    if (drained && drained.busy > 0) {
      clean = false;
      process.stderr.write(`[shutdown] ${drained.busy} app(s) busy at close\n`);
    }
    finish({
      code: clean ? 0 : 1,
      closed: drained?.closed ?? 0,
      busy: drained?.busy ?? 0,
    });
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
