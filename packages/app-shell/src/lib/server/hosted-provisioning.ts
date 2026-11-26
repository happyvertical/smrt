// Hosted key provisioning and the entitlement-change listener (#5194).
//
// When a tenant's plan gains, loses or changes `inference.hosted`, the billing
// writer (the host's webhook, wrapped in smrt-subscriptions'
// `trackEntitlementChange`) notifies the listeners registered in this process.
// The one registered here reconciles the tenant with smrt-inference's
// provisioner: entitled provisions a gateway key for each active member
// (budget from the grant's `metadata.budget`), not entitled revokes them.
//
// Cloud only, and only where the operator configured a gateway
// (`SMRT_INFERENCE_HOSTED_*`): with none there is nothing to provision, the
// listener is not registered, and the gate still refuses every hosted call.
// The desktop never reaches this: nothing is imported or registered there.
import { subscribeToChangeSignals } from '@happyvertical/smrt-core';
import {
  createHostedInferenceEntitlementListener,
  createHostedInferenceProvisioner,
  createHostedInferenceReconciler,
  HOSTED_INFERENCE_FEATURE_KEY,
  type HostedGatewayAdmin,
  HostedInferenceError,
  type HostedInferenceProvisioner,
  hostedGatewayConfigFromEnv,
} from '@happyvertical/smrt-inference/node';
import type { DatabaseInterface } from '@happyvertical/sql';
import { shellProfile } from './host.ts';
import { inTenant, isHostedInferenceEntitled } from './hosted-inference.ts';

/** Who the provisioner records as acting in the audit log. */
export const HOSTED_PROVISIONING_ACTOR = 'smrt-app-shell';

/** Default gap between repair passes over every tenant (six hours). */
export const HOSTED_RECONCILE_INTERVAL_MS = 6 * 60 * 60_000;
/** Delay before the first repair pass after the server starts. */
const FIRST_RECONCILE_DELAY_MS = 60_000;
/** Tenants read per page when the repair pass lists them. */
const TENANT_PAGE = 200;

let unregister: (() => void) | undefined;
let stopRunning: (() => void) | undefined;

/**
 * The users who should hold a hosted key while the tenant is entitled: its
 * active members.
 */
async function activeMembers(
  db: DatabaseInterface,
  tenantId: string,
): Promise<string[]> {
  const { MembershipCollection } = await import('@happyvertical/smrt-users');
  const memberships = await (
    await MembershipCollection.create({ db })
  ).findActiveByTenant(tenantId);
  return [...new Set(memberships.map((m) => String(m.userId)))].sort();
}

/** What one tenant's reconcile did. */
export interface HostedTenantReconcile {
  tenantId: string;
  /** Whether the plan grants `inference.hosted` now. */
  entitled: boolean;
  provisioned: number;
  revoked: number;
  /** Members who left the tenant and lost their key. */
  removed: number;
  /** Users whose provisioning, revocation or sync failed. */
  failures: Array<{ userId: string; error: unknown }>;
}

/** What one pass over every tenant did. */
export interface HostedReconcileAll {
  tenants: number;
  provisioned: number;
  revoked: number;
  removed: number;
  /** Tenants whose reconcile failed outright, and users that failed in the rest. */
  failures: Array<{ tenantId: string; userId?: string; error: unknown }>;
}

/**
 * Converge one tenant's hosted keys with its plan and its members, both ways:
 * the plan's `inference.hosted` grant decides whether keys exist, and the
 * tenant's active members decide who holds one. A member who joined after the
 * plan did gets a key; one who left (membership removed or no longer active)
 * loses theirs while the tenant stays entitled. Idempotent: a tenant already
 * converged makes no gateway call. Never throws for a single user's failure
 * (it is in `failures`); it does throw when the plan cannot be read.
 */
async function reconcileTenant(
  ctx: {
    db: DatabaseInterface;
    provisioner: HostedInferenceProvisioner;
    reconcile: ReturnType<typeof createHostedInferenceReconciler>;
  },
  tenantId: string,
): Promise<HostedTenantReconcile> {
  const [{ SubscriptionResolver, snapshotEntitlements }] = await Promise.all([
    import('@happyvertical/smrt-subscriptions'),
  ]);
  const resolver = await SubscriptionResolver.create({ db: ctx.db });
  const snapshot = await inTenant(tenantId, () =>
    snapshotEntitlements(resolver, tenantId),
  );
  const out: HostedTenantReconcile = {
    tenantId,
    entitled: false,
    provisioned: 0,
    revoked: 0,
    removed: 0,
    failures: [],
  };
  const tally = (result: Awaited<ReturnType<typeof ctx.reconcile>>) => {
    out.provisioned += result.provisioned.filter((p) => p.created).length;
    out.revoked += result.revoked.filter((r) => r.revoked).length;
    out.failures.push(...result.failures);
  };
  try {
    tally(await ctx.reconcile(tenantId, snapshot));
  } catch (error) {
    // The reconciler throws after trying every user; their failures are in
    // the error's details, and the pass below still has to run.
    const users = (error as { details?: { users?: string[] } }).details?.users;
    if (!users) throw error;
    for (const userId of users) out.failures.push({ userId, error });
  }
  out.entitled = snapshot.grants.some(
    (grant) =>
      grant.featureKey === HOSTED_INFERENCE_FEATURE_KEY &&
      grant.enabled !== false,
  );
  if (!out.entitled) return out;
  // The reconciler only adds and syncs while entitled: take the keys back
  // from people who are no longer members.
  const members = new Set(await activeMembers(ctx.db, tenantId));
  for (const userId of await ctx.provisioner.listActive(tenantId)) {
    if (members.has(userId)) continue;
    try {
      const result = await ctx.provisioner.revoke({
        tenantId,
        userId,
        reason: 'member-removed',
      });
      if (result.revoked) {
        out.revoked += 1;
        out.removed += 1;
      }
    } catch (error) {
      out.failures.push({ userId, error });
    }
  }
  return out;
}

