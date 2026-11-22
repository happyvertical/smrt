// How many apps one process keeps open (#5192). The policy and the counters;
// the registry itself (which holder is idle, how one is closed) is in host.ts.
//
// Nothing here runs unless the `cloud` profile is configured with a policy:
// the desktop keeps its one host open for as long as the process lives.

import {
  BrokerPool,
  type DatabaseConfig,
  POOL_CANCEL_RESERVE,
  POOL_DEFAULTS,
  poolKey,
  postgresPoolDriver,
} from '../../engine/db/index.ts';
import { CapacityError } from '../../engine/errors.ts';

/** What a hosted process does about the apps it holds. Every field is optional. */
export interface HostLifecyclePolicy {
  /** Close an app that nobody has used for this long (ms). Default: never. */
  idleMs?: number;
  /** At most this many apps open (or waking) in one process. Default: no cap. */
  maxOpenApps?: number;
  /**
   * A memory ceiling for the app workers (MiB). A worker keeps the memory it
   * grew to, so the cap is the ceiling divided by `appMemoryMb`, not a reading
   * of the process: with `maxOpenApps` the smaller of the two wins.
   */
  memoryCeilingMb?: number;
  /**
   * At most this many PostgreSQL connections held by all apps of this process
   * together (#5464): the one shared pool every app worker's operations go
   * through (`brokerPoolSize` slots plus one reserved for cancelling a stuck
   * statement), plus a fixed overhead per open host (see `HOST_OVERHEAD`).
   * Default with `maxOpenApps`: that many apps at `appAllowance()` each plus
   * the pool; without it, no budget. Never applies to SQLite or PGlite apps.
   */
  maxAppConnections?: number;
  /**
   * The shared pool's slots: the most connections all apps of this process
   * use for their operations at once (#5188). Default: what
   * `maxAppConnections` leaves after the hosts' overhead, else 10.
   */
  brokerPoolSize?: number;
  /** Most transactions one app may have open at once. Default 4. */
  perAppTransactions?: number;
  /** Most operations waiting for a pool slot; the next is refused with a 503. Default 64. */
  maxQueued?: number;
  /** How long an operation waits for a pool slot before it is refused (ms). Default 5000. */
  acquireTimeoutMs?: number;
  /** What one open app is budgeted at (MiB). Default 80. */
  appMemoryMb?: number;
  /** At most this many apps waking at once; the rest queue. Default 2. */
  maxConcurrentWakes?: number;
  /**
   * An app used less than this long ago is not evicted to make room (ms), on
   * top of the lease rules (an app with a call inside, or just handed to a
   * caller, is never evicted whatever this is). Default 0.
   */
  minIdleMs?: number;
  /**
   * A host handed out by `getHost()` is leased for this long (ms) so its
   * caller can make the first call; the call then holds its own lease until it
   * settles. Default 5000.
   */
  handoutMs?: number;
  /** How long a wake waits for room before it refuses (ms). Default 10000. */
  capacityWaitMs?: number;
  /** How often idle apps are looked for (ms). Default half of `idleMs`, at most 30000. */
  sweepMs?: number;
  /** The clock (ms); tests pass their own. */
  now?: () => number;
}

/** What the process reports about its apps (see `hostMetrics()`). */
export interface HostMetrics {
  /** Apps open now, or waking. */
  open: number;
  /** Wakes waiting for a free wake slot. */
  queuedWakes: number;
  /** Apps opened since the process started (first opens and wakes after an eviction). */
  wakes: number;
  failedWakes: number;
  evictions: { idle: number; capacity: number };
  lastWakeMs: number | null;
  maxWakeMs: number;
  totalWakeMs: number;
  /** The cap in force, or null for none. */
  maxOpen: number | null;
  /** PostgreSQL connections held by app workers now, and the budget (null: none). */
  connections: number;
  maxConnections: number | null;
  /** The shared broker pool (#5188): slots in use, waiting requests, slots; null before any PostgreSQL app opened. */
  brokerPool: { inUse: number; queued: number; max: number } | null;
  draining: boolean;
  /** The process's resident memory (bytes). */
  rssBytes: number;
}

