/**
 * PasskeyCredentialService on PostgreSQL (#3275): native UUID references, the
 * unique credential-id and challenge-hash arbiters, the guarded counter
 * UPDATE, raw-id session sweeps, session data round-tripping the passkey row
 * id, the lockout-enabled limiter path, tenant confinement of administration,
 * and challenge retention.
 */

import { randomUUID } from 'node:crypto';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { UsersPasskeyChallengeCollection } from '../collections/PasskeyChallengeCollection.js';
import { UsersPasskeyCredentialCollection } from '../collections/PasskeyCredentialCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { LoginRateLimitError } from '../services/LoginAttemptLimiter.js';
import {
  DEFAULT_PASSKEY_MANAGE_PERMISSION,
  PasskeyCredentialError,
  PasskeyCredentialForbiddenError,
  PasskeyCredentialService,
} from '../services/PasskeyCredentialService.js';
import {
  type SessionContext,
  SessionService,
} from '../services/SessionService.js';
import { SoftAuthenticator } from './helpers/soft-authenticator.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

const ORIGIN = 'https://office.example';
const RP_ID = 'office.example';

describePostgres('PasskeyCredentialService on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('registers, signs in, replays, removes, and confines administration', async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'User',
        'Tenant',
        'Role',
        'Permission',
        'RolePermission',
        'Membership',
        'MembershipOverride',
        'TenantPermissionOverride',
        'Group',
        'GroupMember',
        'GroupRole',
        'Session',
        'UsersPasskeyCredential',
        'UsersPasskeyChallenge',
        'UsersLoginAttempt',
        'UsersLoginAuditEvent',
      ],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database.');
    }
    const options = { db: isolated.db };
    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const memberships = await MembershipCollection.create(options);
    const passkeys = await UsersPasskeyCredentialCollection.create(options);
    const challenges = await UsersPasskeyChallengeCollection.create(options);
    const sessions = await SessionCollection.create(options);
    const sessionService = await SessionService.create(options);

    const tenantIds: string[] = [];
    for (const name of ['Office', 'Elsewhere']) {
      const tenant = await tenants.create({ id: randomUUID(), name });
      await tenant.save();
      tenantIds.push(tenant.id as string);
    }
    const [tenantId, otherTenantId] = tenantIds as [string, string];
    const role = await roles.create({ id: randomUUID(), name: 'Staff' });
    await role.save();

    const ids = {
      person: randomUUID(),
      admin: randomUUID(),
      outsider: randomUUID(),
    };
    for (const [name, id] of Object.entries(ids)) {
      const user = await users.create({ id, email: `${name}@office.example` });
      await user.save();
      const membership = await memberships.create({
        id: randomUUID(),
        userId: id,
        tenantId: name === 'outsider' ? otherTenantId : tenantId,
        roleId: role.id as string,
      });
      await membership.save();
    }
    const actorFor = async (
      userId: string,
      permissions: string[] = [],
      tenant = tenantId,
    ): Promise<SessionContext> => {
      const sessionId = await sessionService.createSession(userId, tenant, {
        authMethod: 'oidc',
      });
      const context = await sessionService.loadSessionContext(sessionId);
      if (!context) throw new Error('missing session');
      return { ...context, permissions };
    };

    const service = await PasskeyCredentialService.create({
      ...options,
      relyingParty: { origin: ORIGIN, rpName: 'Office' },
      challengeSecret: 'postgres-test-secret-with-32-or-more-chars',
      limiter: { maxAttempts: 4, windowSeconds: 60 },
    });
    const newAuthenticator = () =>
      new SoftAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    const register = async (
      authenticator: SoftAuthenticator,
      actor: SessionContext,
      name = 'Laptop',
    ) => {
      const begun = await service.beginRegistration({ actor });
      return service.finishRegistration({
        actor,
        ceremonyId: begun.ceremonyId,
        response: authenticator.register(begun.options),
        name,
      });
    };
    const signIn = async (
      authenticator: SoftAuthenticator,
      ipAddress: string,
      assertion?: Parameters<SoftAuthenticator['assert']>[1],
    ) => {
      const begun = await service.beginAuthentication();
      return service.finishAuthentication({
        ceremonyId: begun.ceremonyId,
        response: authenticator.assert(begun.options, assertion),
        tenantId,
        ipAddress,
      });
    };

    // Register and sign in: native UUID references end to end.
    const laptop = newAuthenticator();
    const { passkey } = await register(laptop, await actorFor(ids.person));
    expect(passkey.id).toMatch(/^[0-9a-f-]{36}$/u);
    const first = await signIn(laptop, '10.1.0.1');
    expect(first).toMatchObject({ userId: ids.person, tenantId });
    const stored = await passkeys.findByCredentialId(laptop.id);
    expect(stored?.signCount).toBe(1);
    expect(stored?.lastUsedAt).toBeInstanceOf(Date);
    // Session data round-trips the passkey row id through the JSON column.
    const minted = await sessions.findValidSession(first.sessionId);
    expect(minted?.getData('passkeyCredentialId')).toBe(passkey.id);

    // The guarded counter UPDATE is a no-op on a superseded counter or a
    // removed row, and exact otherwise.
    expect(
      await passkeys.recordUseIfCurrent(passkey.id, ids.person, 0, 7, false),
    ).toBe(false);
    expect(
      await passkeys.recordUseIfCurrent(randomUUID(), ids.person, 1, 7, false),
    ).toBe(false);
    expect(
      await passkeys.recordUseIfCurrent(passkey.id, ids.person, 1, 7, true),
    ).toBe(true);
    expect((await passkeys.findByCredentialId(laptop.id))?.signCount).toBe(7);
    expect((await passkeys.findByCredentialId(laptop.id))?.backedUp).toBe(true);
    laptop.counter = 7;

    // A ceremony is single use, under real concurrency.
    const begun = await service.beginAuthentication();
    const attempts = await Promise.allSettled(
      [1, 2, 3].map((n) =>
        service.finishAuthentication({
          ceremonyId: begun.ceremonyId,
          response: laptop.assert(begun.options, { counter: 100 + n }),
          tenantId,
          ipAddress: `10.9.0.${n}`,
        }),
      ),
    );
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    for (const loser of attempts.filter((a) => a.status === 'rejected')) {
      expect(loser.reason).toBeInstanceOf(PasskeyCredentialError);
    }
    expect(
      await challenges.consume(
        'already-used',
        'authentication',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(true);
    expect(
      await challenges.consume(
        'already-used',
        'authentication',
        new Date(Date.now() + 60_000),
      ),
    ).toBe(false);

    // Self removal: another person's passkey is forbidden, one's own ends the
    // passkey sessions (raw-id sweep) and keeps the actor's session.
    const phone = newAuthenticator();
    const actor = await actorFor(ids.person);
    const { passkey: phoneKey } = await register(phone, actor, 'Phone');
    const phoneSession = await signIn(phone, '10.4.0.1');
    const removed = await service.removePasskey({
      actor,
      passkeyId: phoneKey.id,
    });
    expect(removed.endedCurrentSession).toBe(false);
    expect(removed.revokedSessions).toBeGreaterThanOrEqual(1);
    expect(await sessions.findValidSession(phoneSession.sessionId)).toBeNull();
    expect(await sessions.findValidSession(actor.sessionId)).not.toBeNull();
    await expect(
      service.removePasskey({
        actor: await actorFor(ids.admin),
        passkeyId: passkey.id,
      }),
    ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);

    // Administration stops at the admin's tenant, and rejects non-UUIDs.
    const admin = await actorFor(ids.admin, [
      DEFAULT_PASSKEY_MANAGE_PERMISSION,
    ]);
    const away = await register(
      newAuthenticator(),
      await actorFor(ids.outsider, [], otherTenantId),
      'Away',
    );
    await expect(
      service.removePasskey({ actor: admin, passkeyId: away.passkey.id }),
    ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
    await expect(
      service.listPasskeys({ actor: admin, userId: 'not-a-uuid' }),
    ).rejects.toBeInstanceOf(PasskeyCredentialForbiddenError);
    expect(
      (await service.listPasskeys({ actor: admin, userId: ids.person })).map(
        (p) => p.name,
      ),
    ).toEqual(['Laptop']);
    const cleared = await service.removeAllPasskeys({
      actor: admin,
      userId: ids.person,
    });
    expect(cleared.removed).toBe(1);
    expect(await passkeys.countByUserId(ids.person)).toBe(0);

    // Retention reaps the expired ledger rows and only those.
    const ledger = await challenges.list({ limit: 50 });
    expect(ledger.length).toBeGreaterThan(1);
    await challenges.consume(
      'long-gone',
      'registration',
      new Date(Date.now() - 60_000),
    );
    expect(await challenges.deleteExpired({ dryRun: true })).toBe(1);
    expect(await challenges.deleteExpired()).toBe(1);
    expect((await challenges.list({ limit: 50 })).length).toBe(ledger.length);

    // Unknown and wrong are the same failure, then the source locks out.
    for (let index = 0; index < 4; index++) {
      await expect(
        signIn(newAuthenticator(), '10.7.0.1'),
      ).rejects.toBeInstanceOf(PasskeyCredentialError);
    }
    await expect(signIn(newAuthenticator(), '10.7.0.1')).rejects.toBeInstanceOf(
      LoginRateLimitError,
    );
  });
});
