/**
 * Publish-policy transitions for a social account.
 *
 * `publishMode` and the `publicPublishingAllowed` latch together decide whether
 * an account can post publicly. This module is the one place that validates a
 * requested change and decides when it needs an explicit confirmation, so a
 * UI, an API route and an agent all enforce the same rule. It is pure: callers
 * own authorization, persistence and auditing.
 */
import { getSocialPlatformSetup } from './server.js';
import type { PublishMode, SocialPlatformType } from './social-account.js';

export interface PublishPolicyState {
  publishMode: PublishMode;
  publicPublishingAllowed: boolean;
}

export interface PublishPolicyChange {
  publishMode?: PublishMode;
  publicPublishingAllowed?: boolean;
}

export interface PublishPolicyPlan {
  before: PublishPolicyState;
  after: PublishPolicyState;
  changed: boolean;
  /** The account can post publicly after the change but could not before. */
  goesLive: boolean;
}

/** Thrown when a change would make the account post publicly and was not confirmed. */
export class PublishPolicyConfirmationRequired extends Error {
  readonly code = 'publish_policy_confirmation_required';
  constructor() {
    super(
      'Allowing public posting needs explicit confirmation (confirmPublic).',
    );
    this.name = 'PublishPolicyConfirmationRequired';
  }
}

/** Thrown for a mode the platform does not support or a malformed change. */
export class PublishPolicyInvalid extends Error {
  readonly code = 'publish_policy_invalid';
  constructor(message: string) {
    super(message);
    this.name = 'PublishPolicyInvalid';
  }
}

/** True when the state posts publicly: mode `public` with the latch set. */
export function isEffectivelyPublic(state: PublishPolicyState): boolean {
  return state.publishMode === 'public' && state.publicPublishingAllowed;
}

/** The modes an account on this platform may be set to, safest first. */
export function supportedPublishModes(
  platform: SocialPlatformType,
): PublishMode[] {
  return [...getSocialPlatformSetup(platform).supportedPublishModes];
}

/**
 * Validate a requested change and decide whether it needs confirmation.
 *
 * Only a change that ends in effective public posting (mode `public` and the
 * latch set) from a state that was not already public needs `confirmPublic`.
 * Lowering the mode or clearing the latch never does, so both stay instant as a
 * kill switch; re-raising after a kill switch is confirmed again.
 */
export function planPublishPolicyChange(
  platform: SocialPlatformType,
  current: PublishPolicyState,
  change: PublishPolicyChange,
  options: { confirmPublic?: boolean } = {},
): PublishPolicyPlan {
  if (
    change.publishMode === undefined &&
    change.publicPublishingAllowed === undefined
  ) {
    throw new PublishPolicyInvalid('Nothing to change.');
  }
  if (
    change.publicPublishingAllowed !== undefined &&
    typeof change.publicPublishingAllowed !== 'boolean'
  ) {
    throw new PublishPolicyInvalid(
      'publicPublishingAllowed must be a boolean.',
    );
  }
  if (
    change.publishMode !== undefined &&
    !supportedPublishModes(platform).includes(change.publishMode)
  ) {
    throw new PublishPolicyInvalid(
      `${platform} does not support publish mode ${String(change.publishMode)}.`,
    );
  }
  const after: PublishPolicyState = {
    publishMode: change.publishMode ?? current.publishMode,
    publicPublishingAllowed:
      change.publicPublishingAllowed ?? current.publicPublishingAllowed,
  };
  const goesLive = isEffectivelyPublic(after) && !isEffectivelyPublic(current);
  if (goesLive && options.confirmPublic !== true) {
    throw new PublishPolicyConfirmationRequired();
  }
  return {
    before: { ...current },
    after,
    changed:
      after.publishMode !== current.publishMode ||
      after.publicPublishingAllowed !== current.publicPublishingAllowed,
    goesLive,
  };
}