/** What `ConnectionBudget.poolSize` reports; the shared pool (`brokerPool`) is sized by the policy instead. */
export const POOL_SIZE = 2;
/**
 * Connections a host holds beside its workers' pools: a live host keeps one
 * permanent ownership-claim connection and may have one admin connection in
 * flight (copy, swap, drop); a draft host the admin one only.
 */
export const HOST_OVERHEAD = { live: 2, draft: 1 } as const;
/**
 * Per app in the derived budget: both hosts' overhead (live and draft). The
 * connections operations use are the one shared pool, counted once.
 */
export const appAllowance = () => HOST_OVERHEAD.live + HOST_OVERHEAD.draft;

/** The refusal when the budget has no room. Its message names no server and is safe to show. */
export class ConnectionBudgetError extends CapacityError {
  constructor() {
    super(
      'this server has no database connections left for another app right now; try again',
    );
    this.name = 'ConnectionBudgetError';
  }
}

const DEFAULTS = {
  appMemoryMb: 80,
  maxConcurrentWakes: 2,
  minIdleMs: 0,
  handoutMs: 5000,
  capacityWaitMs: 10_000,
} as const;

function positive(name: string, v: number | undefined) {
  if (v !== undefined && (!Number.isFinite(v) || v <= 0))
    throw new RangeError(`lifecycle.${name} must be a positive number`);
}

export class HostLifecycle {
  private policy: HostLifecyclePolicy | null = null;
  private slots = 0;
  // An object, so a release after `reset()` settles the old count, not the new.
  private conns = { used: 0 };
  private pools = new Map<string, { pool: BrokerPool; release: () => void }>();
  private gateWaiters: (() => void)[] = [];
  private changeWaiters: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  draining = false;
  wakes = 0;
  failedWakes = 0;
  evictions = { idle: 0, capacity: 0 };
  lastWakeMs: number | null = null;
  maxWakeMs = 0;
  totalWakeMs = 0;

  configure(policy: HostLifecyclePolicy | undefined) {
    this.stopSweeping();
    if (policy)
      for (const k of [
        'idleMs',
        'maxOpenApps',
        'maxAppConnections',
        'brokerPoolSize',
        'perAppTransactions',
        'maxQueued',
        'acquireTimeoutMs',
        'memoryCeilingMb',
        'appMemoryMb',
        'maxConcurrentWakes',
        'minIdleMs',
        'handoutMs',
        'capacityWaitMs',
        'sweepMs',
      ] as const)
        if (k === 'minIdleMs') {
          if (
            policy[k] !== undefined &&
            (!Number.isFinite(policy[k]) || (policy[k] as number) < 0)
          )
            throw new RangeError('lifecycle.minIdleMs must not be negative');
        } else positive(k, policy[k]);
    this.policy = policy ?? null;
    this.reset();
  }

  /** Forget the counters (and a drain). */
  reset() {
    for (const { pool, release } of this.pools.values()) {
      void pool.close().catch(() => {});
      release();
    }
    this.pools.clear();
    this.draining = false;
    this.wakes = 0;
    this.failedWakes = 0;
    this.evictions = { idle: 0, capacity: 0 };
    this.lastWakeMs = null;
    this.maxWakeMs = 0;
    this.totalWakeMs = 0;
    this.slots = 0;
    this.gateWaiters = [];
    this.conns = { used: 0 };
  }

