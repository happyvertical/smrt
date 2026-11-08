import { GlobalInterceptors } from '@happyvertical/smrt-core';
import { Profile, ProfileType } from '@happyvertical/smrt-profiles';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationDeliveryCollection } from '../../collections/NotificationDeliveryCollection.js';
import {
  assertNotificationProfileRecipientSchema,
  migrateNotificationProfileRecipients,
  planNotificationProfileRecipients,
} from '../../migrations/profileRecipients.js';
import { Email } from '../../models/Email.js';
import { EmailAccount } from '../../models/EmailAccount.js';
import { NotificationDelivery } from '../../models/NotificationDelivery.js';
import { messagingPrincipalFromPermissions } from '../../permissions.js';
import {
  type NotificationEmailInput,
  type NotificationOutboxOptions,
  NotificationOutboxService,
  notificationDeliveryCorrelationId,
  notificationDeliveryMessageId,
} from '../../services/NotificationOutboxService.js';

const tenant = crypto.randomUUID(),
  other = crypto.randomUUID(),
  user = crypto.randomUUID();
const policy = 'profile:test.contact-pdf.v1';
export function defineProfileRecipientSuite(
  createDatabase: () => Promise<{
    db: DatabaseInterface;
    raceDb?: DatabaseInterface;
    cleanup?: () => Promise<void>;
  }>,
  engine: 'sqlite' | 'postgres',
) {
  describe('typed external contact notification recipients', () => {
    let db: DatabaseInterface,
      raceDb: DatabaseInterface,
      contact: Profile,
      sender: string;
    let cleanup: (() => Promise<void>) | undefined;
    const calls: string[] = [];
    let allowed = true;
    async function profile(owner = tenant, email = 'Client@Example.test') {
      const type = new ProfileType({
        db,
        name: 'Person',
        slug: `profile-recipient-${crypto.randomUUID()}`,
      });
      await type.initialize();
      await type.save();
      if (!type.id)
        throw new Error('Persisted profile type identity required.');
      const typeId = type.id;
      return withTenant({ tenantId: owner }, async () => {
        const row = new Profile({
          db,
          tenantId: owner,
          name: 'Customer contact',
          email,
          typeId,
        });
        await row.initialize();
        await row.save();
        return row;
      });
    }
    function service(extra: Partial<NotificationOutboxOptions> = {}) {
      return new NotificationOutboxService({
        db,
        linkBaseUrl: 'https://local.example.test',
        principal: messagingPrincipalFromPermissions(['messages.send'], {
          tenantId: tenant,
          id: user,
        }),
        resolveRecipient: () => ({ address: 'user@example.test' }),
        resolveProfileRecipient: async ({ recipientProfileId, tenantId }) =>
          allowed && recipientProfileId === contact.id && tenantId === tenant
            ? { address: contact.email!, name: contact.name }
            : null,
        resolveSenderAccountId: () => sender,
        dispatchPolicies: {
          [policy]: {
            resolveAttachments: async () => [
              {
                filename: 'approved.pdf',
                contentType: 'application/pdf',
                content: Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55]),
              },
            ],
          },
        },
        transport: {
          name: 'capture',
          send: async ({ delivery }) => {
            calls.push(delivery.id!);
            return { status: 'accepted' };
          },
        },
        ...extra,
      });
    }
    function input(
      extra: Partial<NotificationEmailInput> = {},
    ): NotificationEmailInput {
      return {
        tenantId: tenant,
        recipientProfileId: contact.id!,
        sourceRef: 'invoice:one:approved',
        kind: `protected:${policy}`,
        requiredDispatchPolicy: policy,
        dispatchPolicyBinding: {
          approved: 'one',
          recipientProfileId: contact.id,
        },
        subject: 'Approved invoice',
        text: 'Your approved invoice is attached.',
        path: '/invoice/one',
        ...extra,
      };
    }
    beforeEach(async () => {
      const context = await createDatabase();
      db = context.db;
      raceDb = context.raceDb ?? db;
      cleanup = context.cleanup;
      contact = await profile();
      sender = await withTenant({ tenantId: tenant }, async () => {
        const a = new EmailAccount({
          db,
          tenantId: tenant,
          name: 'Fixture',
          providerType: 'smtp',
          isActive: true,
        });
        await a.initialize();
        await a.save();
        return a.id!;
      });
      calls.length = 0;
      allowed = true;
    });
    afterEach(async () => {
      if (cleanup) await cleanup();
      else await db?.close?.();
    });
    it('plans without writes, applies real CHECK/uniques, replays and sends a no-User contact once', async () => {
      const plan = await planNotificationProfileRecipients(db, engine);
      expect(plan.ready).toBe(false);
      expect(plan.statements.some((s) => s.includes('CHECK'))).toBe(true);
      await expect(
        assertNotificationProfileRecipientSchema(db),
      ).rejects.toThrow('maintenance');
      await migrateNotificationProfileRecipients(db, engine);
      expect((await planNotificationProfileRecipients(db, engine)).ready).toBe(
        true,
      );
      expect(
        (await migrateNotificationProfileRecipients(db, engine)).statements,
      ).toEqual([]);
      const outbox = service();
      const a = await outbox.enqueueEmail(input());
      const repeat = await outbox.enqueueEmail(input());
      expect(a.delivery.id).toBe(repeat.delivery.id);
      expect(a.delivery.recipientUserId).toBeNull();
      expect(a.delivery.recipientKind).toBe('profile');
      expect(a.delivery.recipientAddress).toBe('client@example.test');
      expect(
        (await db.query('SELECT id FROM users WHERE profile_id=?', contact.id))
          .rows,
      ).toEqual([]);
      await outbox.dispatchDue({
        tenantIds: [tenant],
        deliveryIds: [a.delivery.id!],
      });
      await outbox.dispatchDue({
        tenantIds: [tenant],
        deliveryIds: [a.delivery.id!],
      });
      expect(calls).toEqual([a.delivery.id]);
    });
    it.each([
      ['pending', 'same'],
      ['pending', 'system'],
      ['pending', 'explicit'],
      ['expired', 'same'],
      ['expired', 'system'],
      ['expired', 'explicit'],
    ] as const)('pages past a blocked %s prefix in %s tenant discovery without consuming the lease limit', async (phase, scope) => {
      await migrateNotificationProfileRecipients(db, engine);
      const now = new Date('2026-11-05T12:00:00.000Z');
      const owner = service({ principal: undefined, now: () => now });
      const blocked: NotificationDelivery[] = [];
      for (let i = 0; i < 5; i++) {
        const { delivery } = await owner.enqueueEmail(
          input({
            sourceRef: `blocked-prefix:${i}`,
            notBefore: new Date(now.getTime() - 1000),
          }),
        );
        if (phase === 'expired') {
          await withTenant({ tenantId: tenant }, () =>
            delivery.transition({
              status: 'sending',
              attempts: 1,
              leaseToken: crypto.randomUUID(),
              leaseExpiresAt: new Date(now.getTime() - 1000),
            }),
          );
        }
        // Equal and distinct sub-ms physical values must survive cursor capture.
        // Both dialects execute this; PG stores the full six-digit fraction.
        const column =
          phase === 'expired' ? 'lease_expires_at' : 'next_attempt_at';
        await db.query(
          `UPDATE "${delivery.tableName}" SET ${column}=? WHERE id=? AND tenant_id=?`,
          i < 3 ? '2026-11-05T11:59:59.000123Z' : '2026-11-05T11:59:59.000789Z',
          delivery.id,
          tenant,
        );
        blocked.push(delivery);
      }
      const ordinaryTenant = scope === 'same' ? tenant : other;
      let ordinarySender = sender;
      if (ordinaryTenant === other) {
        ordinarySender = await withTenant({ tenantId: other }, async () => {
          const account = new EmailAccount({
            db,
            tenantId: other,
            name: 'Other fixture',
            providerType: 'smtp',
            isActive: true,
          });
          await account.initialize();
          await account.save();
          return account.id!;
        });
      }
      const ordinary = await service({
        principal: undefined,
        now: () => now,
        resolveSenderAccountId: () => ordinarySender,
      }).enqueueEmail(
        input({
          tenantId: ordinaryTenant,
          recipientProfileId: undefined,
          recipientUserId: user,
          kind: 'ordinary',
          requiredDispatchPolicy: undefined,
          dispatchPolicyBinding: undefined,
          sourceRef: 'after-blocked-prefix',
        }),
      );
      const unconfigured = service({
        principal: undefined,
        now: () => now,
        dispatchPolicies: {},
      });
      const report = await unconfigured.dispatchDue({
        limit: 2,
        ...(scope === 'system'
          ? {}
          : { tenantIds: scope === 'same' ? [tenant] : [tenant, other] }),
      });
      expect(report.leased).toBe(1);
      expect(
        report.outcomes
          .filter((row) => row.outcome === 'blocked')
          .map((row) => row.deliveryId)
          .sort(),
      ).toEqual(blocked.map((row) => row.id!).sort());
      expect(calls).toEqual([ordinary.delivery.id]);
      const collection = await NotificationDeliveryCollection.create({ db });
      const snapshots = await withTenant({ tenantId: tenant }, () =>
        collection.list({ where: { tenantId: tenant } }),
      );
      for (const row of snapshots.filter((row) =>
        blocked.some((b) => b.id === row.id),
      )) {
        expect(row.attempts).toBe(phase === 'expired' ? 1 : 0);
        expect(row.status).toBe(phase === 'expired' ? 'sending' : 'pending');
        expect(row.handedOffAt).toBeNull();
      }
      // Explicit IDs keep detectable blocked outcomes, but no identical diagnostic write.
      const repeat = await unconfigured.dispatchDue({
        tenantIds: [tenant],
        deliveryIds: blocked.map((row) => row.id!),
        limit: 2,
      });
      expect(repeat.leased).toBe(0);
      expect(repeat.outcomes).toHaveLength(blocked.length);
      const repeated = await withTenant({ tenantId: tenant }, () =>
        collection.list({ where: { tenantId: tenant } }),
      );
      expect(repeated.map((row) => [row.id, row.stateVersion]).sort()).toEqual(
        snapshots.map((row) => [row.id, row.stateVersion]).sort(),
      );
      // No backoff/cancellation: a host with current authority can deliver immediately.
      await owner.dispatchDue({
        tenantIds: [tenant],
        deliveryIds: [blocked[0].id!],
        limit: 1,
      });
      expect(calls).toEqual([ordinary.delivery.id, blocked[0].id]);
    });

    it('pages past revoked Profile recipients and reauthorizes after authority returns', async () => {
      await migrateNotificationProfileRecipients(db, engine);
      const owner = service();
      const blocked: NotificationDelivery[] = [];
      for (let i = 0; i < 5; i++)
        blocked.push(
          (
            await owner.enqueueEmail(
              input({
                sourceRef: `revoked-prefix:${i}`,
                notBefore: new Date(1),
              }),
            )
          ).delivery,
        );
      const ordinary = await owner.enqueueEmail(
        input({
          recipientProfileId: undefined,
          recipientUserId: user,
          kind: 'ordinary',
          requiredDispatchPolicy: undefined,
          dispatchPolicyBinding: undefined,
          sourceRef: 'ordinary-after-revocation',
        }),
      );
      allowed = false;
      const report = await owner.dispatchDue({ tenantIds: [tenant], limit: 2 });
      expect(report.leased).toBe(1);
      expect(
        report.outcomes.filter((row) => row.outcome === 'blocked'),
      ).toHaveLength(5);
      expect(calls).toEqual([ordinary.delivery.id]);
      const rows = await withTenant({ tenantId: tenant }, async () =>
        (await NotificationDeliveryCollection.create({ db })).list({
          where: { id: blocked.map((row) => row.id!) },
        }),
      );
      expect(
        rows.every((row) => row.attempts === 0 && row.messageId === null),
      ).toBe(true);
      allowed = true;
      await owner.dispatchDue({
        tenantIds: [tenant],
        deliveryIds: [blocked[0].id!],
        limit: 1,
      });
      expect(calls).toEqual([ordinary.delivery.id, blocked[0].id]);
    });

    it('does not require profile maintenance for legacy user enqueue, including concurrent replay', async () => {
      const outbox = service();
      const value = input({
        recipientProfileId: undefined,
        recipientUserId: user,
        kind: 'ordinary',
        requiredDispatchPolicy: undefined,
        dispatchPolicyBinding: undefined,
      });
      const rows = await Promise.all([
        outbox.enqueueEmail(value),
        outbox.enqueueEmail(value),
      ]);
      expect(rows[0].delivery.id).toBe(rows[1].delivery.id);
      expect(rows[0].delivery.recipientKind).toBe('user');
      expect(rows[0].delivery.recipientProfileId).toBeNull();
    });
    it('requires actual profile schema constraints and refuses index drift', async () => {
      await migrateNotificationProfileRecipients(db, engine);
      await db.query('DROP INDEX notification_deliveries_profile_identity');
      await expect(service().enqueueEmail(input())).rejects.toThrow(
        'maintenance',
      );
      expect(calls).toEqual([]);
    });
    it.each([
      'both',
      'none',
      'empty',
      'unprotected',
    ] as const)('rejects %s recipient identity', async (mode) => {
      await migrateNotificationProfileRecipients(db, engine);
      const value = input();
      if (mode === 'both') value.recipientUserId = user;
      if (mode === 'none') {
        delete value.recipientProfileId;
      }
      if (mode === 'empty') value.recipientProfileId = '';
      if (mode === 'unprotected') {
        value.kind = 'invoice';
        delete value.requiredDispatchPolicy;
      }
      await expect(service().enqueueEmail(value)).rejects.toThrow();
      expect(calls).toEqual([]);
    });
    it.each([
      'changed',
      'revoked',
      'foreign',
      'unrelated',
      'missing',
    ] as const)('blocks %s contact before leasing or provider handoff', async (mode) => {
      await migrateNotificationProfileRecipients(db, engine);
      const outbox = service();
      const { delivery } = await outbox.enqueueEmail(input());
      if (mode === 'changed') {
        contact.email = 'changed@example.test';
        await withTenant({ tenantId: tenant }, () => contact.save());
      }
      if (mode === 'revoked' || mode === 'unrelated') allowed = false;
      if (mode === 'foreign')
        await db.update('profiles', { id: contact.id }, { tenant_id: other });
      if (mode === 'missing') await db.delete('profiles', { id: contact.id });
      const report = await outbox.dispatchDue({
        tenantIds: [tenant],
        deliveryIds: [delivery.id!],
      });
      expect(report.leased).toBe(0);
      expect(report.outcomes[0].outcome).toBe('blocked');
      expect(calls).toEqual([]);
    });
    it('different profiles with the same source coexist, same profile races dedupe', async () => {
      await migrateNotificationProfileRecipients(db, engine);
      const second = await profile(tenant, 'second@example.test');
      const outbox = service({
        resolveProfileRecipient: ({ recipientProfileId }) => ({
          address:
            recipientProfileId === contact.id ? contact.email! : second.email!,
          name: 'Customer contact',
        }),
      });
      const rows = await Promise.all([
        outbox.enqueueEmail(input()),
        outbox.enqueueEmail(input()),
        outbox.enqueueEmail(input({ recipientProfileId: second.id! })),
      ]);
      expect(rows[0].delivery.id).toBe(rows[1].delivery.id);
      expect(rows[2].delivery.id).not.toBe(rows[0].delivery.id);
    });
    it('refuses ordinary late natural-key adoption after a second executor inserts protected intent', async () => {
      const sourceRef = 'race:protected-late-insert';
      const approved = new NotificationDelivery({
        db: raceDb,
        id: crypto.randomUUID(),
        tenantId: tenant,
        recipientUserId: user,
        sourceRef,
        kind: 'protected:fixture.user-pdf',
        requiredDispatchPolicy: 'fixture.user-pdf',
        dispatchPolicyBinding: '{"version":1,"digest":"approved"}',
        subject: 'Approved immutable PDF',
        textBody: 'Approved body',
        href: 'https://local.example.test/invoice/one',
        recipientAddress: 'approved@example.test',
        accountId: sender,
      });
      const ordinary = new NotificationDelivery({
        db,
        id: crypto.randomUUID(),
        tenantId: tenant,
        recipientUserId: user,
        sourceRef,
        kind: 'ordinary',
        subject: 'Unapproved body',
        textBody: 'Unapproved',
        href: 'https://local.example.test/other',
        recipientAddress: 'unapproved@example.test',
        accountId: sender,
      });
      expect(raceDb).not.toBe(db);
      await withTenant({ tenantId: tenant }, async () => {
        await approved.initialize();
        await ordinary.initialize();
      });
      const originalQuery = db.query.bind(db);
      let inserted = false;
      const spy = vi
        .spyOn(db, 'query')
        .mockImplementation(async (sql, ...params) => {
          const result = await originalQuery(sql, ...params);
          if (
            !inserted &&
            sql.startsWith(
              'SELECT * FROM notification_deliveries WHERE tenant_id=',
            )
          ) {
            inserted = true;
            await withTenant({ tenantId: tenant }, async () => {
              await approved.save();
              await approved.transition({
                status: 'uncertain',
                attempts: 3,
                messageId: null,
                lastError: 'Preserve provider uncertainty',
                handedOffAt: new Date('2026-11-05T12:00:00Z'),
              });
            });
            // Prove this is a committed second executor on the SAME database,
            // not another isolated schema-template instance from Vitest's factory.
            expect(
              (
                await originalQuery(
                  'SELECT id FROM notification_deliveries WHERE id=?',
                  approved.id,
                )
              ).rows,
            ).toHaveLength(1);
          }
          return result;
        });
      let saveError: unknown;
      try {
        await withTenant({ tenantId: tenant }, () => ordinary.save()).catch(
          (error) => {
            saveError = error;
          },
        );
      } finally {
        spy.mockRestore();
      }
      expect(inserted).toBe(true);
      expect(approved.id).not.toBeNull();
      const stored = await withTenant({ tenantId: tenant }, async () =>
        (await NotificationDeliveryCollection.create({ db })).get(approved.id!),
      );
      expect(stored).toMatchObject({
        id: approved.id,
        kind: approved.kind,
        requiredDispatchPolicy: approved.requiredDispatchPolicy,
        recipientAddress: 'approved@example.test',
        subject: 'Approved immutable PDF',
        status: 'uncertain',
        attempts: 3,
        stateVersion: 1,
        lastError: 'Preserve provider uncertainty',
      });
      const binding =
        typeof stored!.dispatchPolicyBinding === 'string'
          ? JSON.parse(stored!.dispatchPolicyBinding)
          : stored!.dispatchPolicyBinding;
      expect(binding).toEqual({ version: 1, digest: 'approved' });
      expect(saveError).toBeInstanceOf(Error);
      expect(ordinary.id).not.toBe(approved.id);
      expect(
        (
          await service({
            principal: undefined,
            dispatchPolicies: {},
          }).dispatchDue({ tenantIds: [tenant], deliveryIds: [approved.id!] })
        ).leased,
      ).toBe(0);
      const canonical = new Email({
        db,
        tenantId: tenant,
        id: await notificationDeliveryMessageId(approved.id!),
        correlationId: notificationDeliveryCorrelationId(approved.id!),
        accountId: sender,
        subject: 'Unapproved bypass',
        toAddresses: JSON.stringify([{ address: 'unapproved@example.test' }]),
      });
      await withTenant({ tenantId: tenant }, () => canonical.initialize());
      const refused = await withTenant({ tenantId: tenant }, () =>
        canonical.send(),
      );
      expect(refused.success).toBe(false);
      expect(refused.error).toMatch(/Protected notification/);
      expect(calls).toEqual([]);
    });

    it('binds the protected lifecycle at the final write after a concurrent transition', async () => {
      await migrateNotificationProfileRecipients(db, engine);
      const { delivery } = await service().enqueueEmail(input());
      const stale = await withTenant({ tenantId: tenant }, async () =>
        (await NotificationDeliveryCollection.create({ db })).get(delivery.id!),
      );
      const contender = await withTenant({ tenantId: tenant }, async () =>
        (await NotificationDeliveryCollection.create({ db: raceDb })).get(
          delivery.id!,
        ),
      );
      expect(stale).not.toBeNull();
      expect(contender).not.toBeNull();
      const initialState = (
        await db.query(
          'SELECT state_version FROM notification_deliveries WHERE id=?',
          delivery.id,
        )
      ).rows[0].state_version;
      let advanced = false;
      let finalFilter: Record<string, unknown> | undefined;
      const advance = async () => {
        advanced = true;
        await withTenant({ tenantId: tenant }, () =>
          contender!.transition({
            status: 'uncertain',
            attempts: 4,
            lastError: 'Concurrent handoff outcome unknown',
            handedOffAt: new Date(),
          }),
        );
      };
      const originalGuard =
        GlobalInterceptors.executeWriteGuard.bind(GlobalInterceptors);
      const guardSpy = vi
        .spyOn(GlobalInterceptors, 'executeWriteGuard')
        .mockImplementation((instance, context) => {
          const guard = originalGuard(instance, context);
          if (instance === stale) finalFilter = guard;
          return guard;
        });
      const originalQuery = db.query.bind(db);
      const querySpy = vi
        .spyOn(db, 'query')
        .mockImplementation(async (sql, ...params) => {
          const result = await originalQuery(sql, ...params);
          // Embedded writes serialize their final compare/write; advance before
          // entering that queue. PG instead proves the actual final UPDATE below.
          if (
            engine === 'sqlite' &&
            !advanced &&
            sql.startsWith('SELECT tenant_id, required_dispatch_policy')
          )
            await advance();
          return result;
        });
      const originalUpdate = db.update.bind(db);
      const updateSpy = vi
        .spyOn(db, 'update')
        .mockImplementation(async (table, filter, values) => {
          if (
            engine === 'postgres' &&
            !advanced &&
            table === stale!.tableName
          ) {
            finalFilter = filter as Record<string, unknown>;
            await advance();
          }
          return originalUpdate(table, filter, values);
        });
      try {
        await expect(
          withTenant({ tenantId: tenant }, () => stale!.save()),
        ).rejects.toThrow();
      } finally {
        updateSpy.mockRestore();
        querySpy.mockRestore();
        guardSpy.mockRestore();
      }
      expect(advanced).toBe(true);
      expect(finalFilter).toMatchObject({
        required_dispatch_policy: policy,
        transition_id: '',
      });
      expect(finalFilter?.state_version).toBe(initialState);
      expect(finalFilter).toHaveProperty('dispatch_policy_binding');
      const stored = await withTenant({ tenantId: tenant }, async () =>
        (await NotificationDeliveryCollection.create({ db })).get(delivery.id!),
      );
      expect(stored).toMatchObject({
        requiredDispatchPolicy: policy,
        recipientProfileId: contact.id,
        status: 'uncertain',
        attempts: 4,
        stateVersion: 1,
        lastError: 'Concurrent handoff outcome unknown',
      });
      expect(calls).toEqual([]);
    });

    it('preserves Core missing-schema failure before querying a first raw delivery', async () => {
      const row = new NotificationDelivery({
        db,
        tenantId: tenant,
        recipientUserId: user,
        sourceRef: 'first-raw-delivery',
        kind: 'ordinary',
        subject: 'First',
        textBody: 'Text',
        href: 'https://local.example.test',
        recipientAddress: 'user@example.test',
        accountId: sender,
      });
      await withTenant({ tenantId: tenant }, () => row.initialize());
      await db.query(`DROP TABLE "${row.tableName}"`);
      const queries = vi.spyOn(db, 'query');
      try {
        await expect(
          withTenant({ tenantId: tenant }, () => row.save()),
        ).rejects.toMatchObject({ code: 'DB_SCHEMA_MISSING' });
        expect(
          queries.mock.calls.some(([sql]) =>
            sql.startsWith(
              'SELECT * FROM notification_deliveries WHERE tenant_id=',
            ),
          ),
        ).toBe(false);
        expect(row.subject).toBe('First');
      } finally {
        queries.mockRestore();
      }
    });

    it('preserves safe ordinary natural-key adoption of a legacy NULL policy', async () => {
      const value = input({
        recipientProfileId: undefined,
        recipientUserId: user,
        kind: 'ordinary',
        requiredDispatchPolicy: undefined,
        dispatchPolicyBinding: undefined,
        sourceRef: 'legacy-null-policy',
      });
      const { delivery } = await service().enqueueEmail(value);
      await db.query(
        `UPDATE "${delivery.tableName}" SET required_dispatch_policy=NULL WHERE id=? AND tenant_id=?`,
        delivery.id,
        tenant,
      );
      const copy = new NotificationDelivery({
        db,
        tenantId: tenant,
        recipientUserId: user,
        sourceRef: value.sourceRef,
        kind: 'ordinary',
        subject: 'Updated ordinary',
        textBody: 'Text',
        href: 'https://local.example.test',
        recipientAddress: 'user@example.test',
        accountId: sender,
      });
      await withTenant({ tenantId: tenant }, async () => {
        await copy.initialize();
        await copy.save();
      });
      expect(copy.id).toBe(delivery.id);
      expect(copy.subject).toBe('Updated ordinary');
      expect(calls).toEqual([]);
    });

    it('rejects concurrent saves of the same instance without replacing its private snapshot', async () => {
      await migrateNotificationProfileRecipients(db, engine);
      const { delivery } = await service().enqueueEmail(input());
      await withTenant({ tenantId: tenant }, async () => {
        const first = delivery.save();
        await expect(delivery.save()).rejects.toThrow('Concurrent saves');
        await first;
      });
      expect(calls).toEqual([]);
    });

    it('raw saves retain user natural upsert and prohibit profile identity downgrade', async () => {
      await migrateNotificationProfileRecipients(db, engine);
      const outbox = service();
      const a = await outbox.enqueueEmail(
        input({
          recipientProfileId: undefined,
          recipientUserId: user,
          kind: 'ordinary',
          requiredDispatchPolicy: undefined,
          dispatchPolicyBinding: undefined,
        }),
      );
      await withTenant({ tenantId: tenant }, async () => {
        const copy = new NotificationDelivery({
          db,
          tenantId: tenant,
          recipientUserId: user,
          sourceRef: a.delivery.sourceRef,
          kind: 'ordinary',
          subject: 'Updated ordinary',
          textBody: 'Text',
          href: 'https://local.example.test/invoice/one',
          recipientAddress: 'user@example.test',
          accountId: sender,
        });
        await copy.initialize();
        await copy.save();
        expect(copy.id).toBe(a.delivery.id);
      });
      const { delivery } = await outbox.enqueueEmail(input());
      delivery.recipientKind = 'user';
      delivery.recipientUserId = user;
      delivery.recipientProfileId = null;
      await expect(
        withTenant({ tenantId: tenant }, () => delivery.save()),
      ).rejects.toThrow('typed recipient');
    });
    it('new-ID protected natural clones cannot alter address, binding, lifecycle or recipient namespace', async () => {
      await migrateNotificationProfileRecipients(db, engine);
      const { delivery } = await service().enqueueEmail(input());
      await withTenant({ tenantId: tenant }, async () => {
        const clone = () =>
          new NotificationDelivery({
            ...delivery,
            db,
            created_at: delivery.created_at ?? undefined,
            updated_at: delivery.updated_at ?? undefined,
            id: crypto.randomUUID(),
            slug: crypto.randomUUID(),
          });
        const exact = clone();
        await exact.initialize();
        await exact.save();
        expect(exact.id).toBe(delivery.id);
        for (const change of [
          { recipientAddress: 'attacker@example.test' },
          { dispatchPolicyBinding: '{"changed":true}' },
          { attempts: 99 },
          {
            recipientKind: 'user',
            recipientProfileId: null,
            recipientUserId: user,
          },
        ] as const) {
          const row = clone();
          await row.initialize();
          Object.assign(row, change);
          await expect(row.save()).rejects.toThrow();
        }
      });
    });
    it('concurrent raw ordinary User saves preserve the same natural idempotency identity', async () => {
      const rows = await withTenant({ tenantId: tenant }, () =>
        Promise.all(
          [0, 1].map(async () => {
            const row = new NotificationDelivery({
              db,
              tenantId: tenant,
              recipientUserId: user,
              sourceRef: 'ordinary-raw-race',
              kind: 'ordinary',
              subject: 'Hi',
              textBody: 'Text',
              href: 'https://local.example.test',
              recipientAddress: 'user@example.test',
              accountId: sender,
            });
            await row.initialize();
            await row.save();
            return row;
          }),
        ),
      );
      expect(rows[0].id).toBe(rows[1].id);
    });
    it('rechecks contact changes made by the policy immediately before transport', async () => {
      await migrateNotificationProfileRecipients(db, engine);
      const outbox = service({
        dispatchPolicies: {
          [policy]: {
            resolveAttachments: async () => {
              contact.email = 'changed-during-policy@example.test';
              await withTenant({ tenantId: tenant }, () => contact.save());
              return [
                {
                  filename: 'approved.pdf',
                  contentType: 'application/pdf',
                  content: Uint8Array.from([37, 80, 68, 70]),
                },
              ];
            },
          },
        },
      });
      const { delivery } = await outbox.enqueueEmail(input());
      await outbox.dispatchDue({
        tenantIds: [tenant],
        deliveryIds: [delivery.id!],
      });
      expect(calls).toEqual([]);
      await outbox.dispatchDue({
        tenantIds: [tenant],
        deliveryIds: [delivery.id!],
      });
      expect(calls).toEqual([]);
    });
    it('refuses absent contact authorization and ambiguous or control-bearing addresses', async () => {
      await migrateNotificationProfileRecipients(db, engine);
      await expect(
        service({ resolveProfileRecipient: undefined }).enqueueEmail(input()),
      ).rejects.toThrow('not authorized');
      for (const address of [
        'one@example.test,two@example.test',
        'bad' + String.fromCharCode(0) + '@example.test',
        'one@two@example.test',
        'bad' + String.fromCharCode(13, 10) + '@example.test',
        'bad' + String.fromCharCode(1) + '@example.test',
      ]) {
        contact.email = address;
        if (engine === 'postgres' && address.includes(String.fromCharCode(0))) {
          // PostgreSQL rejects NUL in text before the resolver can see it.
          await expect(
            withTenant({ tenantId: tenant }, () => contact.save()),
          ).rejects.toThrow();
          expect(calls).toEqual([]);
          continue;
        }
        await withTenant({ tenantId: tenant }, () => contact.save());
        await expect(service().enqueueEmail(input())).rejects.toThrow(
          'not authorized',
        );
      }
      expect(calls).toEqual([]);
    });
    it('keeps profile suppression separate from the unchanged User hook and checks it again', async () => {
      await migrateNotificationProfileRecipients(db, engine);
      let suppress = true;
      const outbox = service({
        isSuppressed: () => {
          throw new Error(
            'User opt-out hook must not receive external contacts',
          );
        },
        isProfileSuppressed: (request) => {
          expect(request.recipientProfileId).toBe(contact.id);
          expect('recipientUserId' in request).toBe(false);
          return suppress;
        },
      });
      expect((await outbox.enqueueEmail(input())).delivery.status).toBe(
        'cancelled',
      );
      suppress = false;
      const { delivery } = await outbox.enqueueEmail(
        input({ sourceRef: 'profile-opt-out-after-enqueue' }),
      );
      expect(delivery.status).toBe('pending');
      suppress = true;
      await outbox.dispatchDue({
        tenantIds: [tenant],
        deliveryIds: [delivery.id!],
      });
      expect(calls).toEqual([]);
      const row = await withTenant({ tenantId: tenant }, async () =>
        (await NotificationDeliveryCollection.create({ db })).get(delivery.id!),
      );
      expect(row?.status).toBe('cancelled');
    });
    it('retains uncertain protected history despite cleared caller flags, while ordinary User deletion stays compatible', async () => {
      await migrateNotificationProfileRecipients(db, engine);
      const outbox = service({
        transport: {
          name: 'unknown-capture',
          send: async ({ delivery }) => {
            calls.push(delivery.id!);
            return {
              status: 'unknown',
              error: 'Synthetic lost provider result',
            };
          },
        },
      });
      const { delivery } = await outbox.enqueueEmail(input());
      await outbox.dispatchDue({
        tenantIds: [tenant],
        deliveryIds: [delivery.id!],
      });
      delivery.requiredDispatchPolicy = '';
      delivery.kind = 'ordinary';
      await expect(
        withTenant({ tenantId: tenant }, () => delivery.delete()),
      ).rejects.toThrow('history cannot be deleted');
      const replay = await outbox.enqueueEmail(input());
      expect(replay.delivery.id).toBe(delivery.id);
      expect(replay.delivery.status).toBe('uncertain');
      await outbox.dispatchDue({
        tenantIds: [tenant],
        deliveryIds: [delivery.id!],
      });
      expect(calls).toHaveLength(1);
      const ordinary = await service().enqueueEmail(
        input({
          sourceRef: 'ordinary-delete',
          recipientProfileId: undefined,
          recipientUserId: user,
          kind: 'ordinary',
          requiredDispatchPolicy: undefined,
          dispatchPolicyBinding: undefined,
        }),
      );
      await withTenant({ tenantId: tenant }, () => ordinary.delivery.delete());
      expect(
        (
          await db.query(
            'SELECT id FROM notification_deliveries WHERE id=?',
            ordinary.delivery.id,
          )
        ).rows,
      ).toEqual([]);
    });
    it('raw SQL enforces exactly-one matching identity and profile channel/policy', async () => {
      await migrateNotificationProfileRecipients(db, engine);
      const { delivery } = await service().enqueueEmail(input());
      await expect(
        db.update(
          'notification_deliveries',
          { id: delivery.id },
          { recipient_user_id: user },
        ),
      ).rejects.toThrow();
      await expect(
        db.update(
          'notification_deliveries',
          { id: delivery.id },
          { recipient_kind: 'user' },
        ),
      ).rejects.toThrow();
      await expect(
        db.update(
          'notification_deliveries',
          { id: delivery.id },
          { channel: 'sms' },
        ),
      ).rejects.toThrow();
      await expect(
        db.update(
          'notification_deliveries',
          { id: delivery.id },
          { required_dispatch_policy: '' },
        ),
      ).rejects.toThrow();
    });
    it('broad dispatch without the protected handler leaves the contact pending and untouched', async () => {
      await migrateNotificationProfileRecipients(db, engine);
      const { delivery } = await service().enqueueEmail(input());
      const report = await service({ dispatchPolicies: {} }).dispatchDue({
        tenantIds: [tenant],
      });
      expect(report.leased).toBe(0);
      expect(report.outcomes[0].outcome).toBe('blocked');
      expect(calls).toEqual([]);
      const row = await withTenant({ tenantId: tenant }, async () =>
        (await NotificationDeliveryCollection.create({ db })).get(delivery.id!),
      );
      expect(row?.attempts).toBe(0);
    });
  });
}
