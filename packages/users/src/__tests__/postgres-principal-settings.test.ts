import { describe, expect, it } from 'vitest';
import { postgresPrincipalSettings } from '../postgres-settings.js';

describe('postgresPrincipalSettings', () => {
  it('returns the six smrt.* settings in a fixed order', () => {
    expect(
      postgresPrincipalSettings({
        tenantId: 't1',
        userId: 'u1',
        session: { id: 's' },
        sessionId: 's',
        permissions: ['a.list'],
        superAdminBypass: false,
        systemContext: true,
      }),
    ).toEqual([
      ['smrt.tenant_id', 't1'],
      ['smrt.user_id', 'u1'],
      ['smrt.session_id', 's'],
      ['smrt.permissions', '["a.list"]'],
      ['smrt.super_admin_bypass', 'false'],
      ['smrt.system_context', 'true'],
    ]);
  });

  it('fails closed on missing values', () => {
    const out = postgresPrincipalSettings({
      tenantId: null,
      userId: null,
      session: null,
      sessionId: 'unverified',
      permissions: [],
      superAdminBypass: false,
      systemContext: false,
    });
    expect(out[0][1]).toBe('');
    expect(out[2][1]).toBe('');
  });
});
