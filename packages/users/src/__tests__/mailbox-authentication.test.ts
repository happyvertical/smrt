import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  backfillProfileEmailKeys,
  ProfileCollection,
} from '@happyvertical/smrt-profiles';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { backfillUserEmailKeys } from '../migrations/backfillUserEmailKeys.js';
import { LoginAttemptLimiter } from '../services/LoginAttemptLimiter.js';
import {
  type MailboxAuthenticationDelivery,
  MailboxAuthenticationService,
} from '../services/MailboxAuthenticationService.js';
import {
  type PreparedTenantInvitation,
  TenantInvitationService,
} from '../services/TenantInvitationService.js';
import { MembershipStatus, UserStatus } from '../types/index.js';

const secret = 'test-independent-mailbox-authentication-secret';
type Mail = Parameters<MailboxAuthenticationDelivery>[0];
describe('independently delivered mailbox authentication', () => {
  let db: DatabaseInterface;
  let admin: DatabaseInterface | undefined;
  let schema: string | undefined;
  let tenantId: string;
  let limiter: LoginAttemptLimiter;
  let first: PreparedTenantInvitation;
  const sourceKey = 'test-client-address';
  beforeEach(async () => {
    if (process.env.TEST_DB_ADAPTER === 'postgres') {
      if (!process.env.DATABASE_URL)
        throw new Error('Explicit isolated DATABASE_URL is required');
      admin = await getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL,
        dbid: randomUUID(),
      });
      schema = `mailbox_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(process.env.DATABASE_URL);
      url.searchParams.set('options', `-c search_path=${schema},public`);
      db = await getDatabase({
        type: 'postgres',
        url: url.toString(),
        dbid: randomUUID(),
      });
      await getTestDatabase({ db });
    } else db = await getTestDatabase();
    const tenants = await TenantCollection.create({ db });
    await UserCollection.create({ db });
    await MembershipCollection.create({ db });
    await ProfileCollection.create({ db });
    await (await RoleCollection.create({ db })).seedSystemRoles({
      seedPermissions: false,
    });
    tenantId = (
      await tenants.create({ name: 'Mailbox client', slug: randomUUID() })
    ).id as string;
    await backfillProfileEmailKeys(db);
    await backfillUserEmailKeys(db);
    limiter = await LoginAttemptLimiter.create({
      db,
      keyPepper: secret,
      audit: false,
    });
    first = await tx((service) =>
      service.prepare({
        tenantId,
        email: 'Client@Example.com',
        roleSlug: 'viewer',
      }),
    );
  });
  afterEach(async () => {
    vi.useRealTimers();
    await db.close?.();
    if (admin && schema)
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.close?.();
    admin = undefined;
    schema = undefined;
  });
  async function tx<T>(fn: (service: TenantInvitationService) => Promise<T>) {
    return db.transaction(async (executor) =>
      fn(
        await TenantInvitationService.create({
          db: executor,
          transaction: 'caller',
          secret,
          loginLimiter: limiter,
        }),
      ),
    );
  }
  async function generic<T>(
    fn: (service: MailboxAuthenticationService) => Promise<T>,
  ) {
    return db.transaction(async (executor) =>
      fn(
        await MailboxAuthenticationService.create({
          db: executor,
          transaction: 'caller',
          secret,
          loginLimiter: limiter,
        }),
      ),
    );
  }
  async function request(grant: string, membershipId = first.membershipId) {
    const mails: Mail[] = [];
    const response = await tx((service) =>
      service.requestMailboxAuthentication({
        membershipId,
        token: grant,
        sourceKey,
        deliver: async (mail) => {
          mails.push(mail);
        },
      }),
    );
    if (!mails[0]) throw new Error('Missing captured mail');
    return { mail: mails[0], response };
  }
  async function grant() {
    return (
      await tx((service) => service.issue({ membershipId: first.membershipId }))
    ).token;
  }
  async function complete(
    invitationToken: string,
    token: string,
    extra: { sessionId?: string; expectedUserId?: string } = {},
  ) {
    return tx((service) =>
      service.authenticateMailbox({
        membershipId: first.membershipId,
        invitationToken,
        token,
        ...extra,
      }),
    );
  }
  async function active() {
    const users = await UserCollection.create({ db });
    const user = await users.get({ id: first.userId });
    if (!user) throw new Error('Missing user');
    user.status = UserStatus.ACTIVE;
    await user.save();
    const members = await MembershipCollection.create({ db });
    const member = await members.get({ id: first.membershipId });
    if (!member) throw new Error('Missing membership');
    member.status = MembershipStatus.ACTIVE;
    await member.save();
  }
  async function status() {
    return (
      await (
        await UserCollection.create({ db })
      ).get({ id: first.userId }, { cache: false })
    )?.status;
  }

  it.each([
    'returning',
    'invitation',
  ] as const)('%s request without an independent limiter refuses before writes or delivery', async (flow) => {
    await active();
    const invitationToken = await grant();
    const deliver = vi.fn(async (_mail: Mail) => {});
    const beforeTokens = (
      await db.query('SELECT nonce FROM users_magic_link_tokens')
    ).rows;
    await expect(
      db.transaction(async (executor) => {
        const options = {
          db: executor,
          transaction: 'caller' as const,
          secret,
        };
        if (flow === 'returning') {
          return (await MailboxAuthenticationService.create(options)).request({
            email: 'client@example.com',
            sourceKey,
            deliver,
          });
        }
        return (
          await TenantInvitationService.create(options)
        ).requestMailboxAuthentication({
          membershipId: first.membershipId,
          token: invitationToken,
          sourceKey,
          deliver,
        });
      }),
    ).rejects.toThrow('independently supplied root-executor login limiter');
    expect(deliver).not.toHaveBeenCalled();
    expect(
      (await db.query('SELECT nonce FROM users_magic_link_tokens')).rows,
    ).toEqual(beforeTokens);
    expect(
      (await db.query('SELECT limiter_key FROM users_login_attempts')).rows,
    ).toHaveLength(0);
    const { mail } = await request(invitationToken);
    await complete(invitationToken, mail.token);
  });

  it('delivers only to canonical mailbox, returns no proof, and copied operator grant cannot authenticate', async () => {
    const invitationToken = await grant();
    const { mail, response } = await request(invitationToken);
    expect(Object.keys(response)).toEqual(['expiresAt']);
    expect(mail.email).toBe('client@example.com');
    expect(mail.token).not.toBe(invitationToken);
    expect(await status()).toBe(UserStatus.PENDING);
    await expect(
      complete(invitationToken, invitationToken),
    ).rejects.toMatchObject({ name: 'MagicLinkError' });
    expect(await complete(invitationToken, mail.token)).toMatchObject({
      ...first,
      status: 'active',
      tenantId,
    });
    expect((await db.query('SELECT id FROM sessions')).rows).toHaveLength(0);
    await expect(complete(invitationToken, mail.token)).rejects.toMatchObject({
      name: 'MagicLinkError',
    });
  });
  it('does not burn grant on delivery failure; retries deliver a fresh one-use proof', async () => {
    const invitationToken = await grant();
    await expect(
      tx((service) =>
        service.requestMailboxAuthentication({
          membershipId: first.membershipId,
          token: invitationToken,
          sourceKey,
          deliver: async () => {
            throw new Error('transport unavailable');
          },
        }),
      ),
    ).rejects.toThrow('transport unavailable');
    const { mail } = await request(invitationToken);
    expect(await status()).toBe(UserStatus.PENDING);
    await complete(invitationToken, mail.token);
  });
  it('binds mailed proof to the exact grant, membership and identity; refusals do not consume it', async () => {
    const invitationToken = await grant();
    const otherGrant = await grant();
    const { mail } = await request(invitationToken);
    await expect(complete(otherGrant, mail.token)).rejects.toMatchObject({
      name: 'MagicLinkError',
    });
    await expect(
      complete(invitationToken, mail.token, { expectedUserId: randomUUID() }),
    ).rejects.toMatchObject({ name: 'TenantInvitationError' });
    const other = await tx((service) =>
      service.prepare({
        tenantId,
        email: 'other@example.com',
        roleSlug: 'viewer',
      }),
    );
    await expect(
      tx((service) =>
        service.authenticateMailbox({
          membershipId: other.membershipId,
          invitationToken,
          token: mail.token,
        }),
      ),
    ).rejects.toMatchObject({ name: 'MagicLinkError' });
    await complete(invitationToken, mail.token);
  });
  it('allows only one completion across multiple independently mailed proofs for one grant', async () => {
    const invitationToken = await grant();
    const a = await request(invitationToken);
    const b = await request(invitationToken);
    await complete(invitationToken, a.mail.token);
    await expect(complete(invitationToken, b.mail.token)).rejects.toMatchObject(
      { name: 'MagicLinkError' },
    );
  });
  it('expires mailbox proof independently; same unburned grant can request again', async () => {
    const invitationToken = await grant();
    const { mail } = await request(invitationToken);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 601000);
    await expect(complete(invitationToken, mail.token)).rejects.toMatchObject({
      name: 'MagicLinkError',
    });
    vi.useRealTimers();
    const next = await request(invitationToken);
    await complete(invitationToken, next.mail.token);
  });
  it('rolls back both proof claims and pending activation with caller failure', async () => {
    const invitationToken = await grant();
    const { mail } = await request(invitationToken);
    await expect(
      tx(async (service) => {
        await service.authenticateMailbox({
          membershipId: first.membershipId,
          invitationToken,
          token: mail.token,
        });
        throw new Error('host rollback');
      }),
    ).rejects.toThrow('host rollback');
    expect(await status()).toBe(UserStatus.PENDING);
    await complete(invitationToken, mail.token);
  });
  it('refuses suspended invitee and changed role binding before activating', async () => {
    const invitationToken = await grant();
    const { mail } = await request(invitationToken);
    const users = await UserCollection.create({ db });
    const user = await users.get({ id: first.userId });
    if (!user) throw new Error('Missing user');
    user.status = UserStatus.SUSPENDED;
    await user.save();
    await expect(complete(invitationToken, mail.token)).rejects.toMatchObject({
      name: 'TenantInvitationError',
    });
    user.status = UserStatus.PENDING;
    await user.save();
    const members = await MembershipCollection.create({ db });
    const member = await members.get({ id: first.membershipId });
    if (!member) throw new Error('Missing membership');
    const role = await (
      await RoleCollection.create({ db })
    ).findSystemRoleBySlug('admin');
    member.roleId = role?.id as string;
    await member.save();
    await expect(complete(invitationToken, mail.token)).rejects.toMatchObject({
      name: 'MagicLinkError',
    });
  });
  it('does not let issuer use copied grant to impersonate existing global account', async () => {
    await active();
    const invitationToken = await grant();
    const { mail } = await request(invitationToken);
    const issuer = await tx((service) =>
      service.prepare({
        tenantId,
        email: 'issuer@example.com',
        roleSlug: 'viewer',
      }),
    );
    await expect(
      complete(invitationToken, mail.token, { expectedUserId: issuer.userId }),
    ).rejects.toMatchObject({ name: 'TenantInvitationError' });
    await expect(
      complete(invitationToken, invitationToken),
    ).rejects.toMatchObject({ name: 'MagicLinkError' });
    await complete(invitationToken, mail.token);
  });
  it.each([
    'pin',
    'terminal',
    'unknown',
  ])('does not replace a %s session with a global mailbox session', async (authMethod) => {
    await active();
    const session = await (
      await SessionCollection.create({ db })
    ).createSession({ userId: first.userId, authMethod });
    const invitationToken = await grant();
    const { mail } = await request(invitationToken);
    await expect(
      complete(invitationToken, mail.token, {
        sessionId: session.id as string,
      }),
    ).rejects.toMatchObject({ name: 'MagicLinkError' });
    await complete(invitationToken, mail.token);
  });
  it('returning login uniformly handles unknown/pending/inactive accounts; only mailed proof authenticates active canonical member', async () => {
    const mails: Mail[] = [];
    const deliver: MailboxAuthenticationDelivery = async (mail) => {
      mails.push(mail);
    };
    for (const email of [
      'unknown@example.com',
      'client@example.com',
      'invalid',
    ])
      expect(
        await generic((service) =>
          service.request({ email, sourceKey, deliver }),
        ),
      ).toEqual({ requested: true });
    expect(mails).toHaveLength(0);
    await active();
    expect(
      await generic((service) =>
        service.request({ email: ' Client@Example.com ', sourceKey, deliver }),
      ),
    ).toEqual({ requested: true });
    expect(mails).toHaveLength(1);
    const mail = mails[0];
    if (!mail) throw new Error('Missing mail');
    expect(mail.email).toBe('client@example.com');
    await expect(
      generic((service) =>
        service.authenticate({
          token: mail.token,
          expectedUserId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ name: 'MagicLinkError' });
    expect(
      await generic((service) => service.authenticate({ token: mail.token })),
    ).toEqual({ userId: first.userId, profileId: first.profileId, tenantId });
    await expect(
      generic((service) => service.authenticate({ token: mail.token })),
    ).rejects.toMatchObject({ name: 'MagicLinkError' });
  });
  it('returning login rechecks active membership and suspension, rolls back nonce consumption', async () => {
    await active();
    const mails: Mail[] = [];
    await generic((service) =>
      service.request({
        email: 'client@example.com',
        sourceKey,
        deliver: async (mail) => {
          mails.push(mail);
        },
      }),
    );
    const mail = mails[0];
    if (!mail) throw new Error('Missing mail');
    const members = await MembershipCollection.create({ db });
    const member = await members.get({ id: first.membershipId });
    if (!member) throw new Error('Missing member');
    member.status = MembershipStatus.INACTIVE;
    await member.save();
    await expect(
      generic((service) => service.authenticate({ token: mail.token })),
    ).rejects.toMatchObject({ name: 'MagicLinkError' });
    member.status = MembershipStatus.ACTIVE;
    await member.save();
    await expect(
      generic(async (service) => {
        await service.authenticate({ token: mail.token });
        throw new Error('returning rollback');
      }),
    ).rejects.toThrow('returning rollback');
    expect(
      await generic((service) => service.authenticate({ token: mail.token })),
    ).toMatchObject({ userId: first.userId });
  });
  it('rate limits each send request even when valid; unknown requests share the same budget semantics and store no raw source', async () => {
    await active();
    const deliver = async () => {};
    for (let i = 0; i < 5; i++)
      await generic((service) =>
        service.request({ email: 'client@example.com', sourceKey, deliver }),
      );
    await expect(
      generic((service) =>
        service.request({ email: 'unknown@example.com', sourceKey, deliver }),
      ),
    ).rejects.toMatchObject({ name: 'LoginRateLimitError' });
    const rows = (
      await db.query('SELECT limiter_key FROM users_login_attempts')
    ).rows;
    expect(JSON.stringify(rows)).not.toContain(sourceKey);
    expect(JSON.stringify(rows)).not.toContain('client@example.com');
  });
  it('preserves existing session ceilings and parent authority for both mailbox flows', async () => {
    await active();
    const sessions = await SessionCollection.create({ db });
    const parent = await sessions.createSession({
      userId: first.userId,
      authMethod: 'oidc',
    });
    const child = await sessions.createSession({
      userId: first.userId,
      authMethod: 'oidc',
      parentSessionId: parent.id as string,
    });
    const ceiling = await sessions.createSession({
      userId: first.userId,
      authMethod: 'oidc',
      data: { permissionCeiling: [] },
    });
    const invitationToken = await grant();
    const { mail } = await request(invitationToken);
    const mails: Mail[] = [];
    await generic((service) =>
      service.request({
        email: 'client@example.com',
        sourceKey,
        deliver: async (value) => {
          mails.push(value);
        },
      }),
    );
    const normal = mails[0];
    if (!normal) throw new Error('Missing mail');
    for (const session of [child, ceiling]) {
      await expect(
        complete(invitationToken, mail.token, {
          sessionId: session.id as string,
        }),
      ).rejects.toMatchObject({ name: 'MagicLinkError' });
      await expect(
        generic((service) =>
          service.authenticate({
            token: normal.token,
            sessionId: session.id as string,
          }),
        ),
      ).rejects.toMatchObject({ name: 'MagicLinkError' });
    }
    await complete(invitationToken, mail.token, {
      sessionId: parent.id as string,
    });
    await generic((service) =>
      service.authenticate({
        token: normal.token,
        sessionId: parent.id as string,
      }),
    );
  });
  it('returning proof expires and rejects suspended account without consuming the live nonce', async () => {
    await active();
    const mails: Mail[] = [];
    await generic((service) =>
      service.request({
        email: 'client@example.com',
        sourceKey,
        deliver: async (mail) => {
          mails.push(mail);
        },
      }),
    );
    const mail = mails[0];
    if (!mail) throw new Error('Missing mail');
    const users = await UserCollection.create({ db });
    const user = await users.get({ id: first.userId });
    if (!user) throw new Error('Missing user');
    user.status = UserStatus.SUSPENDED;
    await user.save();
    await expect(
      generic((service) => service.authenticate({ token: mail.token })),
    ).rejects.toMatchObject({ name: 'MagicLinkError' });
    user.status = UserStatus.ACTIVE;
    await user.save();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 601000);
    await expect(
      generic((service) => service.authenticate({ token: mail.token })),
    ).rejects.toMatchObject({ name: 'MagicLinkError' });
  });
  it.skipIf(process.env.TEST_DB_ADAPTER !== 'postgres')(
    'PostgreSQL concurrent completions have exactly one grant and one returning-login winner',
    async () => {
      const invitationToken = await grant();
      const a = await request(invitationToken);
      const b = await request(invitationToken);
      const invitations = await Promise.allSettled([
        complete(invitationToken, a.mail.token),
        complete(invitationToken, b.mail.token),
      ]);
      expect(
        invitations.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        invitations.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      const mails: Mail[] = [];
      await generic((service) =>
        service.request({
          email: 'client@example.com',
          sourceKey,
          deliver: async (mail) => {
            mails.push(mail);
          },
        }),
      );
      const mail = mails[0];
      if (!mail) throw new Error('Missing mail');
      const logins = await Promise.allSettled([
        generic((service) => service.authenticate({ token: mail.token })),
        generic((service) => service.authenticate({ token: mail.token })),
      ]);
      expect(
        logins.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        logins.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
    },
  );
  it.skipIf(process.env.TEST_DB_ADAPTER !== 'postgres')(
    'PostgreSQL root request budget survives caller rollback on transport failure',
    async () => {
      const invitationToken = await grant();
      await expect(
        tx((service) =>
          service.requestMailboxAuthentication({
            membershipId: first.membershipId,
            token: invitationToken,
            sourceKey,
            deliver: async () => {
              throw new Error('transport down');
            },
          }),
        ),
      ).rejects.toThrow('transport down');
      const budget = (
        await db.query(
          'SELECT SUM(attempt_count) AS total FROM users_login_attempts',
        )
      ).rows[0];
      expect(Number(budget?.total)).toBeGreaterThan(0);
      expect(
        (await db.query('SELECT nonce FROM users_magic_link_tokens')).rows,
      ).toHaveLength(1);
      const { mail } = await request(invitationToken);
      await complete(invitationToken, mail.token);
    },
  );
});