  /**
   * Take `n` connections of the process-wide budget for one worker's pool, or
   * refuse at once (never wait: a hang here would hold a request). Returns the
   * release, which is safe to call more than once. With no policy, or no
   * budget in force, nothing is limited. The message names no server.
   */
  takeConnections(n: number): () => void {
    const c = this.conns;
    const limit = this.connectionBudget();
    if (limit !== null && c.used + n > limit) throw new ConnectionBudgetError();
    c.used += n;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      c.used = Math.max(0, c.used - n);
    };
  }

  /** The budget in connections, or null for none. */
  private connectionBudget(): number | null {
    const p = this.policy;
    if (!p) return null;
    if (p.maxAppConnections !== undefined)
      return Math.floor(p.maxAppConnections);
    const apps = this.maxOpen;
    // Each open app's hosts, plus the one shared pool (slots and cancel reserve).
    return apps === null
      ? null
      : apps * appAllowance() + this.brokerSlots() + POOL_CANCEL_RESERVE;
  }

  /**
   * The shared pool's slots: the policy's, else what an explicit connection
   * budget leaves after the open apps' overhead (at least 2), else the default.
   */
  private brokerSlots(): number {
    const p = this.policy;
    if (p?.brokerPoolSize !== undefined) return Math.floor(p.brokerPoolSize);
    if (p?.maxAppConnections !== undefined)
      return Math.max(
        2,
        Math.floor(p.maxAppConnections) -
          (this.maxOpen ?? 0) * appAllowance() -
          POOL_CANCEL_RESERVE,
      );
    return POOL_DEFAULTS.max;
  }

  /**
   * The process's ONE connection pool for the server `config` reaches (#5188):
   * created on first use, its slots and cancel reserve taken from the
   * connection budget once (a refusal throws a `ConnectionBudgetError`, nothing
   * kept), then shared by every app worker. It replaces the per-worker pools.
   */
  brokerPool(
    config: Extract<DatabaseConfig, { kind: 'postgres' }>,
  ): BrokerPool {
    const key = poolKey(config);
    const have = this.pools.get(key);
    if (have) return have.pool;
    const slots = this.brokerSlots();
    const release = this.takeConnections(slots + POOL_CANCEL_RESERVE);
    try {
      const p = this.policy;
      const pool = new BrokerPool(postgresPoolDriver(config, slots), {
        max: slots,
        perApp: Math.floor(p?.perAppTransactions ?? POOL_DEFAULTS.perApp),
        maxQueued: Math.floor(p?.maxQueued ?? POOL_DEFAULTS.maxQueued),
        acquireTimeoutMs: Math.floor(
          p?.acquireTimeoutMs ?? POOL_DEFAULTS.acquireTimeoutMs,
        ),
      });
      this.pools.set(key, { pool, release });
      return pool;
    } catch (e) {
      release();
      throw e;
    }
  }

  /** What a worker's `WorkerLimits.connections` is: this budget and its one shared pool. */
  get workerBudget() {
    return {
      poolSize: POOL_SIZE,
      take: (n: number) => this.takeConnections(n),
      pool: (config: Extract<DatabaseConfig, { kind: 'postgres' }>) =>
        this.brokerPool(config),
    };
  }

  get connectionsInUse(): number {
    return this.conns.used;
  }

  get configured(): boolean {
    return this.policy !== null;
  }

  now(): number {
    return this.policy?.now ? this.policy.now() : Date.now();
  }

  get idleMs(): number | null {
    return this.policy?.idleMs ?? null;
  }

  get minIdleMs(): number {
    return this.policy?.minIdleMs ?? DEFAULTS.minIdleMs;
  }

  get handoutMs(): number {
    return this.policy?.handoutMs ?? DEFAULTS.handoutMs;
  }

  get capacityWaitMs(): number {
    return this.policy?.capacityWaitMs ?? DEFAULTS.capacityWaitMs;
  }

  /** How many apps one process may hold, or null for no cap. */
  get maxOpen(): number | null {
    const p = this.policy;
    if (!p) return null;
    const caps: number[] = [];
    if (p.maxOpenApps !== undefined) caps.push(Math.floor(p.maxOpenApps));
    if (p.memoryCeilingMb !== undefined)
      caps.push(
        Math.floor(p.memoryCeilingMb / (p.appMemoryMb ?? DEFAULTS.appMemoryMb)),
      );
    return caps.length ? Math.max(1, Math.min(...caps)) : null;
  }

  /** Run one wake, at most `maxConcurrentWakes` at a time; the rest queue. */
  async wake<T>(open: () => Promise<T>): Promise<T> {
    const limit = Math.max(
      1,
      Math.floor(
        this.policy?.maxConcurrentWakes ?? DEFAULTS.maxConcurrentWakes,
      ),
    );
    if (this.slots >= limit)
      await new Promise<void>((r) => this.gateWaiters.push(r));
    else this.slots++;
    const started = Date.now();
    try {
      const value = await open();
      const took = Date.now() - started;
      this.wakes++;
      this.lastWakeMs = took;
      this.totalWakeMs += took;
      this.maxWakeMs = Math.max(this.maxWakeMs, took);
      return value;
    } catch (e) {
      this.failedWakes++;
      throw e;
    } finally {
      const next = this.gateWaiters.shift();
      if (next)
        next(); // the slot passes to the next wake
      else this.slots--;
    }
  }

  get queuedWakes(): number {
    return this.gateWaiters.length;
  }

  /** Something that may free room happened (a call ended, an app closed). */
  changed() {
    const all = this.changeWaiters;
    this.changeWaiters = [];
    for (const w of all) w();
  }

  /** Wait until {@link changed}, or `ms` has passed. */
  waitForChange(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.changeWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  startSweeping(sweep: () => void) {
    const p = this.policy;
    if (this.timer || !p?.idleMs) return;
    const every = p.sweepMs ?? Math.min(30_000, Math.max(50, p.idleMs / 2));
    this.timer = setInterval(sweep, every);
    this.timer.unref?.();
  }

  stopSweeping() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private poolStats(): HostMetrics['brokerPool'] {
    if (!this.pools.size) return null;
    const sum = { inUse: 0, queued: 0, max: 0 };
    for (const { pool } of this.pools.values()) {
      const s = pool.stats;
      sum.inUse += s.inUse;
      sum.queued += s.queued;
      sum.max += s.max;
    }
    return sum;
  }

  metrics(open: number): HostMetrics {
    return {
      open,
      queuedWakes: this.queuedWakes,
      wakes: this.wakes,
      failedWakes: this.failedWakes,
      evictions: { ...this.evictions },
      lastWakeMs: this.lastWakeMs,
      maxWakeMs: this.maxWakeMs,
      totalWakeMs: this.totalWakeMs,
      maxOpen: this.maxOpen,
      connections: this.conns.used,
      maxConnections: this.policy ? this.connectionBudget() : null,
      brokerPool: this.poolStats(),
      draining: this.draining,
      rssBytes: process.memoryUsage.rss(),
    };
  }
}

