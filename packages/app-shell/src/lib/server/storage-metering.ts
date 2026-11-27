// Per-tenant storage metering for the hosted shell (#5199, storage half).
//
// What it records: the size of a tenant's app data as ONE gauge row per
// tenant per time bucket in `TenantUsageMetric` (`storage.bytes`). Cloud
// profile only; the desktop never measures or records anything.
//
// Why "one row per bucket" and not a true upsert: usage rows are immutable
// evidence (`TenantUsageMetric.validateBeforeSave` refuses a changed row and a
// `source`+`sourceId` write that already exists returns the old row), and
// `summarizeUsage` SUMS quantities, which is right for counters and wrong for
// a size. So a sample is an insert-only row keyed `(tenant, metric, source,
// bucket start)`; a second sample in the same bucket adds nothing, and the
// reader takes the LATEST sample in the period (and the peak), never a sum.
//
// Cost: nothing here runs on the request path except a map write. A request
// notes its tenant; a due tenant (not sampled within the minimum interval) is
// sampled after the response, fire and forget; an unref'd timer sweeps the
// tenants seen. Sampling never opens or wakes an app: it reads the tenant's
// `App` row, then either `pg_class` sizes (PostgreSQL) or `stat` (SQLite).
//
// The tenant always comes from the verified session's tenant context
// (`getCurrentTenant()`), never from input; the timer re-enters each tenant's
// context (`withTenant`) because the tenant-scoped models need one.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { TenantUsageMetricCollection } from '@happyvertical/smrt-subscriptions';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { AppCollection } from '../objects/App.ts';
import {
  appSchemaName,
  dataRoot,
  getShellDb,
  shellProfile,
  tenantAppDirs,
} from './host.ts';
import { APP_SLUG } from './version-store.ts';

/** The gauge: bytes of the tenant's app data, latest sample wins. */
export const STORAGE_BYTES_METRIC = 'storage.bytes';
/**
 * The per-tenant request counter (#5199), a counter: summing is right. Written
 * by `request-metering.ts` from core's request sink, with the caller kind in
 * `dimensions.callerKind`; read by `readTenantUsage`.
 */
export const REQUEST_COUNT_METRIC = 'api.requests';
/** `source` of every row written here; the reader and nothing else trusts it. */
export const STORAGE_SOURCE = 'app-shell.storage';

/** Counter: one row per app wake (`quantity` 1; `dimensions.wakeMs`). */
export const APP_WAKE_METRIC = 'app.wakes';
/** Counter: milliseconds an app stayed awake, one row per close. */
export const APP_AWAKE_METRIC = 'app.awake_ms';
export const WORKER_SOURCE = 'app-shell.worker';
const USAGE_TABLE = '_smrt_tenant_usage_metrics';

/** Minimum time between two samples of one tenant, and the bucket length. */
export const DEFAULT_SAMPLE_INTERVAL_MS = 60 * 60 * 1000;
/** How often the timer looks for tenants that are due. */
export const DEFAULT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
/** Tenants remembered for the timer; the oldest is forgotten past this. */
const MAX_TRACKED = 10_000;

export type StorageBackend = 'postgres' | 'sqlite';

export interface StorageMeasurement {
  bytes: number;
  backend: StorageBackend;
}

/** Measures one tenant's app. Injected so tests need no server. */
export interface StorageProbe {
  measure(target: {
    tenantId: string;
    appId: string;
  }): Promise<StorageMeasurement>;
}

/** Runs the catalog query: the app's schema name is the one bound value. */
export type CatalogQuery = (sql: string, schema: string) => Promise<unknown[]>;

/**
 * Tables and materialized views of one schema with their indexes and TOAST
 * (`pg_total_relation_size` already includes both, so indexes, TOAST tables
 * and sequences are NOT counted again: only `r` and `m`).
 */
export const PG_SCHEMA_BYTES_SQL = `SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0)::text AS bytes
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ? AND c.relkind IN ('r', 'm')`;

/** Bytes of one app schema on PostgreSQL. Scope: the live schema only. */
export async function measurePostgresSchemaBytes(
  query: CatalogQuery,
  schema: string,
): Promise<number> {
  const rows = (await query(PG_SCHEMA_BYTES_SQL, schema)) as Array<{
    bytes?: unknown;
  }>;
  const bytes = Number(rows[0]?.bytes ?? 0);
  if (!Number.isFinite(bytes) || bytes < 0)
    throw new Error('the schema size query returned no usable number');
  return bytes;
}

