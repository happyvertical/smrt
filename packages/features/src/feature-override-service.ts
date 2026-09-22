import type { FeatureOverride } from './feature-override.js';
import type { FeatureOverrideCollection } from './feature-overrides.js';
import type { FeatureOverrideEffect, FeatureScopeType } from './types.js';

/** One override write the host must authorize before it runs (#3013). */
export interface FeatureOverrideWriteRequest {
  operation: 'set' | 'remove';
  featureKey: string;
  scopeType: FeatureScopeType;
  scopeId: string;
  /** Present for `set`. */
  effect?: FeatureOverrideEffect;
}

/**
 * The host's explicit authorization decision for one override write. Return
 * `true` only when the current caller may write that exact scope; anything
 * else denies.
 */
export type FeatureOverrideAuthorizer = (
  request: FeatureOverrideWriteRequest,
) => boolean | Promise<boolean>;

/** Thrown when the authorizer does not return `true`. Nothing is written. */
export class FeatureOverrideAuthorizationError extends Error {
  readonly status = 403;
  constructor(readonly request: FeatureOverrideWriteRequest) {
    super(
      `Feature override ${request.operation} denied for ${request.scopeType} scope`,
    );
    this.name = 'FeatureOverrideAuthorizationError';
  }
}

/**
 * Authorized write path for feature overrides (#3013). Override rows are
 * authorization state for every scope and `FeatureOverride` is not
 * tenant-scoped, so generated surfaces are closed. Hosts that let callers
 * change flags construct this service with an authorizer bound to the
 * current caller and write through it; every write asks the authorizer
 * first and fails closed.
 */
export class FeatureOverrideService {
  constructor(
    private readonly overrides: FeatureOverrideCollection,
    private readonly authorize: FeatureOverrideAuthorizer,
  ) {}

  async setOverride(
    featureKey: string,
    scopeType: FeatureScopeType,
    scopeId: string,
    effect: FeatureOverrideEffect,
  ): Promise<FeatureOverride> {
    await this.require({
      operation: 'set',
      featureKey,
      scopeType,
      scopeId,
      effect,
    });
    return this.overrides.setOverride(featureKey, scopeType, scopeId, effect);
  }

  async removeOverride(
    featureKey: string,
    scopeType: FeatureScopeType,
    scopeId: string,
  ): Promise<boolean> {
    await this.require({ operation: 'remove', featureKey, scopeType, scopeId });
    return this.overrides.removeOverride(featureKey, scopeType, scopeId);
  }

  private async require(request: FeatureOverrideWriteRequest): Promise<void> {
    let allowed = false;
    try {
      allowed = (await this.authorize(request)) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) throw new FeatureOverrideAuthorizationError(request);
  }
}