const ENV_FIELDS = {
  SMRT_APP_SHELL_IDLE_MS: 'idleMs',
  SMRT_APP_SHELL_MAX_OPEN_APPS: 'maxOpenApps',
  SMRT_APP_SHELL_MAX_APP_CONNECTIONS: 'maxAppConnections',
  SMRT_APP_SHELL_BROKER_POOL_SIZE: 'brokerPoolSize',
  SMRT_APP_SHELL_PER_APP_TRANSACTIONS: 'perAppTransactions',
  SMRT_APP_SHELL_MAX_QUEUED_OPERATIONS: 'maxQueued',
  SMRT_APP_SHELL_POOL_ACQUIRE_TIMEOUT_MS: 'acquireTimeoutMs',
  SMRT_APP_SHELL_MEMORY_CEILING_MB: 'memoryCeilingMb',
  SMRT_APP_SHELL_APP_MEMORY_MB: 'appMemoryMb',
  SMRT_APP_SHELL_MAX_CONCURRENT_WAKES: 'maxConcurrentWakes',
} as const;

/**
 * The operator's policy from the environment, or undefined when none of the
 * variables is set (the hosted process then behaves as it always did). A value
 * that is not a positive number is refused at start, not ignored.
 */
export function lifecycleFromEnv(
  env: Record<string, string | undefined> = process.env,
): HostLifecyclePolicy | undefined {
  const policy: Record<string, number> = {};
  for (const [name, field] of Object.entries(ENV_FIELDS)) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`${name} must be a positive number`);
    policy[field] = n;
  }
  return Object.keys(policy).length ? policy : undefined;
}
