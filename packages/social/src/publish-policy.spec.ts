import { describe, expect, it } from 'vitest';
import {
  isEffectivelyPublic,
  PublishPolicyConfirmationRequired,
  PublishPolicyInvalid,
  planPublishPolicyChange,
} from './publish-policy.js';

const dry = { publishMode: 'dry_run', publicPublishingAllowed: false } as const;
const live = { publishMode: 'public', publicPublishingAllowed: true } as const;

describe('planPublishPolicyChange', () => {
  it('requires confirmation to go effectively public', () => {
    expect(() =>
      planPublishPolicyChange('x', dry, {
        publishMode: 'public',
        publicPublishingAllowed: true,
      }),
    ).toThrow(PublishPolicyConfirmationRequired);
    const plan = planPublishPolicyChange(
      'x',
      dry,
      { publishMode: 'public', publicPublishingAllowed: true },
      { confirmPublic: true },
    );
    expect(plan.goesLive).toBe(true);
    expect(plan.after).toEqual(live);
  });

  it('requires confirmation when the second half of the pair completes it', () => {
    const modeOnly = {
      publishMode: 'public',
      publicPublishingAllowed: false,
    } as const;
    expect(
      planPublishPolicyChange('x', dry, { publishMode: 'public' }).goesLive,
    ).toBe(false);
    expect(() =>
      planPublishPolicyChange('x', modeOnly, { publicPublishingAllowed: true }),
    ).toThrow(PublishPolicyConfirmationRequired);
    // Kill switch then re-raise is confirmed again.
    const lowered = planPublishPolicyChange('x', live, {
      publishMode: 'dry_run',
    });
    expect(() =>
      planPublishPolicyChange('x', lowered.after, { publishMode: 'public' }),
    ).toThrow(PublishPolicyConfirmationRequired);
  });

  it('lowers the mode and clears the latch without confirmation', () => {
    expect(
      planPublishPolicyChange('x', live, { publishMode: 'dry_run' }).after
        .publishMode,
    ).toBe('dry_run');
    const cleared = planPublishPolicyChange('x', live, {
      publicPublishingAllowed: false,
    });
    expect(isEffectivelyPublic(cleared.after)).toBe(false);
    expect(cleared.changed).toBe(true);
  });

  it('rejects modes the platform does not support and empty changes', () => {
    expect(() =>
      planPublishPolicyChange('x', dry, {
        publishMode: 'private_or_scheduled',
      }),
    ).toThrow(PublishPolicyInvalid);
    expect(() => planPublishPolicyChange('x', dry, {})).toThrow(
      PublishPolicyInvalid,
    );
  });
});
