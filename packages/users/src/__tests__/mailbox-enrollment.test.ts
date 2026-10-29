import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  backfillProfileEmailKeys,
  Person,
  ProfileCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionCollection } from '../collections/SessionCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { backfillUserEmailKeys } from '../migrations/backfillUserEmailKeys.js';
import { LoginAttemptLimiter } from '../services/LoginAttemptLimiter.js';
import { MagicLinkService } from '../services/MagicLinkService.js';
import {
  type MailboxAuthenticationDelivery,
  MailboxAuthenticationService,
} from '../services/MailboxAuthenticationService.js';
import { MailboxEnrollmentService } from '../services/MailboxEnrollmentService.js';
import { UserStatus } from '../types/index.js';

const secret = 'source-bound-mailbox-enrollment-test-secret';
const binding = JSON.stringify([
  'host:submission:v1',
  'workspace',
  'submission',
  'hash',
  'prospect@example.com',
]);
type Mail = Parameters<MailboxAuthenticationDelivery>[0];
describe('source-bound mailbox enrollment', () => {
  let db: DatabaseInterface;
  let admin: DatabaseInterface | undefined;
  let schema: string | undefined;
  let limiter: LoginAttemptLimiter;
  let limiterDb: DatabaseInterface;
  beforeEach(async () => {
    if (process.env.TEST_DB_ADAPTER === 'postgres') {
      if (!process.env.DATABASE_URL)
        throw new Error('Explicit isolated DATABASE_URL is required');
      admin = await getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL,
        dbid: randomUUID(),
      });
      schema = `enrollment_${randomUUID().replaceAll('-', '')}`;
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
    await UserCollection.create({ db });
    await ProfileCollection.create({ db });
    await backfillProfileEmailKeys(db);
    await backfillUserEmailKeys(db);
    await db.query(
      'CREATE TABLE enrollment_test_targets (id TEXT PRIMARY KEY)',
    );
    // SQLite owns one connection per handle: root budget uses a separate store.
    limiterDb =
      process.env.TEST_DB_ADAPTER === 'postgres' ? db : await getTestDatabase();
    limiter = await LoginAttemptLimiter.create({
      db: limiterDb,
      keyPepper: secret,
      audit: false,
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    if (limiterDb !== db) await limiterDb.close?.();
    await db.close?.();
    if (admin && schema)
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.close?.();
    admin = undefined;
    schema = undefined;
  });
  async function tx<T>(
    fn: (
      service: MailboxEnrollmentService,
      executor: DatabaseInterface,
    ) => Promise<T>,
  ) {
    return db.transaction(async (executor) =>
      fn(
        await MailboxEnrollmentService.create({
          db: executor,
          transaction: 'caller',
          secret,
          loginLimiter: limiter,
        }),
        executor,
      ),
    );
  }
  async function request(email = ' Prospect@Example.com ', source = binding) {
    const mails: Mail[] = [];
    expect(
      await tx((service) =>
        service.request({
          email,
          binding: source,
          sourceKey: 'test-source',
          deliver: async (mail) => {
            mails.push(mail);
          },
        }),
      ),
    ).toEqual({ requested: true });
    if (!mails[0]) throw new Error('Missing captured mail');
    return mails[0];
  }
  const complete = (
    token: string,
    extra: {
      binding?: string;
      expectedUserId?: string;
      sessionId?: string;
    } = {},
  ) => tx((service) => service.authenticate({ token, binding, ...extra }));
  async function counts() {
    const result: Record<string, number> = {};
    for (const table of [
      'users',
      'profiles',
      'memberships',
      'sessions',
      'oidc_profile_email_reservations',
      'enrollment_test_targets',
    ])
      result[table] = Number(
        (await db.query(`SELECT COUNT(*) AS total FROM ${table}`)).rows[0]
          .total,
      );
    return result;
  }

  it('requests normalized proof before any identity, destination, membership, or session exists', async () => {
    const before = await counts();
    const mail = await request();
    expect(mail.email).toBe('prospect@example.com');
    expect(await counts()).toEqual(before);
    const identity = await complete(mail.token);
    expect(identity.email).toBe('prospect@example.com');
    expect(
      await (await UserCollection.create({ db })).get({ id: identity.userId }),
    ).toMatchObject({
      status: UserStatus.ACTIVE,
      profileId: identity.profileId,
    });
    expect(
      await (
        await ProfileCollection.create({ db })
      ).requireCanonicalGlobalPerson(identity.profileId, identity.email),
    ).toBeTruthy();
    const after = await counts();
    expect(after.users - before.users).toBe(1);
    expect(after.profiles - before.profiles).toBe(1);
    expect(after.memberships).toBe(before.memberships);
    expect(after.sessions).toBe(before.sessions);
    await expect(complete(mail.token)).rejects.toThrow();
  });
  it('returns uniformly for malformed email and fails closed without budget/source/delivery/binding', async () => {
    const deliver = vi.fn(async (_mail: Mail) => {});
    for (const email of ['', ' ', 'not-mail'])
      expect(
        await tx((service) =>
          service.request({
            email,
            binding,
            sourceKey: 'test-source',
            deliver,
          }),
        ),
      ).toEqual({ requested: true });
    expect(deliver).not.toHaveBeenCalled();
    await expect(
      tx((service) =>
        service.request({
          email: 'a@example.com',
          binding: '',
          sourceKey: 'test-source',
          deliver,
        }),
      ),
    ).rejects.toThrow('binding');
    await expect(
      tx((service) =>
        service.request({
          email: 'a@example.com',
          binding,
          sourceKey: '',
          deliver,
        }),
      ),
    ).rejects.toThrow('source key');
    await expect(
      db.transaction(async (executor) =>
        (
          await MailboxEnrollmentService.create({
            db: executor,
            transaction: 'caller',
            secret,
          })
        ).request({
          email: 'a@example.com',
          binding,
          sourceKey: 'test-source',
          deliver,
        }),
      ),
    ).rejects.toThrow('root-executor');
  });
  it('retains request budgets and denies the next request before delivery', async () => {
    limiter = await LoginAttemptLimiter.create({
      db: limiterDb,
      keyPepper: secret,
      audit: false,
      maxAttempts: 2,
    });
    const deliver = vi.fn(async (_mail: Mail) => {});
    const send = () =>
      tx((service) =>
        service.request({
          email: 'prospect@example.com',
          binding,
          sourceKey: 'test-source',
          deliver,
        }),
      );
    await send();
    await send();
    await expect(send()).rejects.toMatchObject({ name: 'LoginRateLimitError' });
    expect(deliver).toHaveBeenCalledTimes(2);
  });
  it('rejects changed workspace/submission binding, tamper, expiry, and generic magic-link purpose without consuming', async () => {
    const mail = await request();
    await expect(
      complete(mail.token, { binding: `${binding}different` }),
    ).rejects.toThrow('source');
    await expect(complete(`${mail.token}tampered`)).rejects.toThrow();
    const login = await db.transaction(async (executor) =>
      (await MagicLinkService.create({ db: executor, secret })).generate(
        mail.email,
      ),
    );
    await expect(complete(login.token)).rejects.toThrow();
    await expect(
      db.transaction(async (executor) =>
        (await MagicLinkService.create({ db: executor, secret })).verify(
          mail.token,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      db.transaction(async (executor) =>
        (
          await MailboxAuthenticationService.create({
            db: executor,
            transaction: 'caller',
            secret,
          })
        ).authenticate({ token: mail.token }),
      ),
    ).rejects.toThrow();
    for (const issuer of [
      'smrt:tenant-invitation:v1:binding',
      'smrt:tenant-mailbox:v1:binding:grant',
    ]) {
      await expect(
        db.transaction(async (executor) =>
          (
            await MagicLinkService.create({ db: executor, secret, issuer })
          ).verify(mail.token),
        ),
      ).rejects.toThrow();
      const otherPurpose = await db.transaction(async (executor) =>
        (
          await MagicLinkService.create({ db: executor, secret, issuer })
        ).generate(mail.email),
      );
      await expect(complete(otherPurpose.token)).rejects.toThrow();
    }
    await complete(mail.token);
    const expiring = await request('expires@example.com');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 601000);
    await expect(complete(expiring.token)).rejects.toThrow('expired');
  });
  it('rolls back proof consumption, new identity, canonical reservation and host writes together', async () => {
    const mail = await request();
    const before = await counts();
    await expect(
      tx(async (service, executor) => {
        const identity = await service.authenticate({
          token: mail.token,
          binding,
        });
        await executor.query(
          'INSERT INTO enrollment_test_targets (id) VALUES (?)',
          identity.userId,
        );
        throw new Error('host rollback');
      }),
    ).rejects.toThrow('host rollback');
    expect(await counts()).toEqual(before);
    expect((await complete(mail.token)).email).toBe(mail.email);
  });
  it('rolled-back transport proof cannot authenticate while root limiter keeps its budget', async () => {
    let token = '';
    await expect(
      tx((service) =>
        service.request({
          email: 'prospect@example.com',
          binding,
          sourceKey: 'test-source',
          deliver: async (mail) => {
            token = mail.token;
            throw new Error('transport down');
          },
        }),
      ),
    ).rejects.toThrow('transport down');
    expect(token).not.toBe('');
    await expect(complete(token)).rejects.toThrow();
    expect(
      Number(
        (
          await limiterDb.query(
            'SELECT SUM(attempt_count) AS total FROM users_login_attempts',
          )
        ).rows[0].total,
      ),
    ).toBeGreaterThan(0);
  });
  it('reuses active canonical identity without any membership and preserves compatible first-class actor', async () => {
    const first = await complete((await request()).token);
    const sessionId = (
      await (
        await SessionCollection.create({ db })
      ).createSession({ userId: first.userId, authMethod: 'magic-link' })
    ).id as string;
    const before = await counts();
    const mail = await request();
    await expect(
      complete(mail.token, { expectedUserId: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      complete(mail.token, { sessionId: randomUUID() }),
    ).rejects.toThrow();
    expect(
      await complete(mail.token, { expectedUserId: first.userId, sessionId }),
    ).toEqual(first);
    expect(await counts()).toEqual(before);
    const unknown = await request('unknown@example.com');
    await expect(complete(unknown.token, { sessionId })).rejects.toThrow();
    await expect(
      complete(unknown.token, { expectedUserId: first.userId }),
    ).rejects.toThrow();
    expect((await complete(unknown.token)).email).toBe('unknown@example.com');
  });
  it.each([
    'terminal',
    'layered',
    'ceiling',
  ])('refuses %s sessions without consuming the proof', async (kind) => {
    const identity = await complete((await request()).token);
    const sessions = await SessionCollection.create({ db });
    const parent = await sessions.createSession({
      userId: identity.userId,
      authMethod: 'magic-link',
    });
    const session = await sessions.createSession({
      userId: identity.userId,
      authMethod: kind === 'terminal' ? 'terminal' : 'magic-link',
    });
    if (kind === 'layered') session.parentSessionId = parent.id as string;
    if (kind === 'ceiling') session.setData('permissionCeiling', []);
    await session.save();
    const mail = await request();
    await expect(
      complete(mail.token, { sessionId: session.id as string }),
    ).rejects.toThrow();
    expect(await complete(mail.token)).toEqual(identity);
  });
  it.each([
    UserStatus.PENDING,
    UserStatus.SUSPENDED,
    UserStatus.INACTIVE,
  ])('refuses existing %s user without reviving it', async (status) => {
    const first = await complete((await request()).token);
    const user = await (await UserCollection.create({ db })).get({
      id: first.userId,
    });
    if (!user) throw new Error('Missing user');
    user.status = status;
    await user.save();
    const mail = await request();
    await expect(complete(mail.token)).rejects.toThrow('unavailable');
    expect(
      (
        await (
          await UserCollection.create({ db })
        ).get({ id: first.userId }, { cache: false })
      )?.status,
    ).toBe(status);
  });
  it.each([
    1, 2,
  ])('refuses to adopt %s unowned same-email global Persons', async (count) => {
    const type = await withSystemContext(async () =>
      (await ProfileTypeCollection.create({ db })).getOrCreateGlobalBySlug(
        'person',
        { name: 'Person' },
      ),
    );
    for (let i = 0; i < count; i++) {
      const person = new Person({
        db,
        tenantId: null,
        typeId: type.id as string,
        slug: randomUUID(),
        name: 'Unowned',
        email: 'prospect@example.com',
      });
      await person.initialize();
      await person.save();
    }
    const mail = await request();
    await expect(complete(mail.token)).rejects.toThrow();
    expect(
      await (await UserCollection.create({ db })).findCanonicalByEmail(
        mail.email,
      ),
    ).toBeNull();
  });
  it('concurrent same-proof completions have exactly one consumer and one canonical identity', async () => {
    const mail = await request();
    const before = await counts();
    const results = await Promise.allSettled([
      complete(mail.token),
      complete(mail.token),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const after = await counts();
    expect(after.users - before.users).toBe(1);
    expect(after.profiles - before.profiles).toBe(1);
    expect(
      after.oidc_profile_email_reservations -
        before.oidc_profile_email_reservations,
    ).toBe(1);
  });
  it('concurrent independently issued proofs never duplicate canonical identity; rolled-back losers can retry', async () => {
    const mails = [await request(), await request()];
    const before = await counts();
    const results = await Promise.allSettled(
      mails.map((mail) => complete(mail.token)),
    );
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    const winner = results.find((result) => result.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('Missing winner');
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected')
        expect(await complete(mails[i].token)).toEqual(winner.value);
      else
        expect(
          (results[i] as PromiseFulfilledResult<typeof winner.value>).value,
        ).toEqual(winner.value);
    }
    const after = await counts();
    expect(after.users - before.users).toBe(1);
    expect(after.profiles - before.profiles).toBe(1);
    expect(
      after.oidc_profile_email_reservations -
        before.oidc_profile_email_reservations,
    ).toBe(1);
  });
});
