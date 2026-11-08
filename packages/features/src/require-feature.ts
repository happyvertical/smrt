/**
 * Feature gates for routes and services (#4761), following the saas-starter
 * `mcp.ts` pattern: a gated capability below the tenant's tier gets a
 * structured "upgrade" answer naming the key and the plan that grants it,
 * never a bare 403.
 *
 * The gate's authorization semantics are "feature present" only. It is not an
 * identity or permission check: callers still authenticate the principal and
 * check its permissions, and must pass the tenant they already verified the
 * principal belongs to.
 */
import type { FeatureResolver } from './feature-resolver.js';
import { getFrameworkFeature } from './framework-features.js';
import type { FeatureGrantingPlan, FeatureResolutionContext } from './types.js';

/** HTTP status of an upgrade response: forbidden, with a reason in the body. */
export const FEATURE_UPGRADE_STATUS = 403;

/** Stable machine-readable code carried by every upgrade response. */
export const FEATURE_UPGRADE_REQUIRED_CODE = 'feature_upgrade_required';

/** Body of an upgrade response. JSON-safe. */
export interface FeatureUpgradeRequired {
  code: typeof FEATURE_UPGRADE_REQUIRED_CODE;
  featureKey: string;
  /** Human label of the feature, when it is a known framework feature. */
  label: string | null;
  /** Whether the feature is a paid key (`metadata.paid`). */
  paid: boolean;
  tenantId: string | null;
  /** The plan that grants the key, when a grant source can name one. */
  grantingPlan: FeatureGrantingPlan | null;
  message: string;
}

export interface FeatureGateOptions extends FeatureResolutionContext {
  /** The request's resolver; reuse one per request. */
  resolver: Pick<FeatureResolver, 'isEnabled' | 'findGrantingPlan'>;
}

export type FeatureGateResult =
  | { allowed: true; featureKey: string }
  | { allowed: false; featureKey: string; upgrade: FeatureUpgradeRequired };

/** Thrown by {@link requireFeature}; carries the structured upgrade body. */
export class FeatureUpgradeRequiredError extends Error {
  readonly status = FEATURE_UPGRADE_STATUS;
  readonly code = FEATURE_UPGRADE_REQUIRED_CODE;
  readonly upgrade: FeatureUpgradeRequired;

  constructor(upgrade: FeatureUpgradeRequired) {
    super(upgrade.message);
    this.name = 'FeatureUpgradeRequiredError';
    this.upgrade = upgrade;
  }

  get featureKey(): string {
    return this.upgrade.featureKey;
  }

  /** The upgrade response for a SvelteKit `+server.ts` or any fetch handler. */
  toResponse(init: ResponseInit = {}): Response {
    return featureUpgradeResponse(this.upgrade, init);
  }
}

/**
 * Resolve `featureKey` for the context and describe the upgrade when it is
 * off. A failure to name the granting plan never turns a denial into an
 * error: the plan is informational, so it falls back to `null`.
 */
export async function checkFeature(
  featureKey: string,
  options: FeatureGateOptions,
): Promise<FeatureGateResult> {
  const { resolver, ...context } = options;
  if (await resolver.isEnabled(featureKey, context)) {
    return { allowed: true, featureKey };
  }

  let grantingPlan: FeatureGrantingPlan | null = null;
  try {
    grantingPlan = await resolver.findGrantingPlan(featureKey, context);
  } catch {
    grantingPlan = null;
  }

  const definition = getFrameworkFeature(featureKey);
  const label = definition?.label ?? null;
  const name = label ?? featureKey;
  const message = grantingPlan
    ? `${name} requires the ${grantingPlan.name || grantingPlan.planKey} plan.`
    : `${name} is not included in the current plan.`;

  return {
    allowed: false,
    featureKey,
    upgrade: {
      code: FEATURE_UPGRADE_REQUIRED_CODE,
      featureKey,
      label,
      paid: definition?.metadata?.paid === true,
      tenantId: context.tenantId ?? null,
      grantingPlan,
      message,
    },
  };
}

/**
 * Service gate: resolves when `featureKey` is on, otherwise throws
 * {@link FeatureUpgradeRequiredError}.
 */
export async function requireFeature(
  featureKey: string,
  options: FeatureGateOptions,
): Promise<void> {
  const result = await checkFeature(featureKey, options);
  if (!result.allowed) {
    throw new FeatureUpgradeRequiredError(result.upgrade);
  }
}

/**
 * Route gate: `null` when `featureKey` is on, otherwise the JSON upgrade
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
  return result.allowed ? null : featureUpgradeResponse(result.upgrade);
}

/** JSON response for an upgrade body (`403` with the reason in the body). */
export function featureUpgradeResponse(
  upgrade: FeatureUpgradeRequired,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify({ error: upgrade.message, ...upgrade }), {
    ...init,
    status: init.status ?? FEATURE_UPGRADE_STATUS,
    headers,
  });
}
