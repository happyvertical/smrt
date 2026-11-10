import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalGroupSharingPolicy,
  type GroupSharingPolicyV1,
  validateGroupSharingPolicy,
} from '../group-sharing-contracts.js';
import {
  EducationGroup,
  EducationGroupCollection,
  GroupLearnerInvitation,
  GroupLearnerMembership,
  GroupRevisionComment,
  GroupSharingPolicy,
} from '../group-sharing-models.js';

const policy: GroupSharingPolicyV1 = {
  schemaVersion: 1,
  shareWork: true,
  shareMedia: false,
  shareFeedback: false,
  shareProgress: true,
  parentReviewedOnly: true,
  commentVisibility: 'parent-only',
  historyFrom: '2026-01-01T00:00:00.000Z',
  subjects: { mode: 'include', values: ['science', 'math'] },
  courseIds: { mode: 'all' },
};
beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
describe('closed group sharing persistence contracts', () => {
  it('closes every generated CRUD and AI surface with explicit uniqueness keys', () => {
    for (const name of [
      'EducationGroup',
      'GroupLearnerInvitation',
      'GroupLearnerMembership',
      'GroupSharingPolicy',
      'GroupRevisionComment',
      'GroupLearnerRosterEntry',
    ]) {
      const config = ObjectRegistry.getConfig(name);
      expect(config.api).toBe(false);
      expect(config.mcp).toBe(false);
      expect(config.cli).toBe(false);
      expect(config.ai?.callable).toEqual([]);
    }
    expect(ObjectRegistry.getConfig('EducationGroup').conflictColumns).toEqual([
      'tenant_id',
    ]);
    expect(
      ObjectRegistry.getConfig('GroupLearnerMembership').conflictColumns,
    ).toEqual(['tenant_id', 'learner_id', 'group_id']);
    expect(
      ObjectRegistry.getConfig('GroupLearnerRosterEntry').conflictColumns,
    ).toEqual(['tenant_id', 'group_id', 'membership_id']);
    expect(
      ObjectRegistry.getConfig('GroupSharingPolicy').conflictColumns,
    ).toEqual(['tenant_id', 'membership_id', 'version']);
  });
  it('generates native UUID references and required tenant columns', () => {
    const invitation = ObjectRegistry.getSchema('GroupLearnerInvitation');
    const membership = ObjectRegistry.getSchema('GroupLearnerMembership');
    const roster = ObjectRegistry.getSchema('GroupLearnerRosterEntry');
    expect(invitation?.columns.family_tenant_id.type).toBe('UUID');
    expect(invitation?.columns.learner_id.type).toBe('UUID');
    expect(invitation?.columns.tenant_id.notNull).toBe(true);
    expect(membership?.columns.learner_id.type).toBe('UUID');
    expect(membership?.columns.group_id.foreignKey?.onDelete).toBe('RESTRICT');
    expect(roster?.columns.membership_id.type).toBe('UUID');
  });
  it('accepts explicit empty selectors as selecting nothing and canonicalizes set order', () => {
    expect(() =>
      validateGroupSharingPolicy({
        ...policy,
        subjects: { mode: 'include', values: [] },
      }),
    ).not.toThrow();
    expect(canonicalGroupSharingPolicy(policy)).toBe(
      canonicalGroupSharingPolicy({
        ...policy,
        subjects: { mode: 'include', values: ['math', 'science'] },
      }),
    );
    expect(
      JSON.parse(canonicalGroupSharingPolicy(policy)).subjects.values,
    ).toEqual(['math', 'science']);
  });
  it.each([
    undefined,
    {},
    { ...policy, schemaVersion: 2 },
    { ...policy, unexpected: true },
    { ...policy, shareWork: 'true' },
    { ...policy, commentVisibility: undefined },
    { ...policy, commentVisibility: 'public' },
    { ...policy, historyFrom: '2026-02-30T00:00:00.000Z' },
    { ...policy, historyFrom: '2026-01-01' },
    { ...policy, subjects: { mode: 'all', values: [] } },
    { ...policy, subjects: { mode: 'include', values: ['math', 'math'] } },
    { ...policy, courseIds: { mode: 'include', values: [null] } },
  ])('rejects malformed/unknown policy input %j', (value) => {
    expect(() => validateGroupSharingPolicy(value)).toThrow();
  });
  it('guards policy JSON both entering and leaving persistence', () => {
    const snapshot = new GroupSharingPolicy();
    snapshot.setPolicy(policy);
    const read = snapshot.getPolicy();
    read.shareWork = false;
    expect(snapshot.getPolicy().shareWork).toBe(true);
    expect(() =>
      snapshot.setPolicy({ ...policy, shareFeedback: undefined }),
    ).toThrow();
    snapshot.policyJson = '{';
    expect(() => snapshot.getPolicy()).toThrow();
    snapshot.policyJson = '{"schemaVersion":99}';
    expect(() => snapshot.getPolicy()).toThrow();
  });
  it('rejects unknown state/version and missing scope before persistence', async () => {
    await expect(
      new EducationGroup({
        name: 'Group',
        creatorUserId: 'u',
        creatorProfileId: 'p',
      }).save(),
    ).rejects.toThrow('exact identity');
    await expect(
      new GroupLearnerMembership({
        groupId: 'g',
        learnerId: 'l',
        consentParentUserId: 'p',
        policyVersion: 0,
      }).save(),
    ).rejects.toThrow('version');
    await expect(
      new GroupLearnerInvitation({
        groupId: 'g',
        familyTenantId: 'f',
        learnerId: 'l',
        invitedParentUserId: 'p',
        creatorUserId: 'u',
        status: 'unknown',
        expiresAt: new Date('2027-01-01'),
      }).save(),
    ).rejects.toThrow('invitation');
    const comment = new GroupRevisionComment({
      membershipId: 'm',
      learnerId: 'l',
      activityId: 'a',
      attemptId: 't',
      revisionId: 'r',
      authorUserId: 'u',
      authorProfileId: 'p',
      body: 'hello',
      childVisible: true,
    });
    await expect(comment.save()).rejects.toThrow('visibility');
    await expect(
      new GroupSharingPolicy({
        membershipId: 'm',
        actorUserId: 'u',
        version: 0,
      }).save(),
    ).rejects.toThrow('version');
  });
  it('persists one group per tenant and refuses rebinding its creator', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['EducationGroup'],
    });
    try {
      const tenant = '11111111-1111-4111-8111-111111111111';
      await withTenant({ tenantId: tenant, userId: 'u' }, async () => {
        const groups = await EducationGroupCollection.create({ db });
        const group = await groups.create({
          tenantId: tenant,
          name: 'Group',
          creatorUserId: '22222222-2222-4222-8222-222222222222',
          creatorProfileId: '33333333-3333-4333-8333-333333333333',
          _insertOnly: true,
        });
        group.creatorUserId = '44444444-4444-4444-8444-444444444444';
        await expect(group.save()).rejects.toThrow('immutable');
        await expect(
          groups.create({
            tenantId: tenant,
            name: 'Duplicate',
            creatorUserId: '22222222-2222-4222-8222-222222222222',
            creatorProfileId: '33333333-3333-4333-8333-333333333333',
            _insertOnly: true,
          }),
        ).rejects.toThrow();
      });
    } finally {
      await db.close?.();
    }
  });
  it('rejects an explicit stale revision even when the group instance was freshly loaded', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['EducationGroup'],
    });
    try {
      const tenantId = '11111111-1111-4111-8111-111111111111';
      await withTenant({ tenantId, userId: 'u' }, async () => {
        const groups = await EducationGroupCollection.create({ db });
        const original = await groups.create({
          tenantId,
          name: 'Original',
          creatorUserId: '22222222-2222-4222-8222-222222222222',
          creatorProfileId: '33333333-3333-4333-8333-333333333333',
        });
        const expectedUpdatedAt = original.updated_at;
        if (!expectedUpdatedAt)
          throw new Error('Missing persisted group revision');
        original.name = 'Committed winner';
        await original.save({ expectedUpdatedAt });
        const fresh = await groups.get(String(original.id), { cache: false });
        if (!fresh?.updated_at) throw new Error('Missing current group');
        expect(fresh.updated_at.getTime()).toBeGreaterThan(
          expectedUpdatedAt.getTime(),
        );
        fresh.name = 'Stale caller overwrite';
        await expect(fresh.save({ expectedUpdatedAt })).rejects.toMatchObject({
          code: 'RUNTIME_REVISION_CONFLICT',
        });
        expect(
          (await groups.get(String(original.id), { cache: false }))?.name,
        ).toBe('Committed winner');
      });
    } finally {
      await db.close?.();
    }
  });
});
