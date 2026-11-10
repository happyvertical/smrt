/**
 * Opt-in retry and concurrency bounds for `ProposalGenerator.generate`
 * (#4504). Server-only; never part of frozen configuration or digests.
 */

/** How a failed `generator.generate` call is retried. Absent: one call, as before. */
export interface GenerationRetryPolicy {
  /** Total calls including the first, 1..10. Default 1 (no retry). */
  attempts?: number;
  /**
   * Delay before call `attempt` (2 is the first retry), in milliseconds,
   * 0..60000; a function is called per retry. Default 0.
   */
  backoffMs?: number | ((attempt: number) => number);
  /**
   * Whether the generator's rejection is worth another call (`attempt` is the
   * call that failed). Default: every rejection. A throw counts as `false`.
   * A stage timeout, a revoked lease and output validation are never retried.
   */
  retryable?: (error: unknown, attempt: number) => boolean;
}

const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 60_000;
const MAX_CONCURRENCY = 1_000;

/** Validated, frozen copy of a host policy; throws on invalid settings. */
export function generationRetryPolicy(
  policy: GenerationRetryPolicy | undefined,
): GenerationRetryPolicy & { attempts: number } {
  if (policy === undefined) return { attempts: 1 };
  if (!policy || typeof policy !== 'object')
    throw new Error('Invalid generation retry policy');
  const attempts = policy.attempts ?? 1;
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    attempts > MAX_ATTEMPTS
  )
    throw new Error('Invalid generation retry attempts');
  const { backoffMs, retryable } = policy;
  if (
    backoffMs !== undefined &&
    typeof backoffMs !== 'function' &&
    !validDelay(backoffMs)
  )
    throw new Error('Invalid generation retry backoff');
  if (retryable !== undefined && typeof retryable !== 'function')
    throw new Error('Invalid generation retry predicate');
  return Object.freeze({
    attempts,
    ...(backoffMs === undefined ? {} : { backoffMs }),
    ...(retryable ? { retryable } : {}),
  });
}
function validDelay(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_BACKOFF_MS
  );
}
/** The delay before call `attempt`; a malformed host answer is refused. */
export function retryDelay(
  policy: GenerationRetryPolicy,
  attempt: number,
): number {
  const value =
    typeof policy.backoffMs === 'function'
      ? policy.backoffMs(attempt)
      : (policy.backoffMs ?? 0);
  if (!validDelay(value)) throw new Error('Invalid generation retry backoff');
  return value;
}
/** Whether to call again after `attempt` failed; a throwing predicate says no. */
export function shouldRetry(
  policy: GenerationRetryPolicy,
  error: unknown,
  attempt: number,
): boolean {
  if (attempt >= (policy.attempts ?? 1)) return false;
  if (!policy.retryable) return true;
  try {
    return policy.retryable(error, attempt) === true;
  } catch {
    return false;
  }
}

/** Construction-time check of a host's `retry` and `concurrency` settings. */
export function assertGenerationBounds(config: {
  retry?: GenerationRetryPolicy;
  concurrency?: number;
}): void {
  generationRetryPolicy(config.retry);
  if (config.concurrency !== undefined)
    new GenerationLimiter(config.concurrency);
}
/** A FIFO counting semaphore: at most `limit` tasks run at once. */
export class GenerationLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONCURRENCY)
      throw new Error('Invalid generation concurrency');
  }
  /** Tasks running now (for tests and diagnostics). */
  get running(): number {
    return this.active;
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active++;
    // A released slot passes straight to the next waiter (active unchanged).
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
// One limiter per host configuration object, so every service built from the
// same configuration (one per request scope) shares the bound.
const limiters = new WeakMap<object, GenerationLimiter>();
export function generationLimiter(
  owner: object,
  concurrency: number | undefined,
): GenerationLimiter | undefined {
  if (concurrency === undefined) return undefined;
  const existing = limiters.get(owner);
  if (existing?.limit === concurrency) return existing;
  const limiter = new GenerationLimiter(concurrency);
  limiters.set(owner, limiter);
  return limiter;
}
