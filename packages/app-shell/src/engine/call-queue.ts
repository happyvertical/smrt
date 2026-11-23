// The per-worker call queue (#5188). One operation owns the broker's
// transaction (or SQLite's connection) from its first statement to its reply,
// so a worker runs its calls ONE AT A TIME: interleaving two operations'
// statements into one transaction is never an option. A bounded queue keeps
// that choice from becoming an unbounded backlog: a call that finds `max`
// calls already waiting (not counting the one running) is refused at once with
// the same `DatabaseBusyError` the shared pool answers with, which routes
// report as 503 so the caller may retry.

import { POOL_DEFAULTS } from './db/pool.ts';
import { DatabaseBusyError } from './errors.ts';

/** Calls that may wait behind the running one: the pool's own `maxQueued` default. */
export const MAX_QUEUED_CALLS = POOL_DEFAULTS.maxQueued;

export class CallQueue {
  private tail: Promise<void> = Promise.resolve();
  /** The running call and the ones waiting behind it. */
  private pending = 0;
  private readonly max: number;

  constructor(max: number = MAX_QUEUED_CALLS) {
    this.max = max;
  }

  /** Calls waiting behind the running one. */
  get depth(): number {
    return Math.max(0, this.pending - 1);
  }

  /**
   * Run `fn` after every earlier call settled. Throws `DatabaseBusyError`
   * (synchronously, before anything is queued) when `max` calls already wait.
   */
  push<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending > this.max)
      throw new DatabaseBusyError(
        'the app is busy: too many operations are waiting for it; try again',
      );
    this.pending++;
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => {
        this.pending--;
      },
      () => {
        this.pending--;
      },
    );
    return result;
  }
}
