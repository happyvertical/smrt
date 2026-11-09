/**
 * The hosted inference gate (#4760, epic #4667): Node-only, so it stays off
 * the browser-safe root entry.
 *
 * Core asks the registered `InferenceGate` before every `source: hosted`
 * call (`byo`, `local` and `app` targets never reach it). This gate, in
 * order:
 *
 * 1. **Kill switch.** `inference.hosted.enabled`
 *    ({@link HOSTED_INFERENCE_KILL_SWITCH}): a global DISABLE, then the
 *    tenant's own DISABLE, blocks every hosted call at once, whatever the
 *    plan or spend. Read uncached on every call, without any model call.
 *    This is the incident lever
 *    (`smrt inference:hosted disable [--tenant <id>]`).
 * 2. **Tenant.** A hosted call with no tenant to bill is blocked.
 * 3. **Entitlement.** The tenant's entitled plan thresholds through
 *    smrt-subscriptions' `SubscriptionResolver` (memoized per tenant by the
 *    evaluator: once per request burst). No entitled subscription blocks
 *    unless `requireSubscription` is false.
 * 4. **Spend.** The plan's `ai.hosted.spend_micros` (tenant) and
 *    `ai.hosted.user_spend_micros` (per user) caps against metered hosted
 *    spend in each cap's window, read fresh from `_smrt_ai_usage`: block,
 *    warn (`onWarning`), or allow.
 *
 * Any error (a database or resolver outage, missing tables, a malformed
 * cap) propagates, and core turns it into a fail-closed block (policy
 * `gate-error`) that counts as no spend.
 *
 * The kill-switch store and spend evaluator are structural: smrt-features'
 * `KillSwitchService` and smrt-subscriptions' `HostedAiSpendEvaluator`
 * satisfy them. Both packages build with the CLI, which depends on this
 * one, so this package must not depend on them.
 */

import {
  type InferenceEntitlementDetails,
  type InferenceGate,
  type InferenceGateDecision,
  type InferenceGateRequest,
  setAiUsageUserResolver,
  setInferenceGate,
} from '@happyvertical/smrt-core';
import {
  getAmbientInferencePrincipal,
  type InferencePrincipal,
} from './resolver.js';

/**
 * The hosted-inference kill switch key, stored as smrt-features override
 * rows and read with kill-switch semantics (smrt-features
 * `readKillSwitch()`): a global DISABLE, then the tenant's own DISABLE.
 * Persisted identifier: never rename.
 */
export const HOSTED_INFERENCE_KILL_SWITCH = 'inference.hosted.enabled';

/** A kill switch's state (smrt-features `KillSwitchState`, structurally). */
export interface HostedKillSwitchState {
  key: string;
  enabled: boolean;
  disabledBy?: 'global' | 'tenant';
}

/** Reads (and optionally writes) kill switches: `KillSwitchService`. */
export interface HostedKillSwitchStore {
  read(
    key: string,
    options: { tenantId?: string | null },
  ): Promise<HostedKillSwitchState>;
  set?(
    key: string,
    options: { enabled: boolean; tenantId?: string | null },
  ): Promise<HostedKillSwitchState>;
}

/** One cap evaluation, as smrt-subscriptions' `HostedAiSpendEvaluation`. */
export interface HostedSpendEvaluation {
  policy: string;
  /** Integer micro-dollars. */
  cap: number;
  /** Integer micro-dollars. */
  spend: number;
  resetsAt: Date | null;
}

/** The spend decision, as smrt-subscriptions' `HostedAiSpendDecision`. */
export interface HostedSpendDecision {
  state: 'ok' | 'warn' | 'blocked';
  entitled: boolean;
  decidedBy: HostedSpendEvaluation | null;
}

/** Evaluates hosted spend against the plan: `HostedAiSpendEvaluator`. */
export interface HostedSpendEvaluator {
  evaluate(input: {
    tenantId: string;
    userId?: string;
  }): Promise<HostedSpendDecision>;
  invalidate?(tenantId?: string): void;
}

/** A hosted call allowed past a warning threshold. */
export interface HostedInferenceGateWarning {
  tenantId: string;
  userId?: string;
  details: InferenceEntitlementDetails;
  request: InferenceGateRequest;
}

/** Options for {@link createHostedInferenceGate}. */
export interface HostedInferenceGateOptions {
  /** Kill-switch store: `new KillSwitchService({ db })` (smrt-features). */
  killSwitch: HostedKillSwitchStore;
  /** Spend: `await HostedAiSpendEvaluator.create({ db })` (smrt-subscriptions). */
  spend: HostedSpendEvaluator;
  /**
   * The acting principal; default the ambient one (tenancy context, then
   * the users session), the same read the per-user resolver makes.
   */
  principal?: () => InferencePrincipal | undefined;
  /**
   * Block hosted calls for a tenant with no entitled subscription (default
   * `true`). Set `false` for apps that give hosted AI to every tenant and
   * use plans only for caps.
   */
  requireSubscription?: boolean;
  /** Called for a call allowed past a `warn` threshold. Must not throw. */
  onWarning?: (warning: HostedInferenceGateWarning) => void;
}

