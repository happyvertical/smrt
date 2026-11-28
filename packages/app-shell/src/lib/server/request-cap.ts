// The plan's request cap per billing period (#5198), cloud only.
//
// The cap is a plan threshold: `metricKey: 'api.requests'`, `enforcement:
// 'block'`, `limit` = requests, `window` = `day | week | month | year`
// (calendar, UTC) or `rolling` (the last 30 days), the same threshold shape and
// `getWindowForThreshold` the hosted AI spend caps use (#5194, hosted-inference
// docs). A plan with no such threshold, or one that only observes or warns,
// has no cap. The shell has no billing anchor of its own, so a "billing
// period" is the threshold's own window; a calendar month is the
// conservative reading of "per month". The strictest matching threshold wins.
//
// What counts: SERVED requests, the `api.requests` rows that carry no
// `refused` reason (`request-metering.ts`). A refused request (401, 403, 429,
// a 404, a parked DELETE, a cap refusal) never burns the cap. A row is
// assigned to the window its `windowStart` falls in, so a batch that straddles
// a boundary is counted once, in the period it began.
//
// Cheap: one plan read and one usage sum per tenant per `ttlMs` (30 s), then
// an in-memory count of requests admitted since. The persisted count lags the
// meter's flush (60 s, per process), drops on a failed write and is per
// process, so the cap is approximate: a tenant can pass it by about the
// requests one replica serves between reads, never by a lot more, and never
// stays over it past the next read. A failed lookup admits.
//
// smrt-subscriptions is imported lazily and only on the cloud path (as in
// `method-code.ts`): the desktop never loads, builds or asks anything of this.
import type {
  PlanThreshold,
  UsageWindow,
} from '@happyvertical/smrt-subscriptions';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { RequestCapRefusal } from '../../engine/index.ts';
import { shellProfile } from './host.ts';
import { inTenant } from './hosted-inference.ts';
import { requestMeter } from './request-metering.ts';
import { REQUEST_COUNT_METRIC } from './storage-metering.ts';

/** How long a plan read and a usage sum are trusted. */
export const DEFAULT_CAP_TTL_MS = 30_000;
const USAGE_TABLE = '_smrt_tenant_usage_metrics';
const MAX_TENANTS = 10_000;

/** The cap thresholds of a tenant's plan (valid, blocking, on `api.requests`). */
export type RequestCapPlan = (tenantId: string) => Promise<PlanThreshold[]>;
/** Served requests whose batch began inside `window`, as persisted. */
export type RequestUsage = (
  tenantId: string,
  window: UsageWindow,
) => Promise<number>;

export interface RequestCapOptions {
  plan: RequestCapPlan;
  usage: RequestUsage;
  /** Served requests this process holds that are not yet persisted. */
  pending?: (tenantId: string) => number;
  /** `getWindowForThreshold`. */
  windowOf: (window: PlanThreshold['window'], now: Date) => UsageWindow;
  now?: () => number;
  ttlMs?: number;
}

