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
 * The ordered sequence is also exported on its own as `createDrain` (#5546),
 * for a host that embeds the shell on a listener it owns: it runs the same
 * steps, but never closes a listener it was not given (`stopAccepting` is an
 * explicit per-call option, skipped when absent), never installs a signal
 * handler and never calls `process.exit`. The result says which steps failed
 * or timed out; a second call returns the first call's promise.
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

/** The steps of the sequence, in order. */
export type ShutdownStep =
  | 'endStreams'
  | 'stopAccepting'
  | 'stopWork'
  | 'drain';

/**
 * How one step ended: `ok`; `skipped` (no such step was given); `failed` (it
 * threw); `timeout` (it was still running at its limit); `busy` (`drain` only:
 * it returned, but an app still had a call in flight).
 */
export type StepStatus = 'ok' | 'skipped' | 'failed' | 'timeout' | 'busy';

export interface ShutdownResult {
  /** 0 drained inside the deadline; 1 not (a request, an app call or the close outlasted it). */
  code: number;
  closed: number;
  busy: number;
  /** True when every step that ran ended `ok` (same as `code === 0`). */
  clean: boolean;
  /** How each step ended. */
  steps: Record<ShutdownStep, StepStatus>;
}

/** The steps a drain runs: all but `stopAccepting`, which belongs to the listener's owner. */
export interface DrainOptions {
  /** `drainShell` of the shell host (`$lib/server/host`). */
  drain: (timeoutMs: number) => Promise<DrainResult>;
  /** Milliseconds the whole drain may take (same default as `ShutdownOptions`). */
  deadlineMs?: number;
  endStreams?: () => void | Promise<void>;
  stopWork?: () => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
}

/** Per-call part of a drain: the owner's own listener step, and a log label. */
export interface DrainCall {
  /**
   * Stop accepting requests and resolve once every accepted request has
   * ended. Only the owner of the listener passes it; without it the step is
   * skipped and no listener is touched.
   */
  stopAccepting?: () => void | Promise<void>;
  /** Names the drain in the log line. Default: `drain`. */
  reason?: string;
}

/**
 * Run the ordered drain. Safe to call more than once: every call returns the
 * promise of the first (its `DrainCall` wins). Bounded: it resolves by the
 * deadline plus one second even if a step never returns, with that step
 * marked `timeout`. Never rejects.
 */
export type Drain = (call?: DrainCall) => Promise<ShutdownResult>;

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

const STEP_ORDER: ShutdownStep[] = [
  'endStreams',
  'stopAccepting',
  'stopWork',
  'drain',
];

/**
 * The ordered drain without a listener, a signal handler or an exit (#5546).
 * `installShutdown` is this plus signals, the adapter's listener step and
 * `onExit`.
 */
export function createDrain(options: DrainOptions): Drain {
  const deadlineMs = resolveDeadlineMs(options.deadlineMs, options.env);
  let running: Promise<ShutdownResult> | null = null;

  const run = (call: DrainCall): Promise<ShutdownResult> =>
    new Promise<ShutdownResult>((resolve) => {
      const started = Date.now();
      const left = () => Math.max(0, deadlineMs - (Date.now() - started));
      process.stderr.write(
        `[shutdown] ${call.reason ?? 'drain'}: draining (deadline ${deadlineMs} ms)\n`,
      );
      const steps = Object.fromEntries(
        STEP_ORDER.map((name) => [name, 'skipped']),
      ) as Record<ShutdownStep, StepStatus | 'running'>;
      const result: ShutdownResult = {
        code: 1,
        closed: 0,
        busy: 0,
        clean: false,
        steps: steps as Record<ShutdownStep, StepStatus>,
      };
      let finished = false;
      const finish = (code: number) => {
        if (finished) return;
        finished = true;
        clearTimeout(hard);
        for (const name of STEP_ORDER)
          if (steps[name] === 'running') steps[name] = 'timeout';
        result.code = code;
        result.clean = code === 0;
        resolve(result);
      };
      // Last resort: a step that never returns.
      const hard = setTimeout(() => {
        process.stderr.write('[shutdown] deadline hit: exiting\n');
        finish(1);
      }, deadlineMs + EXIT_GRACE_MS);
      let clean = true;
      // One step, bounded by `ms`: a throw or a timeout makes the result
      // non-clean but never skips the steps after it.
      const step = async <T>(
        name: ShutdownStep,
        ms: number,
        fn: () => T | Promise<T>,
      ): Promise<T | undefined> => {
        let timer: NodeJS.Timeout | undefined;
        steps[name] = 'running';
        try {
          const out = await Promise.race([
            Promise.resolve().then(fn),
            new Promise<typeof TIMED_OUT>((resolveTimer) => {
              timer = setTimeout(() => resolveTimer(TIMED_OUT), ms);
            }),
          ]);
          if (out === TIMED_OUT) {
            clean = false;
            steps[name] = 'timeout';
            process.stderr.write(
              `[shutdown] ${name}: still running at its limit\n`,
            );
            return undefined;
          }
          steps[name] = 'ok';
          return out;
        } catch (error) {
          clean = false;
          steps[name] = 'failed';
          process.stderr.write(
            `[shutdown] ${name} failed: ${error instanceof Error ? error.name : 'error'}\n`,
          );
          return undefined;
        } finally {
          clearTimeout(timer);
        }
      };
      void (async () => {
        // 1. Long-lived streams end, or the listener could never close.
        if (options.endStreams)
          await step('endStreams', left(), options.endStreams);
        // 2. The listener's owner stops it and every accepted request ends (at
        //    most half the deadline; a request still running then is cut by the
        //    exit that follows). Skipped when the caller owns no listener step.
        const stopAccepting = call.stopAccepting;
        if (stopAccepting)
          await step(
            'stopAccepting',
            Math.floor(deadlineMs / 2),
            stopAccepting,
          );
        // 3. Background work (imports) stops and its jobs in flight finish,
        //    while the apps they use are still open.
        if (options.stopWork) await step('stopWork', left(), options.stopWork);
        // 4. Close the apps. Runs even when an earlier step failed.
        const drained = await step('drain', left() + 500, () =>
          options.drain(left()),
        );
        if (drained === undefined) clean = false;
        if (drained && drained.busy > 0) {
          clean = false;
          steps.drain = 'busy';
          process.stderr.write(
            `[shutdown] ${drained.busy} app(s) busy at close\n`,
          );
        }
        result.closed = drained?.closed ?? 0;
        result.busy = drained?.busy ?? 0;
        finish(clean ? 0 : 1);
      })();
    });

  return (call = {}) => {
    running ??= run(call);
    return running;
  };
}

let installed: ShutdownHandle | null = null;

/**
 * Wire SIGTERM/SIGINT to a drain-then-exit shutdown. Idempotent: a second call
 * returns the handle of the first (its options win).
 */
export function installShutdown(options: ShutdownOptions): ShutdownHandle {
  if (installed) return installed;
  const onExit = options.onExit ?? ((code: number) => process.exit(code));
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  const drain = createDrain(options);

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

  let running: Promise<ShutdownResult> | null = null;
  const shutdown = (reason = 'requested'): Promise<ShutdownResult> => {
    running ??= drain({ stopAccepting, reason }).then((result) => {
      onExit(result.code);
      return result;
    });
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