/** The gate, plus a way to drop memoized plan thresholds. */
export interface HostedInferenceGate extends InferenceGate {
  /** Forget memoized plan thresholds (all tenants, or one). */
  invalidate(tenantId?: string): void;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function block(details: InferenceEntitlementDetails): InferenceGateDecision {
  return { action: 'block', details };
}

function spendDetails(
  decision: HostedSpendDecision,
): InferenceEntitlementDetails | null {
  const by = decision.decidedBy;
  if (!by) return null;
  return {
    policy: by.policy,
    cap: by.cap,
    spend: by.spend,
    ...(by.resetsAt ? { resetsAt: by.resetsAt.toISOString() } : {}),
  };
}

/**
 * Create the hosted inference gate. Register it with
 * {@link registerHostedInferenceGate}.
 */
export function createHostedInferenceGate(
  options: HostedInferenceGateOptions,
): HostedInferenceGate {
  const principalOf = options.principal ?? getAmbientInferencePrincipal;
  const requireSubscription = options.requireSubscription !== false;
  const { killSwitch, spend } = options;

  return {
    async check(request) {
      const principal = principalOf();
      const tenantId = text(request.tenantId) ?? text(principal?.tenantId);

      const state = await killSwitch.read(HOSTED_INFERENCE_KILL_SWITCH, {
        ...(tenantId ? { tenantId } : {}),
      });
      if (state.enabled !== true) {
        return block({
          policy: 'kill-switch',
          ...(state.disabledBy ? { disabledBy: state.disabledBy } : {}),
        });
      }
      if (!tenantId) return block({ policy: 'no-tenant' });

      // The per-user cap applies to the principal's own user, in its own
      // tenant; a shared client (`userId: null`, agents) has none.
      const userId =
        request.userId === null ||
        text(principal?.tenantId)?.toLowerCase() !== tenantId.toLowerCase()
          ? undefined
          : text(principal?.userId);

      const decision = await spend.evaluate({
        tenantId,
        ...(userId ? { userId } : {}),
      });
      if (!decision.entitled && requireSubscription) {
        return block({ policy: 'subscription' });
      }
      if (decision.state === 'blocked') {
        const details = spendDetails(decision);
        // A blocked decision always names its cap; refuse to guess if not.
        if (!details) throw new Error('Hosted spend blocked without a cap.');
        return block(details);
      }
      if (decision.state === 'warn') {
        const details = spendDetails(decision);
        if (details) {
          try {
            options.onWarning?.({
              tenantId,
              ...(userId ? { userId } : {}),
              details,
              request,
            });
          } catch {
            // A warning sink never blocks or fails the call.
          }
          return { action: 'warn', details };
        }
      }
      return { action: 'allow' };
    },
    invalidate(tenantId) {
      spend.invalidate?.(tenantId);
    },
  };
}

/**
 * Register a hosted gate (or build one from options) with core's seam, and
 * the principal's user as the `userId` usage tag that per-user caps meter.
 * Returns the gate. To remove it, call core's `setInferenceGate(undefined)`
 * and `setAiUsageUserResolver(undefined)`.
 */
export function registerHostedInferenceGate(
  gateOrOptions: HostedInferenceGate | HostedInferenceGateOptions,
): HostedInferenceGate {
  const isGate =
    typeof (gateOrOptions as HostedInferenceGate).check === 'function';
  const gate = isGate
    ? (gateOrOptions as HostedInferenceGate)
    : createHostedInferenceGate(gateOrOptions as HostedInferenceGateOptions);
  const principalOf =
    (!isGate && (gateOrOptions as HostedInferenceGateOptions).principal) ||
    getAmbientInferencePrincipal;
  setInferenceGate(gate);
  setAiUsageUserResolver(() => text(principalOf()?.userId));
  return gate;
}

/** Read the hosted kill switch (global, then `tenantId`). No model call. */
export async function getHostedInferenceSwitch(
  killSwitch: HostedKillSwitchStore,
  options: { tenantId?: string | null } = {},
): Promise<HostedKillSwitchState> {
  return killSwitch.read(
    HOSTED_INFERENCE_KILL_SWITCH,
    options.tenantId ? { tenantId: options.tenantId } : {},
  );
}

/**
 * Turn hosted inference off (`enabled: false`) or back on, globally or for
 * one tenant: the incident lever. Takes effect on the next hosted call in
 * every process (the gate reads it uncached). Enabling a tenant does not
 * lift a global disable. The caller is the authorization: smrt-features'
 * `KillSwitchService.set()` writes the override rows directly (the CLI
 * holds database credentials); an admin UI writes through
 * `FeatureOverrideService` with its authorizer instead.
 */
export async function setHostedInferenceEnabled(
  killSwitch: HostedKillSwitchStore,
  options: { enabled: boolean; tenantId?: string | null },
): Promise<HostedKillSwitchState> {
  if (!killSwitch.set) {
    throw new Error('This kill-switch store is read-only.');
  }
  return killSwitch.set(HOSTED_INFERENCE_KILL_SWITCH, {
    enabled: options.enabled,
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
  });
}
