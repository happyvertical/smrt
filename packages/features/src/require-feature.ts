/**
 * Feature gates for routes and services (#4761), following the saas-starter
 * `mcp.ts` pattern: a gated capability below the tenant's tier gets a
 * structured "upgrade" answer naming the key and the plan that grants it,
 * and a feature an operator disabled gets a structured "disabled" answer;
 * never a bare 403.
 *
 * The gate's authorization semantics are "feature present" only. It is not an
 * identity or permission check: callers still authenticate the principal and
 * check its permissions, and must pass the tenant they already verified the
 * principal belongs to.
 */
import type { FeatureResolver } from './feature-resolver.js';
import { getFrameworkFeature } from './framework-features.js';
import type {
  FeatureDecisionLayer,
  FeatureGrantingPlan,
  FeatureResolutionContext,
} from './types.js';

/** HTTP status of every gate denial: forbidden, with a reason in the body. */
export const FEATURE_GATE_STATUS = 403;

/** Denial code when a plan upgrade could turn the feature on. */
export const FEATURE_UPGRADE_REQUIRED_CODE = 'feature_upgrade_required';

/**
 * Denial code when an explicit DISABLE override turned the feature off. The
 * global override outranks plan grants, and a tenant override outranks
 * everything, so no upgrade would help; the body names no plan.
 */
export const FEATURE_DISABLED_CODE = 'feature_disabled';

interface FeatureGateDenialBase {
  featureKey: string;
  /** Human label of the feature, when it is a known framework feature. */
  label: string | null;
  /** Whether the feature is a paid key (`metadata.paid`). */
  paid: boolean;
  tenantId: string | null;
  message: string;
}

/** Denial body when the tenant's plan does not grant the key. JSON-safe. */
export interface FeatureUpgradeRequired extends FeatureGateDenialBase {
  code: typeof FEATURE_UPGRADE_REQUIRED_CODE;
  /** The plan that grants the key, when a grant source can name one. */
  grantingPlan: FeatureGrantingPlan | null;
}

/** Denial body when an operator override disabled the key. JSON-safe. */
export interface FeatureDisabled extends FeatureGateDenialBase {
  code: typeof FEATURE_DISABLED_CODE;
  /** Which override turned the feature off. */
  disabledBy: Extract<
    FeatureDecisionLayer,
    'global_override' | 'tenant_override'
  >;
}

/** A gate denial, discriminated by `code`. */
export type FeatureGateDenial = FeatureUpgradeRequired | FeatureDisabled;

export interface FeatureGateOptions extends FeatureResolutionContext {
  /** The request's resolver; reuse one per request. */
  resolver: Pick<FeatureResolver, 'explain' | 'findGrantingPlan'>;
}

export type FeatureGateResult =
  | { allowed: true; featureKey: string }
  | { allowed: false; featureKey: string; denial: FeatureGateDenial };

/**
 * Thrown by {@link requireFeature}; carries the structured denial body.
 * Branch on `code` (or `denial.code`) to tell an upgrade from a disabled
 * feature.
 */
export class FeatureUnavailableError extends Error {
  readonly status = FEATURE_GATE_STATUS;
  readonly denial: FeatureGateDenial;

  constructor(denial: FeatureGateDenial) {
    super(denial.message);
    this.name = 'FeatureUnavailableError';
    this.denial = denial;
  }

  get code(): FeatureGateDenial['code'] {
    return this.denial.code;
  }

  get featureKey(): string {
    return this.denial.featureKey;
  }

  /** The denial response for a SvelteKit `+server.ts` or any fetch handler. */
  toResponse(init: ResponseInit = {}): Response {
    return featureDenialResponse(this.denial, init);
  }
}

/**
 * Resolve `featureKey` for the context and describe the denial when it is
 * off. An explicit DISABLE override answers {@link FEATURE_DISABLED_CODE};
 * anything else answers {@link FEATURE_UPGRADE_REQUIRED_CODE} with the plan
 * that grants the key. A failure to name the granting plan never turns a
 * denial into an error: the plan is informational, so it falls back to `null`.
 */
export async function checkFeature(
  featureKey: string,
  options: FeatureGateOptions,
): Promise<FeatureGateResult> {
  const { resolver, ...context } = options;
  const resolution = await resolver.explain(featureKey, context);
  if (resolution.enabled) {
    return { allowed: true, featureKey };
  }

  const definition = getFrameworkFeature(featureKey);
  const label = definition?.label ?? null;
  const name = label ?? featureKey;
  const base = {
    featureKey,
    label,
    paid: definition?.metadata?.paid === true,
    tenantId: context.tenantId ?? null,
  };

  if (
    resolution.decidedBy === 'global_override' ||
    resolution.decidedBy === 'tenant_override'
  ) {
    return {
      allowed: false,
      featureKey,
      denial: {
        code: FEATURE_DISABLED_CODE,
        ...base,
        disabledBy: resolution.decidedBy,
        message: `${name} is disabled.`,
      },
    };
  }

  let grantingPlan: FeatureGrantingPlan | null = null;
  try {
    grantingPlan = await resolver.findGrantingPlan(featureKey, context);
  } catch {
    grantingPlan = null;
  }

  const message = grantingPlan
    ? `${name} requires the ${grantingPlan.name || grantingPlan.planKey} plan.`
    : `${name} is not included in the current plan.`;

  return {
    allowed: false,
    featureKey,
    denial: {
      code: FEATURE_UPGRADE_REQUIRED_CODE,
      ...base,
      grantingPlan,
      message,
    },
  };
}

/**
 * Service gate: resolves when `featureKey` is on, otherwise throws
 * {@link FeatureUnavailableError}.
 */
export async function requireFeature(
  featureKey: string,
  options: FeatureGateOptions,
): Promise<void> {
  const result = await checkFeature(featureKey, options);
  if (!result.allowed) {
    throw new FeatureUnavailableError(result.denial);
  }
}

/**
 * Route gate: `null` when `featureKey` is on, otherwise the JSON denial
 * response to return from the handler.
 *
 * ```ts
 * const denied = await featureGateResponse(FEATURE_SYNC_DEVICES, {
 *   resolver, tenantId, grantSource,
 * });
 * if (denied) return denied;
 * ```
 */
export async function featureGateResponse(
  featureKey: string,
  options: FeatureGateOptions,
): Promise<Response | null> {
  const result = await checkFeature(featureKey, options);
  return result.allowed ? null : featureDenialResponse(result.denial);
}

/** JSON response for a denial body (`403` with the reason in the body). */
export function featureDenialResponse(
  denial: FeatureGateDenial,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify({ error: denial.message, ...denial }), {
    ...init,
    status: init.status ?? FEATURE_GATE_STATUS,
    headers,
  });
}
