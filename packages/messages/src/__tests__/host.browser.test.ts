import { describe, expect, it } from 'vitest';
import * as browserHost from '../host.browser.js';

describe('browser notification host boundary', () => {
  it('never creates, inherits or falls back to shared provider authority', () => {
    const first = browserHost.createHandoffContext<object>();
    const second = browserHost.createHandoffContext<object>();
    const scope = {};
    let invoked = false;
    expect(first.getStore()).toBeUndefined();
    expect(() =>
      first.run(scope, () => {
        invoked = true;
      }),
    ).toThrow('server host');
    expect(invoked).toBe(false);
    expect(first.getStore()).toBeUndefined();
    expect(second.getStore()).toBeUndefined();
  });
  it('refuses tenant workflows before invoking callbacks or choosing a tenant', () => {
    let called = false;
    const callback = async () => {
      called = true;
    };
    expect(() =>
      browserHost.withTenant({ tenantId: 'tenant' }, callback),
    ).toThrow('server host');
    expect(() => browserHost.withSystemContext(callback)).toThrow(
      'server host',
    );
    expect(() => browserHost.getCurrentTenant()).toThrow('server host');
    expect(() => browserHost.queryGlobal({} as never)).toThrow('server host');
    expect(() =>
      browserHost.queryWithGlobals({} as never, 'tenant', 'fixture'),
    ).toThrow('server host');
    expect(called).toBe(false);
  });
  it('refuses protected hashes, binding comparison and maintenance instead of weakening them', () => {
    for (const operation of [
      () => browserHost.notificationSha256('approved'),
      () => browserHost.createAccountSecretService({} as never),
      () => browserHost.normalizeIdentityEmail('approved@example.test'),
      () =>
        browserHost.readNotificationProfile({} as never, 'tenant', 'profile'),
      () => browserHost.canonicalNotificationMessageId('delivery'),
      () =>
        browserHost.isDeepStrictEqual({ approved: true }, { approved: true }),
      () => browserHost.assertNotificationMaintenanceHost(),
      () => browserHost.buildSqliteRebuildStatements({} as never),
    ])
      expect(operation).toThrow('server host');
  });
});