/** Every active tenant's id, a page at a time. */
async function activeTenantIds(db: DatabaseInterface): Promise<string[]> {
  const { TenantCollection, TenantStatus } = await import(
    '@happyvertical/smrt-users'
  );
  const tenants = await TenantCollection.create({ db });
  const ids: string[] = [];
  for (let offset = 0; ; offset += TENANT_PAGE) {
    const page = await tenants.list({
      where: { status: TenantStatus.ACTIVE },
      orderBy: 'id ASC',
      limit: TENANT_PAGE,
      offset,
    });
    for (const tenant of page) ids.push(String(tenant.id));
    if (page.length < TENANT_PAGE) return ids;
  }
}

/**
 * Cloud only: register the entitlement-change listener for hosted inference.
 * Call after `installHostedInferenceGate` (the provisioner's entitlement
 * re-check uses its stores). Returns whether a listener was registered:
 * `false` locally, or when no hosted gateway is configured. A gateway that is
 * configured but incomplete throws, so the server does not start half set up.
 * The PostgreSQL pool needs at least three connections (the provisioner's
 * per-tenant advisory lock holds one while the operation uses others).
 */
export async function installHostedProvisioning(options: {
  db: () => Promise<DatabaseInterface>;
  /** Tests: a fake gateway admin client, in place of the real one. */
  admin?: HostedGatewayAdmin;
  /** Tests: the environment the gateway is read from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /**
   * Gap between repair passes over every tenant; 0 turns the timer off (the
   * member watcher stays). Default {@link HOSTED_RECONCILE_INTERVAL_MS}.
   */
  reconcileIntervalMs?: number;
}): Promise<boolean> {
  if ((await shellProfile()) !== 'cloud') return false;
  const db = await options.db();
  const env = options.env ?? process.env;
  const gateway = hostedGatewayConfigFromEnv(env);
  if (!gateway) {
    // Gateway variables without a provider would be ignored silently: refuse.
    const stray = Object.keys(env).filter(
      (name) => name.startsWith('SMRT_INFERENCE_HOSTED_') && env[name]?.trim(),
    );
    if (stray.length > 0)
      throw new HostedInferenceError(
        `Hosted inference gateway variables are set (${stray.join(', ')}) but SMRT_INFERENCE_HOSTED_PROVIDER is not.`,
        'HOSTED_GATEWAY_NOT_CONFIGURED',
      );
    return false;
  }
  // The provisioned keys are stored as secrets: fail at start, not at the
  // first plan change.
  if (!process.env.SMRT_SECRET_MASTER_KEY?.trim())
    throw new HostedInferenceError(
      'Hosted inference provisioning needs SMRT_SECRET_MASTER_KEY.',
      'HOSTED_GATEWAY_NOT_CONFIGURED',
    );
  const provisioner = createHostedInferenceProvisioner({
    db,
    gateway,
    ...(options.admin ? { admin: options.admin } : {}),
    actor: HOSTED_PROVISIONING_ACTOR,
    entitled: isHostedInferenceEntitled,
  });
  const { registerEntitlementChangeListener } = await import(
    '@happyvertical/smrt-subscriptions'
  );
  const listenerOptions = {
    provisioner,
    users: (tenantId: string) => activeMembers(db, tenantId),
  };
  const ctx = {
    db,
    provisioner,
    reconcile: createHostedInferenceReconciler(listenerOptions),
  };
  stopRunning?.();
  unregister?.();
  unregister = registerEntitlementChangeListener(
    createHostedInferenceEntitlementListener(listenerOptions),
  );
  // Members who join or leave a tenant that is already entitled, and the
  // repair pass over every tenant, run through the same reconcile.
  const stopMembers = watchMemberships(db, (tenantId) =>
    reconcileTenant(ctx, tenantId),
  );
  const stopTimer = scheduleRepair(
    options.reconcileIntervalMs ?? HOSTED_RECONCILE_INTERVAL_MS,
    async () => {
      const outcome = await reconcileAllTenants(ctx);
      reportFailures(outcome.failures);
    },
  );
  stopRunning = () => {
    stopMembers();
    stopTimer();
  };
  activeContext = ctx;
  return true;
}

