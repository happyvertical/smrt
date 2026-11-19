// Debounce + per-batch serialisation for the changes-waiting checks (#5205).
//
// Pure plumbing: no imports from changes, approvals or the engine, so nothing
// scheduled here can apply, approve or reach live. `schedule(batchId, gen)`
// restarts that batch's timer; when it fires the job runs after any earlier
// job of the same batch has finished. The job itself decides (by generation)
// whether its result still counts.

export interface CheckClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The real clock. Timers are unref'd: a pending check never keeps a process alive. */
export const realClock: CheckClock = {
  setTimeout(fn, ms) {
    const h = setTimeout(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** About two seconds after the last change, per the plan. */
export const DEFAULT_CHECK_DELAY_MS = 2000;

export type CheckJob = (batchId: string, generation: number) => Promise<void>;

export interface CheckScheduler {
  /** (Re)start the debounce for `batchId` at `generation`. */
  schedule(batchId: string, generation: number): void;
  /** True while a timer is pending or a job of that batch is running. */
  busy(batchId: string): boolean;
  /** Drop a pending timer (a running job still finishes). */
  cancel(batchId: string): void;
  cancelAll(): void;
  /** Fire every pending timer now and wait until all jobs have finished. */
  flush(): Promise<void>;
}

export function createCheckScheduler(opts: {
  run: CheckJob;
  delayMs?: number;
  clock?: CheckClock;
}): CheckScheduler {
  const clock = opts.clock ?? realClock;
  const delay = opts.delayMs ?? DEFAULT_CHECK_DELAY_MS;
  const timers = new Map<string, { handle: unknown; generation: number }>();
  const chains = new Map<string, Promise<void>>();

  function enqueue(batchId: string, generation: number): Promise<void> {
    const prev = chains.get(batchId) ?? Promise.resolve();
    const next = prev
      .then(() => opts.run(batchId, generation))
      // A failed check must never surface as an unhandled rejection.
      .catch(() => {})
      .finally(() => {
        if (chains.get(batchId) === next) chains.delete(batchId);
      });
    chains.set(batchId, next);
    return next;
  }

  function fire(batchId: string): void {
    const t = timers.get(batchId);
    if (!t) return;
    timers.delete(batchId);
    void enqueue(batchId, t.generation);
  }

  return {
    schedule(batchId, generation) {
      const old = timers.get(batchId);
      if (old) clock.clearTimeout(old.handle);
      const handle = clock.setTimeout(() => fire(batchId), delay);
      timers.set(batchId, { handle, generation });
    },
    busy: (batchId) => timers.has(batchId) || chains.has(batchId),
    cancel(batchId) {
      const t = timers.get(batchId);
      if (t) clock.clearTimeout(t.handle);
      timers.delete(batchId);
    },
    cancelAll() {
      for (const t of timers.values()) clock.clearTimeout(t.handle);
      timers.clear();
    },
    async flush() {
      for (const id of [...timers.keys()]) {
        const t = timers.get(id);
        if (t) clock.clearTimeout(t.handle);
        fire(id);
      }
      await Promise.all([...chains.values()]);
    },
  };
}
