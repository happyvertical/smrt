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
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { backfillUserEmailKeys } from '../migrations/backfillUserEmailKeys.js';
import { LoginAttemptLimiter } from '../services/LoginAttemptLimiter.js';
import { MagicLinkService } from '../services/MagicLinkService.js';
import {
  type MailboxAuthenticationRequestScope,
  MailboxAuthenticationService,
  type MailboxRequestReservation,
  reserveMailboxAuthenticationRequest,
} from '../services/MailboxAuthenticationService.js';
import {
  type PreparedTenantInvitation,
  TenantInvitationService,
} from '../services/TenantInvitationService.js';
import { MembershipStatus, UserStatus } from '../types/index.js';

const secret = 'reservation-fixture-independent-mailbox-secret';
const sourceKey = 'trusted-client';
const email = 'person@example.com';
describe('pre-transaction mailbox request capability', () => {
  let db: DatabaseInterface;
  let admin: DatabaseInterface | undefined;
  let schema: string | undefined;
  let limiter: LoginAttemptLimiter;
  let tenantId: string;
  let invitee: PreparedTenantInvitation;
  let invitationToken: string;
  const returning = (): MailboxAuthenticationRequestScope => ({
    purpose: 'returning',
    email,
  });
  const invitation = (): MailboxAuthenticationRequestScope => ({
    purpose: 'invitation',
    tenantId,
    email,
  });
  beforeEach(async () => {
    if (process.env.TEST_DB_ADAPTER === 'postgres') {
      if (!process.env.DATABASE_URL)
        throw new Error('Explicit isolated DATABASE_URL required');
      admin = await getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL,
        dbid: randomUUID(),
      });
      schema = `reservation_${randomUUID().replaceAll('-', '')}`;
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
    await MembershipCollection.create({ db });
    await ProfileCollection.create({ db });
    await (await RoleCollection.create({ db })).seedSystemRoles({
      seedPermissions: false,
    });
    tenantId = (
      await (
        await TenantCollection.create({ db })
      ).create({ name: 'Family', slug: randomUUID() })
    ).id as string;
    await backfillProfileEmailKeys(db);
    await backfillUserEmailKeys(db);
    limiter = await LoginAttemptLimiter.create({
      db,
      keyPepper: secret,
      audit: false,
    });
    invitee = await db.transaction(async (tx) =>
      (
        await TenantInvitationService.create({
          db: tx,
          transaction: 'caller',
          secret,
        })
      ).prepare({ tenantId, email, roleSlug: 'viewer' }),
    );
    invitationToken = (
      await db.transaction(async (tx) =>
        (
          await TenantInvitationService.create({
            db: tx,
            transaction: 'caller',
            secret,
          })
        ).issue({ membershipId: invitee.membershipId }),
      )
    ).token;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await db.close?.();
    if (admin && schema)
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.close?.();
    admin = undefined;
    schema = undefined;
  });
  async function active() {
    const user = await (await UserCollection.create({ db })).get(
      invitee.userId,
    );
    const member = await (await MembershipCollection.create({ db })).get(
      invitee.membershipId,
    );
    if (!user || !member) throw new Error('Missing fixture');
    user.status = UserStatus.ACTIVE;
    member.status = MembershipStatus.ACTIVE;
    await user.save();
    await member.save();
  }
  const reserve = (
    scope = returning(),
    source = sourceKey,
    selected = limiter,
  ) =>
    reserveMailboxAuthenticationRequest({
      limiter: selected,
      scope,
      sourceKey: source,
    });
  function requestReturning(
    reservation: MailboxRequestReservation | undefined,
    options: {
      email?: string;
      sourceKey?: string;
      limiter?: LoginAttemptLimiter;
      deliver?: () => Promise<void>;
    } = {},
  ) {
    return db.transaction(async (tx) =>
      (
        await MailboxAuthenticationService.create({
          db: tx,
          transaction: 'caller',
          secret,
          loginLimiter: options.limiter ?? limiter,
        })
      ).request({
        reservation,
        email: options.email ?? email,
        sourceKey: options.sourceKey ?? sourceKey,
        deliver: options.deliver ?? (async () => {}),
      }),
    );
  }
  function requestInvitation(
    reservation: MailboxRequestReservation | undefined,
    deliver: () => Promise<void> = async () => {},
  ) {
    return db.transaction(async (tx) =>
      (
        await TenantInvitationService.create({
          db: tx,
          transaction: 'caller',
          secret,
          loginLimiter: limiter,
        })
      ).requestMailboxAuthentication({
        reservation,
        membershipId: invitee.membershipId,
        token: invitationToken,
        sourceKey,
        deliver,
      }),
    );
  }
  async function sourceCount() {
    const row = await db.get('users_login_attempts', {
      limiter_key: limiter.hashKey('source', `mailbox:${sourceKey}`),
    });
    return Number(row?.attempt_count ?? 0);
  }
  it.each([
    'returning',
    'invitation',
  ] as const)('retains five %s transport failures outside rollback and refuses request six', async (flow) => {
    if (flow === 'returning') await active();
    let sends = 0;
    const counts: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const capability = await reserve(
          flow === 'returning' ? returning() : invitation(),
        );
        const deliver = async () => {
          sends++;
          throw new Error('transport failed');
        };
        if (flow === 'returning')
          await requestReturning(capability, { deliver });
        else await requestInvitation(capability, deliver);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      counts.push(await sourceCount());
      if (flow === 'invitation' && attempt < 5) {
        invitationToken = (
          await db.transaction(async (tx) =>
            (
              await TenantInvitationService.create({
                db: tx,
                transaction: 'caller',
                secret,
              })
            ).issue({ membershipId: invitee.membershipId }),
          )
        ).token;
      }
    }
    expect(counts).toEqual([1, 2, 3, 4, 5, 5]);
    expect(sends).toBe(5);
  });
  it('fails closed when an upstream allowed lease has an invalid budget deadline', async () => {
    const original = limiter.reserve.bind(limiter);
    vi.spyOn(limiter, 'reserve').mockImplementation(async (input) => {
      const result = await original(input);
      return result.allowed
        ? { ...result, budgetExpiresAt: Number.NaN }
        : result;
    });
    await expect(reserve()).rejects.toThrow('budget deadline is unavailable');
    expect(await sourceCount()).toBe(1);
  });
  it('is frozen, has no serializable authority and refuses forged/copied/reused capabilities', async () => {
    await active();
    const capability = await reserve();
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.keys(capability)).toEqual([]);
    expect(JSON.stringify(capability)).toBe('{}');
    for (const fake of [
      {},
      { ...capability },
      JSON.parse(JSON.stringify(capability)),
    ]) {
      await expect(
        requestReturning(fake as MailboxRequestReservation),
      ).rejects.toThrow('reservation is unavailable');
    }
    await expect(requestReturning(capability)).resolves.toEqual({
      requested: true,
    });
    await expect(requestReturning(capability)).rejects.toThrow(
      'reservation is unavailable',
    );
    expect(await sourceCount()).toBe(1);
  });
  it('claims synchronously so concurrent reuse of the same capability has one winner', async () => {
    await active();
    const capability = await reserve();
    let sends = 0;
    // Two service calls share the caller transaction executor; capability claim
    // occurs synchronously, before identity/database work is allowed to await.
    await db.transaction(async (tx) => {
      const service = await MailboxAuthenticationService.create({
        db: tx,
        transaction: 'caller',
        secret,
        loginLimiter: limiter,
      });
      const result = await Promise.allSettled(
        [0, 1].map(() =>
          service.request({
            reservation: capability,
            email,
            sourceKey,
            deliver: async () => {
              sends++;
            },
          }),
        ),
      );
      expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(
        1,
      );
      expect(result.filter((item) => item.status === 'rejected')).toHaveLength(
        1,
      );
    });
    expect(sends).toBe(1);
  });
  it.each([
    'source',
    'email',
    'limiter',
    'purpose',
    'tenant',
  ] as const)('consumes a mismatched %s capability without proof or delivery', async (mismatch) => {
    await active();
    let sends = 0;
    const before = (await db.query('SELECT nonce FROM users_magic_link_tokens'))
      .rows.length;
    const scope =
      mismatch === 'tenant'
        ? ({
            ...invitation(),
            tenantId: randomUUID(),
          } as MailboxAuthenticationRequestScope)
        : mismatch === 'purpose'
          ? invitation()
          : returning();
    const capability = await reserve(scope);
    const other =
      mismatch === 'limiter'
        ? await LoginAttemptLimiter.create({
            db,
            keyPepper: secret,
            audit: false,
          })
        : limiter;
    const request =
      mismatch === 'tenant'
        ? requestInvitation(capability, async () => {
            sends++;
          })
        : requestReturning(capability, {
            sourceKey: mismatch === 'source' ? 'another-client' : sourceKey,
            email: mismatch === 'email' ? 'another@example.com' : email,
            limiter: other,
            deliver: async () => {
              sends++;
            },
          });
    await expect(request).rejects.toThrow('reservation');
    await expect(requestReturning(capability)).rejects.toThrow(
      'reservation is unavailable',
    );
    expect(sends).toBe(0);
    expect(
      (await db.query('SELECT nonce FROM users_magic_link_tokens')).rows.length,
    ).toBe(before);
    expect(await sourceCount()).toBe(1);
  });
  it('accepts normalized email/source equivalence and binds invitation email independently', async () => {
    await active();
    const capability = await reserve(
      { purpose: 'returning', email: ' Person@Example.com ' },
      ' trusted-client ',
    );
    await expect(requestReturning(capability)).resolves.toEqual({
      requested: true,
    });
    const incorrect = await reserve({
      purpose: 'invitation',
      tenantId,
      email: 'another@example.com',
    });
    await expect(requestInvitation(incorrect)).rejects.toThrow(
      'does not match destination',
    );
  });
  it('separates a malformed returning invitation-tuple email from the invitation subject while sharing source budget', async () => {
    const literal = JSON.stringify(['invitation', tenantId, email]);
    const malformed = await reserve({ purpose: 'returning', email: literal });
    await expect(
      requestReturning(malformed, { email: literal }),
    ).resolves.toEqual({ requested: true });
    const cap = await reserve(invitation());
    expect(cap).toBeDefined();
    const returningKey = limiter.hashKey(
      'subject',
      `mailbox:${JSON.stringify(['returning', literal])}`,
    );
    const invitationKey = limiter.hashKey('subject', `mailbox:${literal}`);
    expect(returningKey).not.toBe(invitationKey);
    expect(
      Number(
        (await db.get('users_login_attempts', { limiter_key: returningKey }))
          ?.attempt_count,
      ),
    ).toBe(1);
    expect(
      Number(
        (await db.get('users_login_attempts', { limiter_key: invitationKey }))
          ?.attempt_count,
      ),
    ).toBe(1);
    expect(await sourceCount()).toBe(2);
  });
  it('unknown and malformed returning requests retain the same source budget without proof', async () => {
    const deliver = vi.fn(async () => {});
    const before = (await db.query('SELECT nonce FROM users_magic_link_tokens'))
      .rows.length;
    for (const submitted of ['', ' invalid ', 'unknown@example.com']) {
      const capability = await reserve({
        purpose: 'returning',
        email: submitted,
      });
      await expect(
        requestReturning(capability, { email: submitted, deliver }),
      ).resolves.toEqual({ requested: true });
    }
    expect(deliver).not.toHaveBeenCalled();
    expect(await sourceCount()).toBe(3);
    expect(
      (await db.query('SELECT nonce FROM users_magic_link_tokens')).rows.length,
    ).toBe(before);
  });
  it.each([
    'returning',
    'invitation',
  ] as const)('expires at thirty seconds and after awaited %s identity work', async (flow) => {
    await active();
    vi.useFakeTimers({ toFake: ['Date'] });
    const selectedScope = flow === 'returning' ? returning() : invitation();
    const request = flow === 'returning' ? requestReturning : requestInvitation;
    const capability = await reserve(selectedScope);
    vi.setSystemTime(Date.now() + 30_000);
    await expect(request(capability)).rejects.toThrow('expired');
    const next = await reserve(selectedScope);
    const original = ProfileCollection.prototype.requireCanonicalGlobalPerson;
    vi.spyOn(
      ProfileCollection.prototype,
      'requireCanonicalGlobalPerson',
    ).mockImplementation(async function (...args) {
      const result = await original.apply(this, args);
      vi.setSystemTime(Date.now() + 30_000);
      return result;
    });
    const before = (await db.query('SELECT nonce FROM users_magic_link_tokens'))
      .rows.length;
    await expect(request(next)).rejects.toThrow('expired');
    expect(
      (await db.query('SELECT nonce FROM users_magic_link_tokens')).rows.length,
    ).toBe(before);
  });
  it.each([
    'returning',
    'invitation',
  ] as const)('rechecks %s expiry after proof generation before transport and rolls back the proof', async (flow) => {
    await active();
    vi.useFakeTimers({ toFake: ['Date'] });
    const capability = await reserve(
      flow === 'returning' ? returning() : invitation(),
    );
    const original = MagicLinkService.prototype.generate;
    vi.spyOn(MagicLinkService.prototype, 'generate').mockImplementation(
      async function (...args) {
        const result = await original.apply(this, args);
        vi.setSystemTime(Date.now() + 30_000);
        return result;
      },
    );
    const deliver = vi.fn(async () => {});
    const before = (await db.query('SELECT nonce FROM users_magic_link_tokens'))
      .rows.length;
    await expect(
      flow === 'returning'
        ? requestReturning(capability, { deliver })
        : requestInvitation(capability, deliver),
    ).rejects.toThrow('expired');
    expect(deliver).not.toHaveBeenCalled();
    expect(
      (await db.query('SELECT nonce FROM users_magic_link_tokens')).rows.length,
    ).toBe(before);
  });
  it('expires at the earliest existing source window rather than a new thirty-second TTL', async () => {
    await active();
    vi.useFakeTimers({ toFake: ['Date'] });
    limiter = await LoginAttemptLimiter.create({
      db,
      keyPepper: secret,
      audit: false,
      subject: { windowSeconds: 100 },
      source: { windowSeconds: 1 },
    });
    const first = await reserve({
      purpose: 'returning',
      email: 'earlier@example.com',
    });
    expect(first).toBeDefined();
    vi.setSystemTime(Date.now() + 900);
    const capability = await reserve();
    vi.setSystemTime(Date.now() + 100);
    await expect(requestReturning(capability)).rejects.toThrow('expired');
  });
  it.skipIf(process.env.TEST_DB_ADAPTER === 'postgres')(
    'embedded implicit requests refuse before writes or delivery',
    async () => {
      await active();
      const deliver = vi.fn(async () => {});
      const before = (
        await db.query('SELECT nonce FROM users_magic_link_tokens')
      ).rows.length;
      await expect(requestReturning(undefined, { deliver })).rejects.toThrow(
        'pre-transaction reservation',
      );
      await expect(requestInvitation(undefined, deliver)).rejects.toThrow(
        'pre-transaction reservation',
      );
      expect(deliver).not.toHaveBeenCalled();
      expect(await sourceCount()).toBe(0);
      expect(
        (await db.query('SELECT nonce FROM users_magic_link_tokens')).rows
          .length,
      ).toBe(before);
    },
  );
});