/**
 * Repair pass: reconcile every active tenant, one after another. A tenant that
 * fails does not stop the others. Idempotent; the same call a timer makes.
 * Resolves to `undefined` where hosted provisioning is not installed (local,
 * or no gateway configured): it makes no call at all there.
 */
export async function reconcileAllHostedTenants(): Promise<
  HostedReconcileAll | undefined
> {
  return activeContext ? reconcileAllTenants(activeContext) : undefined;
}

/** One tenant's reconcile; `undefined` where provisioning is not installed. */
export async function reconcileHostedTenant(
  tenantId: string,
): Promise<HostedTenantReconcile | undefined> {
  return activeContext ? reconcileTenant(activeContext, tenantId) : undefined;
}

type ReconcileContext = Parameters<typeof reconcileTenant>[0];
let activeContext: ReconcileContext | undefined;

async function reconcileAllTenants(
  ctx: ReconcileContext,
): Promise<HostedReconcileAll> {
  const total: HostedReconcileAll = {
    tenants: 0,
    provisioned: 0,
    revoked: 0,
    removed: 0,
    failures: [],
  };
  for (const tenantId of await activeTenantIds(ctx.db)) {
    total.tenants += 1;
    try {
      const one = await reconcileTenant(ctx, tenantId);
      total.provisioned += one.provisioned;
      total.revoked += one.revoked;
      total.removed += one.removed;
      for (const f of one.failures) total.failures.push({ tenantId, ...f });
    } catch (error) {
      total.failures.push({ tenantId, error });
    }
  }
  return total;
}

function reportFailures(
  failures: Array<{ tenantId: string; userId?: string; error: unknown }>,
): void {
  for (const f of failures)
    process.stderr.write(
      `Hosted inference reconcile failed for tenant ${f.tenantId}${f.userId ? ` user ${f.userId}` : ''}: ${f.error instanceof Error ? f.error.message : String(f.error)}\n`,
    );
}

/** Table of tenant memberships, as named in change signals. */
async function membershipTable(db: DatabaseInterface): Promise<string> {
  const { MembershipCollection } = await import('@happyvertical/smrt-users');
  return (await MembershipCollection.create({ db })).tableName;
}

/**
 * Reconcile a tenant when one of its memberships is added, changed or removed.
 * Rides core's change signals (every membership write path, in any replica),
 * so users needs no hook of its own. Bursts for one tenant coalesce into one
 * run; tenants run one at a time; a failure is reported and left to the next
 * repair pass.
 */
function watchMemberships(
  db: DatabaseInterface,
  reconcile: (tenantId: string) => Promise<HostedTenantReconcile>,
): () => void {
  const pending = new Set<string>();
  let draining = false;
  let stopped = false;
  let table: string | undefined;
  const drain = async () => {
    // `draining` clears in the same turn the loop sees `pending` empty, so a
    // signal arriving later starts a new drain instead of being lost.
    draining = true;
    try {
      while (!stopped && pending.size > 0) {
        const [tenantId] = pending;
        pending.delete(tenantId);
        try {
          const outcome = await reconcile(tenantId);
          reportFailures(outcome.failures.map((f) => ({ tenantId, ...f })));
        } catch (error) {
          reportFailures([{ tenantId, error }]);
        }
      }
    } finally {
      draining = false;
    }
  };
  const unsubscribe = subscribeToChangeSignals(db, (signal) => {
    if (stopped || !signal.tenantId) return;
    const tenantId = signal.tenantId;
    void membershipTable(db)
      .then((name) => {
        table ??= name;
        if (signal.table !== table || stopped) return;
        pending.add(tenantId);
        if (!draining) void drain();
      })
      .catch(() => {});
  });
  return () => {
    stopped = true;
    pending.clear();
    unsubscribe();
  };
}

/** Run `task` after a short delay and then every `intervalMs`, never overlapping. */
function scheduleRepair(
  intervalMs: number,
  task: () => Promise<void>,
): () => void {
  if (!(intervalMs > 0)) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = (delay: number) => {
    timer = setTimeout(async () => {
      try {
        await task();
      } catch (error) {
        reportFailures([{ tenantId: '(all)', error }]);
      }
      if (!stopped) arm(intervalMs);
    }, delay);
    timer.unref?.();
  };
  arm(Math.min(FIRST_RECONCILE_DELAY_MS, intervalMs));
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Stop the member watcher and the repair timer (shutdown). */
export function stopHostedProvisioning(): void {
  stopRunning?.();
  stopRunning = undefined;
  activeContext = undefined;
}

/** Tests: drop the registered listener. */
export function resetHostedProvisioning(): void {
  stopHostedProvisioning();
  unregister?.();
  unregister = undefined;
}
