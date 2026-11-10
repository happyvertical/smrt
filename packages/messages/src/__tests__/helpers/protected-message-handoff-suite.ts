/** Real persistence plus a capture-only provider: protected outbox sends cannot escape policy. */
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageCollection } from '../../collections/MessageCollection.js';
import { NotificationDeliveryCollection } from '../../collections/NotificationDeliveryCollection.js';
import { Email } from '../../models/Email.js';
import { EmailAccount } from '../../models/EmailAccount.js';
import { Message } from '../../models/Message.js';
import { EmailSender } from '../../senders/EmailSender.js';
import {
  messageSendTransport,
  type NotificationOutboxOptions,
  NotificationOutboxService,
  type NotificationTransport,
} from '../../services/NotificationOutboxService.js';
import type { SendEmailOptions } from '../../types.js';

const POLICY = 'fixture.private-pdf';
const BYTES = Buffer.from('%PDF synthetic protected bytes %%EOF');
export function defineProtectedMessageHandoffSuite(
  createDatabase: () => Promise<{
    db: DatabaseInterface;
    cleanup: () => Promise<void>;
  }>,
): void {
  describe('protected canonical message handoff', () => {
    let cleanup: (() => Promise<void>) | undefined;
    let db: DatabaseInterface;
    let tenantId: string;
    let accountId: string;
    let clock: Date;
    let provider: ReturnType<typeof vi.fn>;
    const run = <T>(fn: () => Promise<T>) => withTenant({ tenantId }, fn);
    function service(
      transport?: NotificationTransport,
      extra: Partial<NotificationOutboxOptions> = {},
    ) {
      return new NotificationOutboxService({
        db,
        linkBaseUrl: 'https://fixture.example.com',
        resolveRecipient: () => ({ address: 'approved@example.com' }),
        resolveSenderAccountId: () => accountId,
        now: () => clock,
        dispatchPolicies: {
          [POLICY]: {
            resolveAttachments: () => [
              {
                filename: 'invoice.pdf',
                contentType: 'application/pdf',
                content: BYTES,
              },
            ],
          },
        },
        ...(transport ? { transport } : {}),
        ...extra,
      });
    }
    async function enqueue(outbox = service()) {
      return (
        await outbox.enqueueEmail({
          tenantId,
          recipientUserId: crypto.randomUUID(),
          sourceRef: crypto.randomUUID(),
          kind: `protected:${POLICY}`,
          requiredDispatchPolicy: POLICY,
          dispatchPolicyBinding: {
            version: 1,
            recipient: 'approved@example.com',
          },
          subject: 'Approved document',
          text: 'Approved body',
          path: '/private/document',
        })
      ).delivery;
    }
    async function parked() {
      const outbox = service({
        name: 'park',
        send: async () => ({
          status: 'rejected',
          retryable: true,
          error: 'synthetic pre-provider refusal',
        }),
      });
      const delivery = await enqueue(outbox);
      await outbox.dispatchDue({ tenantIds: [tenantId] });
      const stored = await (
        await NotificationDeliveryCollection.create({ db })
      ).get({ id: delivery.id });
      const message = await (await MessageCollection.create({ db })).get({
        id: stored!.messageId,
      });
      if (!message) throw new Error('fixture canonical message missing');
      return { delivery, message };
    }
    beforeEach(async () => {
      const isolated = await createDatabase();
      db = isolated.db;
      cleanup = isolated.cleanup;
      tenantId = crypto.randomUUID();
      clock = new Date();
      await run(async () => {
        const account = new EmailAccount({
          db,
          tenantId,
          name: 'Fixture sender',
          email: 'sender@example.com',
          providerType: 'smtp',
          isActive: true,
        });
        await account.initialize();
        await account.save();
        accountId = account.id!;
      });
      provider = vi.fn(async () => ({
        messageId: 'capture-only',
        accepted: ['approved@example.com'],
        rejected: [],
        response: 'captured',
      }));
      vi.spyOn(EmailAccount.prototype, 'createSender').mockImplementation(
        async function (this: EmailAccount) {
          return new EmailSender({ send: provider } as never, this);
        },
      );
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanup?.();
    });
    it('denies direct canonical send after reload without the policy handoff', async () =>
      run(async () => {
        const { message } = await parked();
        expect((await message.send()).success).toBe(false);
        expect(provider).toHaveBeenCalledTimes(0);
      }));
    it('denies clearing persisted protection and spoofing original identity', async () =>
      run(async () => {
        const { message } = await parked();
        message.correlationId = '';
        message.setMetadata({});
        await expect(message.save()).rejects.toThrow();
        message.id = crypto.randomUUID();
        message.slug = crypto.randomUUID();
        expect((await message.send()).success).toBe(false);
        expect(provider).toHaveBeenCalledTimes(0);
      }));
    it('denies a protected clone retaining original provenance even if fields are cleared', async () =>
      run(async () => {
        const { message } = await parked();
        const clone = new Email({
          ...message.toJSON(),
          db,
          id: crypto.randomUUID(),
          slug: crypto.randomUUID(),
          sendStatus: 'draft',
        });
        await clone.initialize();
        clone.correlationId = '';
        clone.setMetadata({});
        expect((await clone.send()).success).toBe(false);
        expect(provider).toHaveBeenCalledTimes(0);
      }));
    it('refuses fresh natural-key adoption of a protected row after ordinary-looking fields are stripped', async () =>
      run(async () => {
        const { message } = await parked();
        const replacement = new Email({
          ...message.toJSON(),
          db,
          id: crypto.randomUUID(),
          metadata: '{}',
          correlationId: '',
          sendStatus: 'draft',
        });
        await replacement.initialize();
        await expect(replacement.save()).rejects.toThrow();
        const stored = (await (
          await MessageCollection.create({ db })
        ).get({ id: message.id }))!;
        expect(stored.getMetadata()).toHaveProperty('__smrtProtectedOutbox');
        expect(provider).toHaveBeenCalledTimes(0);
      }));
    it.each([
      { kind: 'forward', entry: 'Email' },
      { kind: 'reply', entry: 'Email' },
      { kind: 'forward', entry: 'Message' },
      { kind: 'reply', entry: 'Message' },
    ] as const)('public $entry.create$kind retains protection after the rehydrated source fields are cleared', async ({
      kind,
      entry,
    }) =>
      run(async () => {
        const { message } = await parked();
        // parked() reloaded the actual durable canonical Email from its collection.
        expect(() => {
          message.id = null;
        }).toThrow('id is required');
        message.id = crypto.randomUUID();
        message.correlationId = '';
        message.setMetadata({});
        const derived =
          entry === 'Message'
            ? kind === 'forward'
              ? Message.prototype.createForward.call(message)
              : Message.prototype.createReply.call(message)
            : kind === 'forward'
              ? message.createForward()
              : message.createReply();
        await derived.initialize();
        derived.correlationId = '';
        derived.setMetadata({});
        derived.setToAddresses([{ address: 'new-unapproved@example.com' }]);
        expect((await derived.send()).success).toBe(false);
        expect(provider).toHaveBeenCalledTimes(0);
      }));
    it('legitimate protected default outbox delivers approved bytes exactly once and later direct retry is denied', async () =>
      run(async () => {
        const outbox = service();
        const delivery = await enqueue(outbox);
        expect(
          (await outbox.dispatchDue({ tenantIds: [tenantId] })).outcomes[0]
            ?.outcome,
        ).toBe('sent');
        expect(provider).toHaveBeenCalledTimes(1);
        expect(
          Buffer.from(
            provider.mock.calls[0]?.[0]?.attachments[0].content ?? [],
          ),
        ).toEqual(BYTES);
        const stored = await (
          await NotificationDeliveryCollection.create({ db })
        ).get({ id: delivery.id });
        const message = (await (
          await MessageCollection.create({ db })
        ).get({ id: stored!.messageId }))!;
        expect((await message.retrySend()).success).toBe(false);
        expect((await message.send({ attachments: [] } as never)).success).toBe(
          false,
        );
        expect(provider).toHaveBeenCalledTimes(1);
      }));
    it.each([
      'bytes',
      'recipient',
      'body',
      'cc',
      'bcc',
      'html',
      'headers',
      'from',
    ] as const)('refuses changed %s after trusted policy and before default provider', async (change) =>
      run(async () => {
        const outbox = service({
          name: 'tamper',
          async send(request) {
            const email = request.message as Email;
            if (change === 'bytes') request.attachments![0]!.content[0] = 0;
            if (change === 'recipient')
              email.setToAddresses([{ address: 'unapproved@example.com' }]);
            if (change === 'body') email.body = 'changed';
            if (change === 'cc')
              email.ccAddresses = '[{"address":"unapproved@example.com"}]';
            if (change === 'bcc')
              email.bccAddresses = '[{"address":"unapproved@example.com"}]';
            if (change === 'html') email.htmlBody = '<p>changed</p>';
            if (change === 'headers')
              email.headers = '{"Bcc":"unapproved@example.com"}';
            if (change === 'from') email.fromAddress = 'unapproved@example.com';
            return messageSendTransport.send(request);
          },
        });
        await enqueue(outbox);
        await outbox.dispatchDue({ tenantIds: [tenantId] });
        expect(provider).toHaveBeenCalledTimes(0);
      }));
    it('rechecks current persisted lease at actual provider handoff and refuses expired or replaced attempts', async () =>
      run(async () => {
        for (const kind of ['expired', 'replaced'] as const) {
          const outbox = service({
            name: kind,
            async send(request) {
              if (kind === 'expired')
                clock = new Date(clock.getTime() + 6 * 60_000);
              else
                await request.delivery.transition({
                  leaseToken: crypto.randomUUID(),
                });
              return messageSendTransport.send(request);
            },
          });
          await enqueue(outbox);
          await outbox.dispatchDue({ tenantIds: [tenantId] });
        }
        expect(provider).toHaveBeenCalledTimes(0);
      }));
    it('permits only one concurrent/reentrant handoff and deactivates inherited detached context', async () =>
      run(async () => {
        let detached: (() => Promise<unknown>) | undefined;
        const outbox = service({
          name: 'double',
          async send(request) {
            const options: SendEmailOptions = {
              attachments: request.attachments,
            };
            const results = await Promise.all([
              request.message.send(options),
              request.message.send(options),
            ]);
            expect(results.filter((result) => result.success)).toHaveLength(1);
            detached = () => request.message.send(options);
            return { status: 'accepted' };
          },
        });
        await enqueue(outbox);
        await outbox.dispatchDue({ tenantIds: [tenantId] });
        expect(provider).toHaveBeenCalledTimes(1);
        expect(await detached!()).toMatchObject({ success: false });
        expect(provider).toHaveBeenCalledTimes(1);
      }));
    it('does not let a detached task use inherited scope after a transport callback returned without a send', async () =>
      run(async () => {
        let finish: (() => void) | undefined;
        let result: Promise<unknown> | undefined;
        const gate = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const outbox = service({
          name: 'detached',
          async send(request) {
            result = gate.then(() =>
              request.message.send({
                attachments: request.attachments,
              } as SendEmailOptions),
            );
            return { status: 'accepted' };
          },
        });
        await enqueue(outbox);
        await outbox.dispatchDue({ tenantIds: [tenantId] });
        finish!();
        expect(await result).toMatchObject({ success: false });
        expect(provider).toHaveBeenCalledTimes(0);
      }));
    it('fresh outbox retries reauthorize bytes but unknown outcome cannot be resent directly', async () =>
      run(async () => {
        provider.mockRejectedValueOnce({ code: 'AUTHORIZATION_ERROR' });
        const policy = vi.fn(() => [
          {
            filename: 'invoice.pdf',
            contentType: 'application/pdf',
            content: BYTES,
          },
        ]);
        const outbox = service(undefined, {
          dispatchPolicies: { [POLICY]: { resolveAttachments: policy } },
        });
        const delivery = await enqueue(outbox);
        await outbox.dispatchDue({ tenantIds: [tenantId] });
        const row = (await (
          await NotificationDeliveryCollection.create({ db })
        ).get({ id: delivery.id }))!;
        const message = (await (
          await MessageCollection.create({ db })
        ).get({ id: row.messageId }))!;
        expect((await message.retrySend()).success).toBe(false);
        expect(provider).toHaveBeenCalledTimes(1);
        clock = new Date(clock.getTime() + 120_000);
        provider.mockRejectedValueOnce(
          new Error('connection lost after acceptance'),
        );
        await outbox.dispatchDue({ tenantIds: [tenantId] });
        expect(policy).toHaveBeenCalledTimes(2);
        expect(provider).toHaveBeenCalledTimes(2);
        expect(
          (await (
            await NotificationDeliveryCollection.create({ db })
          ).get({ id: delivery.id }))!.status,
        ).toBe('uncertain');
        const uncertainMessage = (await (
          await MessageCollection.create({ db })
        ).get({ id: row.messageId }))!;
        const metadata = uncertainMessage.getMetadata();
        delete metadata.sendOutcomeUnknown;
        uncertainMessage.setMetadata(metadata);
        await expect(uncertainMessage.save()).rejects.toThrow('lifecycle');
        clock = new Date(clock.getTime() + 600_000);
        await outbox.dispatchDue({ tenantIds: [tenantId] });
        expect(policy).toHaveBeenCalledTimes(2);
        expect(provider).toHaveBeenCalledTimes(2);
      }));
    it('blocks direct EmailSender calls and preserves durable provenance through collection deletion', async () =>
      run(async () => {
        const { message } = await parked();
        const account = (await message.getAccount()) as EmailAccount;
        const sender = new EmailSender({ send: provider } as never, account);
        const result = await sender.send(message as Email, {
          attachments: [
            {
              filename: 'invoice.pdf',
              contentType: 'application/pdf',
              content: BYTES,
            },
          ],
        });
        expect(result.success).toBe(false);
        expect(result.outcomeUnknown).not.toBe(true);
        await expect(
          (await MessageCollection.create({ db })).delete(message.id!),
        ).rejects.toThrow();
        expect(provider).toHaveBeenCalledTimes(0);
      }));
    it('checks actual fallback sender identity and owns the bytes passed to the SDK', async () =>
      run(async () => {
        vi.mocked(EmailAccount.prototype.createSender).mockImplementationOnce(
          async function (this: EmailAccount) {
            this.email = 'unapproved@example.com';
            return new EmailSender({ send: provider } as never, this);
          },
        );
        const tampered = service();
        await enqueue(tampered);
        await tampered.dispatchDue({ tenantIds: [tenantId] });
        expect(provider).toHaveBeenCalledTimes(0);
        let source: Uint8Array | undefined;
        const normal = service({
          name: 'own-bytes',
          async send(request) {
            source = request.attachments![0]!.content;
            return messageSendTransport.send(request);
          },
        });
        provider.mockImplementationOnce(
          async (envelope: { attachments: { content: Buffer }[] }) => {
            source!.fill(0);
            expect(envelope.attachments[0]!.content).toEqual(BYTES);
            return {
              messageId: 'capture-only',
              accepted: ['approved@example.com'],
              rejected: [],
              response: 'captured',
            };
          },
        );
        await enqueue(normal);
        await normal.dispatchDue({ tenantIds: [tenantId] });
        expect(provider).toHaveBeenCalledTimes(1);
      }));
    it('denies reentrant send while the current provider handoff is executing', async () =>
      run(async () => {
        let nested: { success: boolean } | undefined;
        let invoke: (() => Promise<{ success: boolean }>) | undefined;
        const outbox = service({
          name: 'reentrant',
          async send(request) {
            invoke = () =>
              request.message.send({
                attachments: request.attachments,
              } as SendEmailOptions);
            return messageSendTransport.send(request);
          },
        });
        provider.mockImplementationOnce(async () => {
          nested = await invoke!();
          return {
            messageId: 'capture-only',
            accepted: ['approved@example.com'],
            rejected: [],
            response: 'captured',
          };
        });
        await enqueue(outbox);
        await outbox.dispatchDue({ tenantIds: [tenantId] });
        expect(nested?.success).toBe(false);
        expect(provider).toHaveBeenCalledTimes(1);
      }));
    it('an active provider scope cannot mint an ordinary lifecycle rewrite', async () =>
      run(async () => {
        const outbox = service({
          name: 'no-save-authority',
          async send(request) {
            const result = await messageSendTransport.send(request);
            expect(result.status).toBe('accepted');
            request.message.sendStatus = 'failed';
            request.message.sendError = 'forged definite failure';
            await expect(request.message.save()).rejects.toThrow('lifecycle');
            await request.message.loadFromId();
            return result;
          },
        });
        await enqueue(outbox);
        await outbox.dispatchDue({ tenantIds: [tenantId] });
        expect(provider).toHaveBeenCalledTimes(1);
      }));
  });
}
