import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GroupSharingPolicyV1 } from '../group-sharing-contracts.js';
import { evaluateGroupSharingPolicy } from '../group-sharing-policy.js';
import {
  groupSharingReadClasses,
  groupSharingReadContractTests,
  sharingPolicy,
} from './group-sharing-read-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
describe('Group sharing owned reader SQLite', () =>
  groupSharingReadContractTests(async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: groupSharingReadClasses,
    });
    return {
      db,
      cleanup: async () => {
        await db.close?.();
      },
    };
  }));
describe('Sharing policy facets', () => {
  it('rejects malformed runtime policy objects at the exported evaluator boundary', () => {
    const facts = {
      capturedAt: '2026-01-01T00:00:00.000Z',
      courseId: null,
      subject: null,
      parentReviewed: true,
    };
    for (const policy of [
      { ...sharingPolicy(), schemaVersion: 99 },
      { ...sharingPolicy(), historyFrom: 'not-a-date' },
      { ...sharingPolicy(), historyFrom: '2026-02-30T00:00:00.000Z' },
    ]) {
      expect(() =>
        evaluateGroupSharingPolicy(policy as GroupSharingPolicyV1, facts),
      ).toThrow();
    }
  });

  for (let mask = 0; mask < 16; mask++)
    it(`independent facet mask ${mask}`, () => {
      const policy = {
        ...sharingPolicy(),
        shareWork: Boolean(mask & 1),
        shareMedia: Boolean(mask & 2),
        shareFeedback: Boolean(mask & 4),
        shareProgress: Boolean(mask & 8),
      };
      const decision = evaluateGroupSharingPolicy(policy, {
        capturedAt: policy.historyFrom,
        courseId: null,
        subject: null,
        parentReviewed: false,
      });
      expect(decision).toMatchObject({
        eligible: true,
        work: policy.shareWork,
        media: policy.shareWork && policy.shareMedia,
        feedback: policy.shareFeedback,
        progress: policy.shareProgress,
      });
    });
  it('requires exact review, inclusive capture cutoff and known restricted metadata', () => {
    const policy = {
      ...sharingPolicy(),
      parentReviewedOnly: true,
      subjects: { mode: 'include' as const, values: ['math'] },
      courseIds: { mode: 'include' as const, values: ['course'] },
    };
    const facts = {
      capturedAt: policy.historyFrom,
      courseId: 'course',
      subject: 'math',
      parentReviewed: true,
    };
    expect(evaluateGroupSharingPolicy(policy, facts).eligible).toBe(true);
    for (const bad of [
      { ...facts, parentReviewed: false },
      { ...facts, courseId: null },
      { ...facts, subject: null },
      { ...facts, capturedAt: '1999-12-31T23:59:59.999Z' },
    ])
      expect(evaluateGroupSharingPolicy(policy, bad).eligible).toBe(false);
  });
});
