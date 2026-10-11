/** Kind registration and the tighten-only policy arithmetic. */

import { describe, expect, it } from 'vitest';
import {
  assertPolicyTightens,
  DEFAULT_APPROVAL_TTL_MS,
  defineApprovalKind,
  effectiveRules,
  getApprovalKind,
  requireApprovalKind,
  unregisterApprovalKind,
} from '../kinds.js';

const HOUR = 60 * 60 * 1000;

function kind(key: string, requiredApprovals = 2, ttlMs = 24 * HOUR) {
  return defineApprovalKind({
    key,
    subject: '@happyvertical/smrt-social:SocialPost',
    permission: 'social.approve-post',
    defaults: { requiredApprovals, ttlMs },
  });
}

describe('defineApprovalKind', () => {
  it('normalizes defaults and is idempotent for an identical definition', () => {
    const plain = defineApprovalKind({
      key: 'kinds-test.plain',
      subject: '@happyvertical/smrt-social:SocialPost',
      permission: 'social.approve-post',
    });
    expect(plain.defaults).toEqual({
      requiredApprovals: 1,
      ttlMs: DEFAULT_APPROVAL_TTL_MS,
    });
    expect(
      defineApprovalKind({
        key: 'kinds-test.plain',
        subject: '@happyvertical/smrt-social:SocialPost',
        permission: 'social.approve-post',
      }),
    ).toBe(plain);
    expect(getApprovalKind('kinds-test.plain')).toBe(plain);
    expect(Object.isFrozen(plain)).toBe(true);
  });

  it('refuses a conflicting redefinition', () => {
    kind('kinds-test.conflict');
    expect(() => kind('kinds-test.conflict', 3)).toThrow(
      expect.objectContaining({ code: 'APPROVAL_KIND_CONFLICT' }),
    );
  });

  it.each([
    [{ key: 'NoDots' }],
    [{ key: 'social' }],
    [{ subject: 'SocialPost' }],
    [{ subject: '@scope/pkg' }],
    [{ permission: 'approve' }],
    [{ permission: '' }],
    [{ defaults: { requiredApprovals: 0 } }],
    [{ defaults: { requiredApprovals: 1.5 } }],
    [{ defaults: { requiredApprovals: 26 } }],
    [{ defaults: { ttlMs: 1000 } }],
    [{ defaults: { ttlMs: Number.POSITIVE_INFINITY } }],
  ])('refuses malformed input %j', (override) => {
    expect(() =>
      defineApprovalKind({
        key: 'kinds-test.bad',
        subject: '@happyvertical/smrt-social:SocialPost',
        permission: 'social.approve-post',
        ...override,
      }),
    ).toThrow(expect.objectContaining({ code: 'APPROVAL_INVALID' }));
  });

  it('reports an unknown kind', () => {
    expect(() => requireApprovalKind('kinds-test.missing')).toThrow(
      expect.objectContaining({ code: 'APPROVAL_KIND_UNKNOWN' }),
    );
    kind('kinds-test.removed');
    expect(unregisterApprovalKind('kinds-test.removed')).toBe(true);
    expect(getApprovalKind('kinds-test.removed')).toBeUndefined();
  });
});

describe('tighten-only policy', () => {
  const base = kind('kinds-test.policy', 2, 24 * HOUR);

  it('accepts tightening and inheriting', () => {
    expect(() =>
      assertPolicyTightens(base, {
        requiredApprovals: 3,
        ttlMs: HOUR,
        requiredPermission: 'social.approve-legal',
      }),
    ).not.toThrow();
    expect(() => assertPolicyTightens(base, {})).not.toThrow();
    expect(() =>
      assertPolicyTightens(base, { requiredApprovals: 2, ttlMs: 24 * HOUR }),
    ).not.toThrow();
  });

  it('refuses loosening the quorum or the expiry', () => {
    expect(() => assertPolicyTightens(base, { requiredApprovals: 1 })).toThrow(
      expect.objectContaining({ code: 'APPROVAL_POLICY_LOOSENS' }),
    );
    expect(() => assertPolicyTightens(base, { ttlMs: 25 * HOUR })).toThrow(
      expect.objectContaining({ code: 'APPROVAL_POLICY_LOOSENS' }),
    );
    expect(() => assertPolicyTightens(base, { ttlMs: -1 })).toThrow(
      expect.objectContaining({ code: 'APPROVAL_INVALID' }),
    );
    expect(() =>
      assertPolicyTightens(base, { requiredPermission: 'Legal Team' }),
    ).toThrow(expect.objectContaining({ code: 'APPROVAL_INVALID' }));
  });

  it('clamps a stored row that would loosen the kind', () => {
    expect(
      effectiveRules(base, { requiredApprovals: 1, ttlMs: 48 * HOUR }),
    ).toEqual({
      requiredApprovals: 2,
      ttlMs: 24 * HOUR,
      requiredPermissions: ['social.approve-post'],
    });
    expect(
      effectiveRules(base, {
        requiredApprovals: 4,
        ttlMs: HOUR,
        requiredPermission: 'social.approve-legal',
      }),
    ).toEqual({
      requiredApprovals: 4,
      ttlMs: HOUR,
      requiredPermissions: ['social.approve-post', 'social.approve-legal'],
    });
    // A malformed stored slug stays required, so nobody can decide: closed.
    expect(
      effectiveRules(base, { requiredPermission: 'Legal Team' })
        .requiredPermissions,
    ).toContain('Legal Team');
  });
});
