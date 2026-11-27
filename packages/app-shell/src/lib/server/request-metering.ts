// Per-tenant request counts with the kind of caller (#5199, request half).
//
// Core reports every generated REST request to a sink with the DECIDED
// principal's tenant and caller kind (`APIConfig.requestMeter`, #5199); the
// engine host hands each one here (`HostOptions.onRequest`). Cloud only: the
// desktop host is built without the option and never loads this file.
//
// Cost: a request is one map increment. Counts are batched per
// (tenant, callerKind, refused) and written as `api.requests` COUNTER rows
// (`TenantUsageMetric`; summing is right for a counter) by an unref'd timer or
// once a batch holds enough distinct keys. A write that fails drops that batch
// (best effort: metering never retries into a storm and never fails a
// request). Nothing here is awaited by the request, and nothing throws into it.
//
// Tenant and caller kind come from the principal core decided (the host's
// verified caller), never from the request the client sent. `callerKind` is an
// opaque string (owner, staff, guest, job, service ...): a kind is a dimension
// value, not a branch, and a caller with none is `unknown`.
import { randomUUID } from 'node:crypto';
import { TenantUsageMetricCollection } from '@happyvertical/smrt-subscriptions';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { getShellDb, shellProfile } from './host.ts';
import { REQUEST_COUNT_METRIC } from './storage-metering.ts';

/** `source` of every request-count row. */
export const REQUEST_SOURCE = 'app-shell.requests';
/** Dimension value for a caller with no kind. */
export const UNKNOWN_CALLER_KIND = 'unknown';
const USAGE_TABLE = '_smrt_tenant_usage_metrics';
/** How often a batch is written. */
export const DEFAULT_FLUSH_MS = 60_000;
/** A batch holding this many distinct keys is written at once. */
const MAX_KEYS = 1_000;

/** What the engine host reports for one request. */
export interface RequestCount {
  tenantId: string | null;
  callerKind: string | null;
  limited: boolean;
  /** Why core refused it, or null when it was served. */
  refused: string | null;
}

interface Batch {
  tenantId: string;
  callerKind: string;
  limited: boolean;
  refused: string | null;
  count: number;
  /** When the first request of this batch was seen (ms). */
  since: number;
}

export interface RequestMeterOptions {
  flushMs?: number;
  now?: () => number;
  /** Test seam: the shell db (default: the request-scoped shell db). */
  db?: () => Promise<import('@happyvertical/sql').DatabaseInterface>;
  /** Test seam: skip the cloud-profile check. */
  profile?: () => Promise<string>;
}

export class RequestMeter {
  private readonly flushMs: number;
  private readonly now: () => number;
  private readonly dbOf: NonNullable<RequestMeterOptions['db']>;
  private readonly profileOf: NonNullable<RequestMeterOptions['profile']>;
  private batches = new Map<string, Batch>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(options: RequestMeterOptions = {}) {
    this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
    this.now = options.now ?? Date.now;
    this.dbOf = options.db ?? getShellDb;
    this.profileOf = options.profile ?? shellProfile;
  }

  /** Count one request. A map write; never throws, never waits. */
  note(request: RequestCount): void {
    try {
      // A request with no tenant has nowhere to be counted.
      if (!request.tenantId) return;
      const callerKind = request.callerKind || UNKNOWN_CALLER_KIND;
      const key = `${request.tenantId}\u0000${callerKind}\u0000${request.refused ?? ''}`;
      const held = this.batches.get(key);
      if (held) held.count += 1;
      else
        this.batches.set(key, {
          tenantId: request.tenantId,
          callerKind,
          limited: request.limited,
          refused: request.refused,
          count: 1,
          since: this.now(),
        });
      this.startTimer();
      if (this.batches.size >= MAX_KEYS) void this.flush().catch(() => {});
    } catch {
      // Metering never fails a request.
    }
  }

  /** Write the held counts now. Resolves when written; never rejects. */
  flush(): Promise<void> {
    // One flush at a time; counts noted meanwhile ride the next.
    this.flushing ??= this.write().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async write(): Promise<void> {
    const batches = [...this.batches.values()];
    this.batches = new Map();
    if (batches.length === 0) return;
    try {
      if ((await this.profileOf()) !== 'cloud') return;
      const db = await this.dbOf();
      if (!(await db.tableExists(USAGE_TABLE))) return;
      const end = new Date(this.now());
      for (const batch of batches) {
        await withTenant(
          { tenantId: batch.tenantId, permissions: new Set<string>() },
          async () => {
            const metrics = await TenantUsageMetricCollection.create({ db });
            await metrics.recordUsage({
              tenantId: batch.tenantId,
              metricKey: REQUEST_COUNT_METRIC,
              quantity: batch.count,
              windowStart: new Date(batch.since),
              windowEnd: end,
              source: REQUEST_SOURCE,
              sourceId: randomUUID(),
              dimensions: {
                callerKind: batch.callerKind,
                limited: batch.limited,
                refused: batch.refused,
              },
            });
          },
        ).catch(() => {});
      }
    } catch {
      // The batch is dropped: best effort, never a retry storm.
    }
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.flush().catch(() => {}),
      this.flushMs,
    );
    this.timer.unref?.();
  }

  /** Stop the timer and drop held counts (tests, shutdown). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.batches = new Map();
  }
}

let shared: RequestMeter | null = null;

/** The process's request meter (created on first use). */
export function requestMeter(): RequestMeter {
  shared ??= new RequestMeter();
  return shared;
}

/** Stop and drop the process's request meter (tests). */
export function resetRequestMeter(next: RequestMeter | null = null): void {
  shared?.stop();
  shared = next;
}