/** Bytes of a tenant's SQLite app: `app.db` plus its `-wal`. Never opened. */
export async function measureSqliteBytes(liveDir: string): Promise<number> {
  let total = 0;
  for (const name of ['app.db', 'app.db-wal']) {
    try {
      total += (await stat(join(liveDir, name))).size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return total;
}

/**
 * The shell's probe. An app with an `app.db` in its directory is a SQLite app
 * (stat it); otherwise, with `DATABASE_URL` set (the server the apps' schemas
 * live on, the shell's own), the schema is measured through the shell database.
 * Scope: the LIVE app only; draft copies, snapshots and the shell's own rows
 * (versions, assistant messages) are not counted. Assets: the shell has no
 * asset store of its own (an app's asset records live in its schema and are
 * already counted), so they are recorded as `not-measured`.
 */
export function shellStorageProbe(
  options: {
    postgres?: () => boolean;
    catalog?: () => Promise<CatalogQuery>;
    root?: () => Promise<string>;
  } = {},
): StorageProbe {
  const hasServer = options.postgres ?? (() => !!process.env.DATABASE_URL);
  return {
    async measure({ tenantId, appId }) {
      const root = await (options.root ?? dataRoot)();
      const { live } = tenantAppDirs(root, tenantId, appId);
      if (hasServer() && !existsSync(join(live, 'app.db'))) {
        const query = await (options.catalog ?? defaultCatalog)();
        return {
          bytes: await measurePostgresSchemaBytes(
            query,
            appSchemaName(tenantId, appId),
          ),
          backend: 'postgres',
        };
      }
      return { bytes: await measureSqliteBytes(live), backend: 'sqlite' };
    },
  };
}

/** The catalog query on a database handle (`?` placeholders, as the shell's db takes them). */
export function catalogQueryOf(db: DatabaseInterface): CatalogQuery {
  return async (sql, schema) =>
    ((await db.query(sql, schema)) as { rows?: unknown[] }).rows ?? [];
}

async function defaultCatalog(): Promise<CatalogQuery> {
  return catalogQueryOf(await getShellDb());
}

export interface StorageMeterOptions {
  probe?: StorageProbe;
  /** Min time between samples of one tenant, also the row bucket. */
  intervalMs?: number;
  sweepMs?: number;
  now?: () => number;
  /** Test seam: resolve the shell db (default: the request-scoped shell db). */
  db?: () => Promise<DatabaseInterface>;
}

export interface TenantUsage {
  tenantId: string;
  window: { start: Date; end: Date };
  storage: {
    /** Latest sample in the window, bytes; null when none was taken. */
    bytes: number | null;
    /** Highest sample in the window; null when none. */
    peakBytes: number | null;
    /** When the latest sample was measured (not its bucket start). */
    sampledAt: Date | null;
    /** Start of the latest sample's bucket. */
    bucketStart: Date | null;
    samples: number;
    backend: string | null;
  };
  requests: {
    /** Requests served: the sum of `api.requests` rows that were not refused. */
    count: number;
    /** False until a request has been recorded. */
    metered: boolean;
    /** Requests refused with a 429 by the route limits (not in `count`). */
    limited: number;
    /** Requests refused before they were served, by reason (not in `count`). */
    refused: Record<string, number>;
    /** `count` split by the kind of caller (`unknown` when none); guests apart from staff. */
    byCallerKind: Record<string, number>;
  };
  /** Worker activity from wake and idle-close samples (counters: summed). */
  worker: {
    wakes: number;
    /** Milliseconds awake, summed over closed spans (a still-open app adds nothing yet). */
    awakeMs: number;
  };
}

export class StorageMeter {
  private readonly intervalMs: number;
  private readonly sweepMs: number;
  private readonly now: () => number;
  private readonly probe: StorageProbe;
  private readonly dbOf: () => Promise<DatabaseInterface>;
  /** tenant id -> last sample attempt (ms). Throttle and the timer's list. */
  private readonly seen = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tableReady = false;

  constructor(options: StorageMeterOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.sweepMs = options.sweepMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.dbOf = options.db ?? getShellDb;
    this.probe = options.probe ?? shellStorageProbe();
  }

  /**
   * Called by the request path. Cheap: a profile check, a map write, and, when
   * the tenant is due, a sample started AFTER the response (never awaited by
   * the caller). The tenant is the verified session's, from the ambient
   * context; with none (a guest, a signed-out visitor) nothing happens.
   */
  noteRequest(): void {
    const tenantId = getCurrentTenant()?.tenantId;
    if (!tenantId) return;
    void this.noteTenant(tenantId);
  }

  private async noteTenant(tenantId: string): Promise<void> {
    try {
      if ((await shellProfile()) !== 'cloud') return;
      const last = this.seen.get(tenantId);
      this.track(tenantId, last ?? 0);
      this.startTimer();
      if (last === undefined || this.now() - last >= this.intervalMs)
        await this.sample(tenantId);
    } catch {
      // Metering never fails or slows a request.
    }
  }

  private track(tenantId: string, at: number): void {
    this.seen.delete(tenantId);
    this.seen.set(tenantId, at);
    if (this.seen.size > MAX_TRACKED) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  /** Sample every seen tenant that is due. The timer's body; callable. */
  async sweep(): Promise<number> {
    let taken = 0;
    for (const [tenantId, last] of [...this.seen]) {
      if (this.now() - last < this.intervalMs) continue;
      if (await this.sample(tenantId).catch(() => false)) taken++;
    }
    return taken;
  }

  /**
   * Measure and record one tenant now (once per bucket). Returns whether a row
   * was written. `tenantId` here is only ever one the session context gave
   * (`noteRequest`) or one the timer remembered from it.
   */
  async sample(tenantId: string): Promise<boolean> {
    if (this.inflight.has(tenantId)) return false;
    this.inflight.add(tenantId);
    // The attempt counts for the throttle even if it fails: no retry storm.
    this.track(tenantId, this.now());
    try {
      if ((await shellProfile()) !== 'cloud') return false;
      return await withTenant(
        { tenantId, permissions: new Set<string>() },
        () => this.sampleInContext(tenantId),
      );
    } finally {
      this.inflight.delete(tenantId);
    }
  }

  private async sampleInContext(tenantId: string): Promise<boolean> {
    const db = await this.dbOf();
    // The schema comes from `smrt db:migrate`, never from here: skip quietly.
    if (!this.tableReady) {
      if (!(await db.tableExists(USAGE_TABLE))) return false;
      this.tableReady = true;
    }
    const app = (
      await (
        await AppCollection.create({ db })
      ).list({
        where: { slug: APP_SLUG },
        limit: 1,
      })
    )[0];
    if (!app?.id) return false; // the tenant has no app yet
    const at = this.now();
    const start = Math.floor(at / this.intervalMs) * this.intervalMs;
    const sourceId = String(start);
    const metrics = await TenantUsageMetricCollection.create({ db });
    const held = await metrics.list({
      where: {
        tenantId,
        metricKey: STORAGE_BYTES_METRIC,
        source: STORAGE_SOURCE,
        sourceId,
      },
      limit: 1,
    });
    if (held.length > 0) return false; // this bucket already holds its sample
    const { bytes, backend } = await this.probe.measure({
      tenantId,
      appId: app.id as string,
    });
    await metrics.recordUsage({
      tenantId,
      metricKey: STORAGE_BYTES_METRIC,
      quantity: bytes,
      windowStart: new Date(start),
      windowEnd: new Date(start + this.intervalMs),
      source: STORAGE_SOURCE,
      sourceId,
      dimensions: {
        backend,
        scope: 'live-app',
        sampledAt: new Date(at).toISOString(),
        assets: 'not-measured',
      },
    });
    return true;
  }

  /**
   * One tenant's storage and request metrics for a window, from one place.
   * The tenant is the session's (ambient context), never a parameter. Storage
   * is the latest sample (plus the peak): it is a gauge, so it is NOT summed.
   */
  async read(window: { start: Date; end: Date }): Promise<TenantUsage> {
    const tenantId = getCurrentTenant()?.tenantId;
    if (!tenantId) throw new Error('sign in first');
    const db = await this.dbOf();
    const result: TenantUsage = {
      tenantId,
      window,
      storage: {
        bytes: null,
        peakBytes: null,
        sampledAt: null,
        bucketStart: null,
        samples: 0,
        backend: null,
      },
      requests: {
        count: 0,
        metered: false,
        limited: 0,
        refused: {},
        byCallerKind: {},
      },
      worker: { wakes: 0, awakeMs: 0 },
    };
    if (!(await db.tableExists(USAGE_TABLE))) return result;
    const metrics = await TenantUsageMetricCollection.create({ db });
    const overlap = {
      tenantId,
      subscriberKind: 'tenant',
      'windowStart <': window.end.toISOString(),
      'windowEnd >': window.start.toISOString(),
    };
    const samples = await metrics.list({
      where: {
        ...overlap,
        metricKey: STORAGE_BYTES_METRIC,
        source: STORAGE_SOURCE,
      },
      orderBy: 'windowStart DESC',
      limit: 10_000,
    });
    const latest = samples[0];
    if (latest) {
      result.storage = {
        bytes: latest.quantity,
        peakBytes: Math.max(...samples.map((m) => m.quantity)),
        sampledAt: measuredAt(latest),
        bucketStart: latest.windowStart,
        samples: samples.length,
        backend: String(latest.getDimensions().backend ?? '') || null,
      };
    }
    const requests = await metrics.list({
      where: { ...overlap, metricKey: REQUEST_COUNT_METRIC },
      limit: 100_000,
    });
    const byCallerKind: Record<string, number> = Object.create(null);
    const refused: Record<string, number> = Object.create(null);
    let served = 0;
    for (const m of requests) {
      const dims = m.getDimensions();
      const why =
        typeof dims.refused === 'string' && dims.refused
          ? dims.refused
          : dims.limited === true
            ? 'rate_limited'
            : null;
      if (why) {
        refused[why] = (refused[why] ?? 0) + m.quantity;
        continue;
      }
      const kind =
        typeof dims.callerKind === 'string' && dims.callerKind
          ? dims.callerKind
          : 'unknown';
      byCallerKind[kind] = (byCallerKind[kind] ?? 0) + m.quantity;
      served += m.quantity;
    }
    result.requests = {
      count: served,
      metered: requests.length > 0,
      limited: refused.rate_limited ?? 0,
      refused: { ...refused },
      byCallerKind: { ...byCallerKind },
    };
    const worker = await metrics.list({
      where: { ...overlap, source: WORKER_SOURCE },
      limit: 100_000,
    });
    for (const m of worker) {
      if (m.metricKey === APP_WAKE_METRIC) result.worker.wakes += m.quantity;
      if (m.metricKey === APP_AWAKE_METRIC) {
        // A span that crosses the window's edge counts only the part inside.
        const from = Math.max(m.windowStart.getTime(), window.start.getTime());
        const to = Math.min(m.windowEnd.getTime(), window.end.getTime());
        const span = m.windowEnd.getTime() - m.windowStart.getTime();
        result.worker.awakeMs +=
          span > 0
            ? Math.round((m.quantity * Math.max(0, to - from)) / span)
            : m.quantity;
      }
    }
    return result;
  }

  /**
   * The host just woke this tenant's app: record the wake and sample storage.
   * Called by host.ts, fire and forget; never throws, never waits on anything
   * the wake needs. `tenantId` is the HOST's tenant (cloud), not input.
   */
  async onWake(tenantId: string, wakeMs: number): Promise<void> {
    await this.activity(tenantId, {
      metricKey: APP_WAKE_METRIC,
      quantity: 1,
      spanMs: 0,
      dimensions: { event: 'wake', wakeMs },
    });
  }

  /** The host closed this tenant's app (idle or capacity): record its awake span and sample storage. */
  async onClose(
    tenantId: string,
    awakeMs: number,
    why: 'idle' | 'capacity',
  ): Promise<void> {
    await this.activity(tenantId, {
      metricKey: APP_AWAKE_METRIC,
      quantity: Math.max(0, Math.round(awakeMs)),
      spanMs: Math.max(0, Math.round(awakeMs)),
      dimensions: { event: 'close', why },
    });
  }

  private async activity(
    tenantId: string,
    row: {
      metricKey: string;
      quantity: number;
      spanMs: number;
      dimensions: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      if ((await shellProfile()) !== 'cloud') return;
      await withTenant(
        { tenantId, permissions: new Set<string>() },
        async () => {
          const db = await this.dbOf();
          if (!(await db.tableExists(USAGE_TABLE))) return;
          const end = this.now();
          const metrics = await TenantUsageMetricCollection.create({ db });
          await metrics.recordUsage({
            tenantId,
            metricKey: row.metricKey,
            quantity: row.quantity,
            windowStart: new Date(end - row.spanMs),
            windowEnd: new Date(end),
            source: WORKER_SOURCE,
            sourceId: randomUUID(),
            dimensions: row.dimensions,
          });
        },
      ).catch(() => {});
      // The gauge (once per bucket, as ever); its own failures are swallowed.
      await this.sample(tenantId).catch(() => false);
    } catch {
      // Metering never fails a wake or a close.
    }
  }

  startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.sweep().catch(() => {}),
      this.sweepMs,
    );
    this.timer.unref?.();
  }

  /** Stop the timer and forget every tenant (tests, shutdown). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.seen.clear();
    this.inflight.clear();
    this.tableReady = false;
  }
}

let shared: StorageMeter | null = null;

/** The process's meter (created on first use). */
export function storageMeter(): StorageMeter {
  shared ??= new StorageMeter();
  return shared;
}

/** Stop and drop the process's meter (tests). */
export function resetStorageMeter(next: StorageMeter | null = null): void {
  shared?.stop();
  shared = next;
}

/** A tenant's storage and request metrics for a period, from the session's tenant. */
export function readTenantUsage(window: {
  start: Date;
  end: Date;
}): Promise<TenantUsage> {
  return storageMeter().read(window);
}

/** The calendar month (UTC) containing `at`: the period usage is reported in. */
export function monthWindow(at: Date = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
    end: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
  };
}

/** The stored measurement time of a sample; the bucket start for a row without one. */
function measuredAt(row: {
  windowStart: Date;
  getDimensions(): Record<string, unknown>;
}): Date {
  const at = new Date(String(row.getDimensions().sampledAt ?? ''));
  return Number.isNaN(at.getTime()) ? row.windowStart : at;
}