interface Cached {
  at: number;
  caps: Array<{ threshold: PlanThreshold; window: UsageWindow; base: number }>;
  /** Requests served here since `at`. */
  admitted: number;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export class RequestCapGate {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly state = new Map<string, Cached>();

  constructor(private readonly options: RequestCapOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_CAP_TTL_MS;
  }

  /**
   * Admit one request for the tenant (counting it), or return the refusal.
   * The tenant is the HOST's, never the request's.
   */
  async check(tenantId: string): Promise<RequestCapRefusal | null> {
    const at = this.now();
    let held = this.state.get(tenantId);
    if (!held || at - held.at >= this.ttlMs || this.rolledOver(held, at)) {
      held = await this.load(tenantId, at);
      this.state.delete(tenantId);
      this.state.set(tenantId, held);
      while (this.state.size > MAX_TENANTS) {
        const oldest = this.state.keys().next().value;
        if (oldest === undefined) break;
        this.state.delete(oldest);
      }
    }
    let worst: RequestCapRefusal | null = null;
    for (const cap of held.caps) {
      const used = cap.base + held.admitted;
      if (used < cap.threshold.limit) continue;
      const resetsAt =
        cap.threshold.window === 'rolling' ? null : cap.window.end;
      if (
        !worst ||
        (resetsAt && worst.resetsAt && resetsAt.toISOString() > worst.resetsAt)
      )
        worst = {
          limit: cap.threshold.limit,
          used,
          resetsAt: resetsAt ? resetsAt.toISOString() : null,
          message: `This app has used ${fmt(used)} of the ${fmt(cap.threshold.limit)} requests its plan allows ${periodWord(cap.threshold.window)}${resetsAt ? `; the count renews on ${resetsAt.toISOString().slice(0, 10)}` : ''}.`,
        };
    }
    // Asking never counts: core may still refuse an admitted request (401,
    // 403, a route limit). `noteServed` counts it once it was served.
    return worst;
  }

  /** One request was served for the tenant (the host's meter says so). */
  noteServed(tenantId: string): void {
    const held = this.state.get(tenantId);
    if (held) held.admitted += 1;
  }

  /** Forget what is held (tests, a plan change). */
  reset(tenantId?: string): void {
    if (tenantId) this.state.delete(tenantId);
    else this.state.clear();
  }

  /** A calendar window that ended since the last read must be read again. */
  private rolledOver(held: Cached, at: number): boolean {
    return held.caps.some(
      (c) => c.threshold.window !== 'rolling' && c.window.end.getTime() <= at,
    );
  }

  private async load(tenantId: string, at: number): Promise<Cached> {
    const thresholds = await this.options.plan(tenantId);
    const now = new Date(at);
    const caps = await Promise.all(
      thresholds.map(async (threshold) => {
        const window = this.options.windowOf(threshold.window, now);
        const persisted = await this.options.usage(tenantId, window);
        return {
          threshold,
          window,
          base: persisted + (this.options.pending?.(tenantId) ?? 0),
        };
      }),
    );
    return { at, caps, admitted: 0 };
  }
}

function periodWord(window: PlanThreshold['window']): string {
  return window === 'rolling' ? 'in any 30 days' : `this ${window}`;
}

let installed: RequestCapGate | undefined;

/** The real stores over one database: the plan's thresholds and the usage rows. */
export async function createRequestCapGate(
  db: DatabaseInterface,
  extra: Partial<RequestCapOptions> = {},
): Promise<RequestCapGate> {
  const subscriptions = await import('@happyvertical/smrt-subscriptions');
  const resolver = await subscriptions.SubscriptionResolver.create({ db });
  return new RequestCapGate({
    plan: (tenantId) =>
      inTenant(tenantId, async () => {
        const plan = await resolver.resolvePlanThresholds({
          kind: 'tenant',
          tenantId,
        });
        // Malformed or non-blocking thresholds are not a cap here.
        return plan.thresholds.filter(
          (t) =>
            t.metricKey === REQUEST_COUNT_METRIC &&
            t.enforcement === 'block' &&
            subscriptions.isValidThreshold(t) &&
            Number.isSafeInteger(t.limit),
        );
      }),
    usage: (tenantId, window) =>
      inTenant(tenantId, async () => {
        if (!(await db.tableExists(USAGE_TABLE))) return 0;
        const metrics = await subscriptions.TenantUsageMetricCollection.create({
          db,
        });
        const rows = await metrics.list({
          where: {
            tenantId,
            subscriberKind: 'tenant',
            metricKey: REQUEST_COUNT_METRIC,
            'windowStart >=': window.start.toISOString(),
            'windowStart <': window.end.toISOString(),
          },
          limit: 100_000,
        });
        let served = 0;
        for (const m of rows) {
          const dims = m.getDimensions();
          if (
            (typeof dims.refused === 'string' && dims.refused) ||
            dims.limited === true
          )
            continue;
          served += m.quantity;
        }
        return served;
      }),
    windowOf: subscriptions.getWindowForThreshold,
    ...extra,
  });
}

/**
 * Cloud only: build the gate once at startup. Throws (so the server does not
 * start) when the stores cannot be built. Local: does nothing.
 */
export async function installRequestCapGate(options: {
  db: () => Promise<DatabaseInterface>;
  /** Tests: a ready gate in place of the real stores. */
  gate?: RequestCapGate;
}): Promise<void> {
  if ((await shellProfile()) !== 'cloud') return;
  installed =
    options.gate ??
    (await createRequestCapGate(await options.db(), {
      // Served requests this process has not written yet count too.
      pending: (tenantId) => requestMeter().pendingServed(tenantId),
    }));
}

/** Tests: forget the installed gate. */
export function resetRequestCapGate(): void {
  installed = undefined;
}

/** The installed gate, or `undefined` before `installRequestCapGate` (or on the desktop). */
export function requestCapGate(): RequestCapGate | undefined {
  return installed;
}
