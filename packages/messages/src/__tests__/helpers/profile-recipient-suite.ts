import { Profile, ProfileType } from '@happyvertical/smrt-profiles';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotificationDeliveryCollection } from '../../collections/NotificationDeliveryCollection.js';
import {
  assertNotificationProfileRecipientSchema,
  migrateNotificationProfileRecipients,
  planNotificationProfileRecipients,
} from '../../migrations/profileRecipients.js';
import { EmailAccount } from '../../models/EmailAccount.js';
import { NotificationDelivery } from '../../models/NotificationDelivery.js';
import { messagingPrincipalFromPermissions } from '../../permissions.js';
import {
  type NotificationEmailInput,
  type NotificationOutboxOptions,
  NotificationOutboxService,
} from '../../services/NotificationOutboxService.js';

const tenant = crypto.randomUUID(),
  other = crypto.randomUUID(),
  user = crypto.randomUUID();
const policy = 'profile:test.contact-pdf.v1';
export function defineProfileRecipientSuite(
  createDatabase: () => Promise<{
    db: DatabaseInterface;
    cleanup?: () => Promise<void>;
  }>,
  engine: 'sqlite' | 'postgres',
) {
  describe('typed external contact notification recipients', () => {
    let db: DatabaseInterface, contact: Profile, sender: string;
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
