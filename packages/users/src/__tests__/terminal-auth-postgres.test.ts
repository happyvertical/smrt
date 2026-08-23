import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { UsersCliAuthRequestCollection } from '../collections/CliAuthRequestCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { TerminalAuthService } from '../services/TerminalAuthService.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('TerminalAuthService on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('uses UUID references and permits exactly one concurrent token exchange', async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['User', 'Tenant', 'Session', 'UsersCliAuthRequest'],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database.');
    }
    const options = { db: isolated.config };
    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const requests = await UsersCliAuthRequestCollection.create(options);
    const sessions = await SessionCollection.create(options);
    const service = await TerminalAuthService.create({
      ...options,
      requestTtlSeconds: 60,
      sessionTtlSeconds: 3600,
    });

    const user = await users.create({ email: 'terminal-postgres@example.com' });
    await user.save();
    const tenant = await tenants.create({ name: 'Terminal PostgreSQL' });
    await tenant.save();
    const userId = user.id;
    const tenantId = tenant.id;
    if (!userId || !tenantId) {
      throw new Error('Expected persisted terminal user and tenant.');
    }
    const started = await service.createRequest('https://example.com');
    const approvals = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.approveRequest({
          userCode: started.userCode,
          user: { id: userId, email: user.email },
          tenantId,
        }),
      ),
    );
    expect(new Set(approvals.map((approval) => approval.sessionId))).toEqual(
      new Set([approvals[0]?.sessionId]),
    );
    expect(await sessions.findByUser(userId)).toHaveLength(1);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.exchangeDeviceCode(started.deviceCode),
      ),
    );
    expect(
      results.filter((result) => result.status === 'approved'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'expired'),
    ).toHaveLength(7);
    const stored = await requests.findByUserCode(started.userCode);
    expect(stored?.userId).toBe(userId);
    expect(stored?.tenantId).toBe(tenantId);
    expect(stored?.status).toBe('consumed');
    expect(stored?.sessionId).toBeNull();
  });
});
