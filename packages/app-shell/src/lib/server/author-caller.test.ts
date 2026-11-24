// `authorCaller` takes its tenant from the verified owner, never from the host
// (#5609): an owner of another tenant is refused by the host, not re-tenanted.
import { describe, expect, it } from 'vitest';
import type { AppDefinition } from '../../engine/index.ts';
import { appPermissionSlugs, OWNER_SLUG } from '../../engine/index.ts';
import { authorCaller, principalFor } from './owner.ts';

const def = {
  models: { Chore: { fields: { title: { type: 'text' } } } },
} as unknown as AppDefinition;

describe('authorCaller', () => {
  it("carries the owner's tenant, not a host's", () => {
    const p = authorCaller({ id: 'u1', tenantId: 'tenant-a' }, { def });
    expect(p.tenantId).toBe('tenant-a');
    expect(p.userId).toBe('u1');
    expect(p.kind).toBe('user');
    expect(p.permissions).toEqual(
      expect.arrayContaining([OWNER_SLUG, ...appPermissionSlugs(def)]),
    );
  });

  it('is the same principal principalFor builds', () => {
    const owner = { id: 'u1', tenantId: 'tenant-a' };
    expect(authorCaller(owner, { def })).toEqual(principalFor(owner, def));
  });
});
