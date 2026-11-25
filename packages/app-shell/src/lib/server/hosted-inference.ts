// Hosted inference in the cloud profile (#5194): the shell registers
// smrt-inference's hosted gate (kill switch, plan entitlement, tenant and
// per-user spend caps) at startup and refuses to start without it, and the
// assistant may use a hosted target only for a tenant whose plan grants the
// standard `inference.hosted` feature. The desktop (local profile) never
// reaches any of this: nothing is imported, registered or read there.
//
// smrt-features and smrt-subscriptions are imported lazily, only on the cloud
// path, so a desktop process never registers their models (and
// `prepareShellSchema` never creates their tables).
import {
  getInferenceGate,
  InferenceUnavailableError,
  requireInferenceGate,
} from '@happyvertical/smrt-core';
import {
  HOSTED_INFERENCE_KILL_SWITCH,
  type HostedInferenceGate,
  type HostedKillSwitchStore,
  type HostedSpendEvaluator,
  registerHostedInferenceGate,
} from '@happyvertical/smrt-inference/gate';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { shellProfile } from './host.ts';

/** What the shell needs from the platform's entitlement stores. */
export interface HostedInferenceDeps {
  killSwitch: HostedKillSwitchStore;
  spend: HostedSpendEvaluator;
  /** Whether the tenant's plan grants `inference.hosted` (and no override disables it). */
  entitled(tenantId: string): Promise<boolean>;
}

let installed:
  | { gate: HostedInferenceGate; deps: HostedInferenceDeps }
  | undefined;

/**
 * The real stores over one database: smrt-features' kill switch and flag
 * resolver, smrt-subscriptions' spend evaluator and plan grant source.
 */
export async function createHostedInferenceDeps(
  db: DatabaseInterface,
): Promise<HostedInferenceDeps> {
  const [features, subscriptions] = await Promise.all([
    import('@happyvertical/smrt-features'),
    import('@happyvertical/smrt-subscriptions'),
  ]);
  const killSwitch = new features.KillSwitchService({ db });
  const resolver = new features.FeatureResolver({ db });
  const grantSource = await subscriptions.SubscriptionFeatureSource.create(
    { db },
    { memoize: false },
  );
  const spend = await subscriptions.HostedAiSpendEvaluator.create({ db });
  return {
    killSwitch,
    spend,
    entitled: (tenantId) =>
      resolver.isEnabled(features.FEATURE_INFERENCE_HOSTED, {
        tenantId,
        grantSource,
      }),
  };
}

/**
 * Plan and usage rows are tenant-scoped: evaluate inside the tenant being
 * billed, which a background call (a job, a shared agent client) may not have
 * as its ambient one. The rows are read for that tenant only.
 */
export function inTenant<T>(
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const current = getCurrentTenant();
  if (current?.tenantId?.toLowerCase() === tenantId.toLowerCase()) return fn();
  return withTenant({ tenantId }, fn);
}

/**
 * Cloud only: build and register the hosted gate. Throws (so the server does
 * not start) when the stores cannot be built or the kill switch cannot be
 * read, for instance because the migration for smrt-features or
 * smrt-subscriptions has not run. Local: does nothing and returns undefined.
 */
export async function installHostedInferenceGate(options: {
  db: () => Promise<DatabaseInterface>;
  /** Tests: fakes in place of the real stores. */
  deps?: HostedInferenceDeps;
}): Promise<HostedInferenceGate | undefined> {
  if ((await shellProfile()) !== 'cloud') return undefined;
  // From here a hosted call that finds no gate is refused, never run
  // unchecked (core's seam is fail-open by default). Set before the stores
  // are built so a failed build leaves the process closed, not open.
  requireInferenceGate(true);
  const deps =
    options.deps ?? (await createHostedInferenceDeps(await options.db()));
  const spend: HostedSpendEvaluator = {
    evaluate: (input) =>
      inTenant(input.tenantId, () => deps.spend.evaluate(input)),
    invalidate: (tenantId) => deps.spend.invalidate?.(tenantId),
  };
  // The switch must be readable before any hosted call is ever asked.
  await deps.killSwitch.read(HOSTED_INFERENCE_KILL_SWITCH, {});
  const gate = registerHostedInferenceGate({
    killSwitch: deps.killSwitch,
    spend,
  });
  installed = { gate, deps };
  return gate;
}

/** Tests: forget the installed gate (the caller clears core's seam). */
export function resetHostedInference(): void {
  installed = undefined;
  requireInferenceGate(false);
}

/**
 * Whether the tenant's plan grants `inference.hosted` (and no override
 * disables it), through the stores `installHostedInferenceGate` built. Throws
 * when no gate is installed: an unchecked answer is never "yes" or "no".
 */
export async function isHostedInferenceEntitled(
  tenantId: string,
): Promise<boolean> {
  const current = installed;
  if (!current || getInferenceGate() !== current.gate)
    throw new Error('the hosted inference gate is not installed');
  return inTenant(tenantId, () => current.deps.entitled(tenantId));
}

/**
 * Throws when a hosted target may not be used for `tenantId`: no gate is
 * registered, or the tenant's plan does not grant `inference.hosted`. The
 * error is core's `InferenceUnavailableError` (`entitlement`), so the owner
 * gets the same clear message as a gate refusal.
 */
export async function assertHostedInferenceEntitled(
  tenantId: string,
): Promise<void> {
  const refuse = (policy: string) =>
    new InferenceUnavailableError({
      reason: 'entitlement',
      mode: 'hosted',
      entitlement: { policy },
    });
  // No gate means every hosted call would run unchecked: never in cloud.
  const current = installed;
  if (!current || getInferenceGate() !== current.gate)
    throw refuse('gate-error');
  const entitled = await isHostedInferenceEntitled(tenantId);
  if (!entitled) throw refuse('subscription');
}
