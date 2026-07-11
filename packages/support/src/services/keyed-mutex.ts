/**
 * KeyedMutex — serialize async work per key within one process.
 *
 * Used where a read-then-write decision must not interleave for the same
 * logical resource: intake's create-or-join per conversation key, and
 * included-time consumption per case during time-entry approval. Keys chain
 * promises, so concurrent callers for the same key run strictly in arrival
 * order while different keys stay fully parallel; entries clean up when the
 * last waiter finishes.
 *
 * Scope: in-process only. It covers the deployment shape these paths run in
 * (one app process owns intake interceptors / approval actions); multi-
 * replica deployments serialize at the app layer (sticky routing or a
 * DB-level claim), which composes above these seams.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Run `fn` exclusively for `key`, after every earlier holder of it. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Chain regardless of the predecessor's outcome — a failed holder must
    // not poison the queue behind it.
    const turn = previous.then(fn, fn);
    // Track completion (success or failure) so cleanup always runs.
    const settled = turn.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    try {
      return await turn;
    } finally {
      if (this.tails.get(key) === settled) {
        this.tails.delete(key);
      }
    }
  }
}

export default KeyedMutex;
