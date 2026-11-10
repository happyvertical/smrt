import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageCollection } from '../collections/MessageCollection.js';
import { NotificationDeliveryCollection } from '../collections/NotificationDeliveryCollection.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { NotificationDelivery } from '../models/NotificationDelivery.js';
import {
  messagingPrincipalFromPermissions,
  SEND_MESSAGES_PERMISSION,
} from '../permissions.js';
import {
  EmailSender,
  isDefiniteSendRejection,
} from '../senders/EmailSender.js';
import {
  buildNotificationLink,
  messageSendTransport,
  type NotificationEmailInput,
  NotificationOutboxDeniedError,
  type NotificationOutboxOptions,
  NotificationOutboxService,
  type NotificationTransport,
  type NotificationTransportOutcome,
  type NotificationTransportRequest,
  notificationDeliveryCorrelationId,
  notificationDeliveryMessageId,
} from '../services/NotificationOutboxService.js';

const BASE_URL = 'https://work.example.com';

interface FakeTransport extends NotificationTransport {
  calls: NotificationTransportRequest[];
}

function fakeTransport(
  respond: (
    request: NotificationTransportRequest,
    call: number,
  ) =>
    | Promise<NotificationTransportOutcome>
    | NotificationTransportOutcome = () => ({
    status: 'accepted',
    providerMessageId: 'provider-1',
  }),
  extra: Partial<NotificationTransport> = {},
): FakeTransport {
  const calls: NotificationTransportRequest[] = [];
  return {
    name: 'fake',
    calls,
    ...extra,
    async send(request) {
      calls.push(request);
      return respond(request, calls.length);
    },
  };
}

describe('NotificationOutboxService', () => {
  let db: DatabaseInterface;
  let clock: Date;
  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();
  const alice = crypto.randomUUID();
  const bob = crypto.randomUUID();
  const senders: Record<string, string> = {};
  const addresses: Record<string, string> = {
    [alice]: 'alice@example.com',
    [bob]: 'bob@example.com',
  };

  async function createSender(tenantId: string): Promise<string> {
    return withTenant({ tenantId }, async () => {
      const account = new EmailAccount({
        db,
        tenantId,
        name: 'Notifications',
        providerType: 'smtp',
        isActive: true,
      });
      await account.initialize();
      await account.save();
      return account.id as string;
    });
  }

  function service(
    overrides: Partial<NotificationOutboxOptions> = {},
  ): NotificationOutboxService {
    return new NotificationOutboxService({
      db,
      linkBaseUrl: BASE_URL,
      // Host policy: only Alice is a member of tenant A; Bob only of B.
      resolveRecipient: ({ tenantId, recipientUserId }) => {
        const member =
          (tenantId === tenantA && recipientUserId === alice) ||
          (tenantId === tenantB && recipientUserId === bob);
        return member ? { address: addresses[recipientUserId] ?? '' } : null;
      },
      resolveSenderAccountId: ({ tenantId }) => senders[tenantId] ?? null,
      now: () => clock,
      ...overrides,
    });
  }

  function input(
    overrides: Partial<NotificationEmailInput> = {},
  ): NotificationEmailInput {
    return {
      tenantId: tenantA,
      recipientUserId: alice,
      sourceRef: 'project-question:q1:asked',
      kind: 'project-question.asked',
      subject: 'A question is waiting for you',
      text: 'Your project has a question for you.',
      path: '/portal/projects/p1/questions#question-q1',
      ...overrides,
    };
  }

  async function deliveriesIn(tenantId: string) {
    return withTenant({ tenantId }, async () =>
      (await NotificationDeliveryCollection.create({ db })).list({
        where: { tenantId },
      }),
    );
  }

  async function reload(delivery: NotificationDelivery) {
    const rows = await withTenant({ tenantId: delivery.tenantId }, async () =>
      (await NotificationDeliveryCollection.create({ db })).list({
        where: { tenantId: delivery.tenantId, id: delivery.id },
      }),
    );
    return rows[0] as NotificationDelivery;
  }

  async function messagesFor(delivery: NotificationDelivery) {
    return withTenant({ tenantId: delivery.tenantId }, async () =>
      (await MessageCollection.create({ db })).list({
        where: {
          correlationId: notificationDeliveryCorrelationId(
            delivery.id as string,
          ),
        },
      }),
    );
  }

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    clock = new Date('2026-11-05T12:00:00.000Z');
    senders[tenantA] = await createSender(tenantA);
    senders[tenantB] = await createSender(tenantB);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close?.();
  });

  describe('scoped attachment dispatch', () => {
    it('selects exact delivery ids before pagination for pending and expired rows', async () => {
      const transport = fakeTransport();
      const outbox = service({ transport });
      const old = await outbox.enqueueEmail(input({ sourceRef: 'older' }));
      const expired = await outbox.enqueueEmail(
        input({ sourceRef: 'expired' }),
      );
      await withTenant({ tenantId: tenantA }, () =>
        expired.delivery.transition({
          status: 'sending',
          leaseToken: crypto.randomUUID(),
          leaseExpiresAt: new Date(clock.getTime() - 1),
          attempts: 1,
        }),
      );
      const chosen = await outbox.enqueueEmail(input({ sourceRef: 'chosen' }));
      await outbox.dispatchDue({
        tenantIds: [tenantA],
        deliveryIds: [chosen.delivery.id as string],
        limit: 1,
      });
      expect(transport.calls.map((call) => call.delivery.id)).toEqual([
        chosen.delivery.id,
      ]);
      expect((await reload(old.delivery)).status).toBe('pending');
      expect((await reload(expired.delivery)).status).toBe('sending');
      await outbox.dispatchDue({
        tenantIds: [tenantA],
        deliveryIds: [expired.delivery.id as string],
        limit: 1,
      });
      expect(transport.calls.map((call) => call.delivery.id)).toEqual([
        chosen.delivery.id,
        expired.delivery.id,
      ]);
    });

    it('empty and malformed selectors never dispatch, and foreign ids cannot cross tenant scope', async () => {
      const transport = fakeTransport();
      const outbox = service({ transport });
      await outbox.enqueueEmail(input());
      const foreign = await outbox.enqueueEmail(
        input({ tenantId: tenantB, recipientUserId: bob }),
      );
      expect((await outbox.dispatchDue({ deliveryIds: [] })).leased).toBe(0);
      await expect(
        outbox.dispatchDue({ deliveryIds: ['invalid'] }),
      ).rejects.toThrow();
      expect(
        (
          await outbox.dispatchDue({
            tenantIds: [tenantA],
            deliveryIds: [foreign.delivery.id as string],
          })
        ).leased,
      ).toBe(0);
      expect(transport.calls).toHaveLength(0);
    });

    it('denies principal scopes before loading or leasing and defaults to the principal tenant', async () => {
      const transport = fakeTransport();
      const seed = service();
      const own = await seed.enqueueEmail(input());
      const foreign = await seed.enqueueEmail(
        input({ tenantId: tenantB, recipientUserId: bob }),
      );
      const principal = messagingPrincipalFromPermissions(
        [SEND_MESSAGES_PERMISSION],
        { tenantId: tenantA },
      );
      const outbox = service({ transport, principal });
      const reads = vi.spyOn(NotificationDeliveryCollection.prototype, 'list');
      const discoverySql = vi.spyOn(db, 'query');
      await expect(
        outbox.dispatchDue({ tenantIds: [tenantA, tenantB] }),
      ).rejects.toThrow(NotificationOutboxDeniedError);
      expect(reads).not.toHaveBeenCalled();
      expect(discoverySql).not.toHaveBeenCalled();
      discoverySql.mockRestore();
      expect((await reload(own.delivery)).attempts).toBe(0);
      expect((await reload(foreign.delivery)).attempts).toBe(0);
      const denied = service({
        transport,
        principal: messagingPrincipalFromPermissions([], { tenantId: tenantA }),
      });
      reads.mockClear();
      await expect(
        denied.dispatchDue({ tenantIds: [tenantA] }),
      ).rejects.toThrow(NotificationOutboxDeniedError);
      expect(reads).not.toHaveBeenCalled();
      await outbox.dispatchDue();
      expect(transport.calls.map((call) => call.delivery.id)).toEqual([
        own.delivery.id,
      ]);
      expect((await reload(foreign.delivery)).status).toBe('pending');
    });

    it('resolves actual PDF bytes again on safe retry before provider handoff', async () => {
      const bytes = Buffer.from(
        '%PDF-1.7\nsynthetic immutable document\n%%EOF',
      );
      const attachment = {
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        content: bytes,
      };
      const resolveAttachments = vi.fn(
        async ({ delivery }: NotificationTransportRequest) => {
          expect(delivery.handedOffAt).toBeNull();
          return [attachment];
        },
      );
      const transport = fakeTransport((_request, call) =>
        call === 1
          ? { status: 'rejected', error: 'definite refusal', retryable: true }
          : { status: 'accepted' },
      );
      const outbox = service({ transport, resolveAttachments });
      await outbox.enqueueEmail(input());
      await outbox.dispatchDue();
      clock = new Date(clock.getTime() + 120_000);
      await outbox.dispatchDue();
      expect(resolveAttachments).toHaveBeenCalledTimes(2);
      expect(transport.calls).toHaveLength(2);
      expect(
        Buffer.from(transport.calls[1]?.attachments?.[0]?.content ?? []),
      ).toEqual(bytes);
    });

    it('forwards bytes through the default transport and reconciles unknown acceptance without a resend', async () => {
      const bytes = Buffer.from('%PDF-1.7\nretained\n%%EOF');
      const attachment = {
        filename: 'receipt.pdf',
        content: bytes,
        contentType: 'application/pdf',
      };
      const providerSend = vi.fn(async (_message, options) => {
        expect(Buffer.from(options.attachments[0].content)).toEqual(bytes);
        return {
          success: true,
          providerMessageId: 'capture-only',
          sentAt: clock,
        };
      });
      vi.spyOn(EmailAccount.prototype, 'createSender').mockResolvedValue({
        providerType: 'smtp',
        isReady: () => true,
        send: providerSend,
      });
      const outbox = service({ resolveAttachments: () => [attachment] });
      await outbox.enqueueEmail(input());
      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe('sent');
      expect(providerSend).toHaveBeenCalledTimes(1);
      expect((await outbox.dispatchDue()).leased).toBe(0);

      const resolver = vi.fn(() => [attachment]);
      const uncertain = fakeTransport(() => ({
        status: 'unknown',
        error: 'lost response',
      }));
      const other = service({
        transport: uncertain,
        resolveAttachments: resolver,
      });
      await other.enqueueEmail(input({ sourceRef: 'uncertain-document' }));
      expect((await other.dispatchDue()).outcomes[0]?.outcome).toBe(
        'uncertain',
      );
      clock = new Date(clock.getTime() + 3_600_000);
      expect((await other.dispatchDue()).leased).toBe(0);
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(uncertain.calls).toHaveLength(1);
    });

    it('requires explicit scopes for unscoped principals and rejects malformed attachment metadata', async () => {
      const transport = fakeTransport();
      const principal = messagingPrincipalFromPermissions([
        SEND_MESSAGES_PERMISSION,
      ]);
      await expect(
        service({ transport, principal }).dispatchDue(),
      ).rejects.toThrow(NotificationOutboxDeniedError);
      const invalid = service({
        transport,
        resolveAttachments: async () => [
          { filename: 'invoice.pdf', content: 'file:///private.pdf' as never },
        ],
      });
      const { delivery } = await invalid.enqueueEmail(input());
      await invalid.dispatchDue({
        tenantIds: [tenantA],
        deliveryIds: [delivery.id as string],
      });
      expect(transport.calls).toHaveLength(0);
      expect(await reload(delivery)).toMatchObject({
        status: 'pending',
        handedOffAt: null,
      });
    });

    it('unreadable or malformed attachment resolution never reaches a provider', async () => {
      const transport = fakeTransport();
      const outbox = service({
        transport,
        resolveAttachments: async () => {
          throw new Error('private artifact revoked');
        },
      });
      const { delivery } = await outbox.enqueueEmail(input());
      await outbox.dispatchDue();
      expect(transport.calls).toHaveLength(0);
      expect(await reload(delivery)).toMatchObject({
        status: 'pending',
        handedOffAt: null,
      });
      const malformed = service({
        transport,
        resolveAttachments: async () => undefined as never,
      });
      clock = new Date(clock.getTime() + 120_000);
      await malformed.dispatchDue();
      expect(transport.calls).toHaveLength(0);
    });
  });

  describe('required dispatch policy', () => {
    const policyId = 'fixture.invoice.v1';
    const bytes = Buffer.from('%PDF-1.7\nprotected synthetic invoice\n%%EOF');
    const protectedInput = () =>
      input({
        kind: `protected:${policyId}`,
        requiredDispatchPolicy: policyId,
        dispatchPolicyBinding: {
          artifact: 'retained-document',
          version: 1,
          digest: 'fixture-sha256',
          recipientUserId: alice,
        },
      });
    const policy = {
      resolveAttachments: async ({
        delivery,
      }: NotificationTransportRequest) => {
        const binding =
          typeof delivery.dispatchPolicyBinding === 'string'
            ? JSON.parse(delivery.dispatchPolicyBinding)
            : delivery.dispatchPolicyBinding;
        if (
          binding.recipientUserId !== delivery.recipientUserId ||
          binding.artifact !== 'retained-document' ||
          binding.version !== 1
        )
          throw new Error('approved artifact binding changed');
        return [
          {
            filename: 'invoice.pdf',
            contentType: 'application/pdf',
            content: bytes,
          },
        ];
      },
    };

    it('blocks a broad default dispatcher before leases/provider calls, then allows the exact trusted policy', async () => {
      const transport = fakeTransport();
      const owner = service({
        transport,
        dispatchPolicies: { [policyId]: policy },
      });
      const { delivery } = await owner.enqueueEmail(protectedInput());
      const report = await service({ transport }).dispatchDue();
      expect(report).toMatchObject({
        leased: 0,
        outcomes: [{ outcome: 'blocked' }],
      });
      expect(await reload(delivery)).toMatchObject({
        status: 'pending',
        attempts: 0,
        handedOffAt: null,
      });
      expect(transport.calls).toHaveLength(0);
      await owner.dispatchDue({
        tenantIds: [tenantA],
        deliveryIds: [delivery.id as string],
      });
      expect(transport.calls).toHaveLength(1);
      expect(
        Buffer.from(transport.calls[0]?.attachments?.[0]?.content ?? []),
      ).toEqual(bytes);
    });

    it('requires recognized policy and binding at enqueue, and denies empty/mismatched policy output', async () => {
      await expect(service().enqueueEmail(protectedInput())).rejects.toThrow();
      const transport = fakeTransport();
      const owner = service({
        transport,
        dispatchPolicies: { [policyId]: policy },
      });
      await expect(
        owner.enqueueEmail({ ...protectedInput(), dispatchPolicyBinding: {} }),
      ).rejects.toThrow();
      const { delivery } = await owner.enqueueEmail(protectedInput());
      const empty = service({
        transport,
        dispatchPolicies: { [policyId]: { resolveAttachments: () => [] } },
      });
      await empty.dispatchDue();
      expect(transport.calls).toHaveLength(0);
      expect(await reload(delivery)).toMatchObject({
        status: 'pending',
        handedOffAt: null,
      });
    });

    it('protects persisted consent and rejects policy removal on new protected clones', async () => {
      const owner = service({ dispatchPolicies: { [policyId]: policy } });
      const { delivery } = await owner.enqueueEmail(protectedInput());
      for (const changes of [
        { requiredDispatchPolicy: '' },
        { recipientAddress: 'other@example.com' },
        { dispatchPolicyBinding: '{}' },
        { kind: 'ordinary' },
        { sourceRef: 'different' },
        { textBody: 'different' },
      ]) {
        const row = await reload(delivery);
        Object.assign(row, changes);
        await expect(
          withTenant({ tenantId: tenantA }, () => row.save()),
        ).rejects.toThrow(/immutable|exact dispatch policy/);
      }
      const lifecycle = await reload(delivery);
      lifecycle.status = 'sent';
      await expect(
        withTenant({ tenantId: tenantA }, () => lifecycle.save()),
      ).rejects.toThrow('guarded transition');
      await expect(
        owner.enqueueEmail({
          ...protectedInput(),
          requiredDispatchPolicy: undefined,
        }),
      ).rejects.toThrow();
      const clone = new NotificationDelivery({
        db,
        id: crypto.randomUUID(),
        tenantId: tenantA,
        recipientUserId: alice,
        kind: `protected:${policyId}`,
        sourceRef: 'clone',
        requiredDispatchPolicy: '',
      });
      await clone.initialize();
      await expect(
        withTenant({ tenantId: tenantA }, () => clone.save()),
      ).rejects.toThrow('exact dispatch policy');
    });
  });

  describe('enqueue', () => {
    it('stores one delivery per source event, returning the first untouched', async () => {
      const outbox = service({ transport: fakeTransport() });
      const first = await outbox.enqueueEmail(input());
      expect(first.created).toBe(true);
      expect(first.delivery).toMatchObject({
        status: 'pending',
        channel: 'email',
        recipientAddress: 'alice@example.com',
        accountId: senders[tenantA],
        attempts: 0,
      });

      const again = await outbox.enqueueEmail(
        input({ subject: 'Changed', path: '/elsewhere' }),
      );
      expect(again.created).toBe(false);
      expect(again.delivery.id).toBe(first.delivery.id);
      expect(again.delivery.subject).toBe('A question is waiting for you');
      expect(again.delivery.href).toBe(first.delivery.href);

      // A new reminder ordinal is a new event.
      const reminder = await outbox.enqueueEmail(
        input({ sourceRef: 'project-question:q1:reminder:1' }),
      );
      expect(reminder.created).toBe(true);
      expect(await deliveriesIn(tenantA)).toHaveLength(2);
    });

    it('concurrent enqueues of one event store a single delivery', async () => {
      const outbox = service({ transport: fakeTransport() });
      const results = await Promise.all(
        Array.from({ length: 4 }, () => outbox.enqueueEmail(input())),
      );
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.delivery.id)).size).toBe(1);
      expect(await deliveriesIn(tenantA)).toHaveLength(1);
    });

    it('a racing insert that loses returns the stored winner', async () => {
      const outbox = service({ transport: fakeTransport() });
      const winner = await outbox.enqueueEmail(input());
      vi.spyOn(
        NotificationDeliveryCollection.prototype,
        'list',
      ).mockResolvedValueOnce([]);
      const loser = await outbox.enqueueEmail(input({ subject: 'Loser' }));
      expect(loser.created).toBe(false);
      expect(loser.delivery.id).toBe(winner.delivery.id);
      expect(loser.delivery.subject).toBe('A question is waiting for you');
    });

    it('builds stable deep links on the configured origin only', async () => {
      const outbox = service({ transport: fakeTransport() });
      const { delivery } = await outbox.enqueueEmail(input());
      expect(delivery.href).toBe(
        'https://work.example.com/portal/projects/p1/questions#question-q1',
      );
      expect(
        buildNotificationLink('https://example.com/app/', '/inbox?tab=open'),
      ).toBe('https://example.com/app/inbox?tab=open');

      for (const path of [
        '//evil.example/phish',
        'https://evil.example/',
        '/\\evil.example',
        'relative/path',
        '/has space',
        '/line\nbreak',
      ]) {
        await expect(
          outbox.enqueueEmail(input({ sourceRef: `bad:${path}`, path })),
        ).rejects.toMatchObject({ reason: 'link' });
      }
      expect(() =>
        service({ linkBaseUrl: 'https://user:pw@example.com' }),
      ).toThrow(/credentials/);
      expect(() => service({ linkBaseUrl: 'javascript:alert(1)' })).toThrow(
        /http or https/,
      );
      expect(await deliveriesIn(tenantA)).toHaveLength(1);
    });

    it('rejects multi-line subjects (header injection)', async () => {
      const outbox = service({ transport: fakeTransport() });
      await expect(
        outbox.enqueueEmail(input({ subject: 'Hi\r\nBcc: x@evil.example' })),
      ).rejects.toThrow(/single line/);
    });
  });

  describe('host authorization and tenant denial', () => {
    it('denies recipients the host does not authorize, storing nothing', async () => {
      const outbox = service({ transport: fakeTransport() });
      await expect(
        outbox.enqueueEmail(input({ recipientUserId: bob })),
      ).rejects.toBeInstanceOf(NotificationOutboxDeniedError);
      await expect(
        outbox.enqueueEmail(input({ recipientUserId: bob })),
      ).rejects.toMatchObject({ reason: 'recipient' });
      expect(await deliveriesIn(tenantA)).toHaveLength(0);
    });

    it('denies a principal without messages.send in the tenant', async () => {
      const withoutPermission = service({
        transport: fakeTransport(),
        principal: messagingPrincipalFromPermissions([], { tenantId: tenantA }),
      });
      await expect(
        withoutPermission.enqueueEmail(input()),
      ).rejects.toMatchObject({ reason: 'permission' });

      const otherTenant = service({
        transport: fakeTransport(),
        principal: messagingPrincipalFromPermissions(
          [SEND_MESSAGES_PERMISSION],
          { tenantId: tenantB },
        ),
      });
      await expect(otherTenant.enqueueEmail(input())).rejects.toMatchObject({
        reason: 'permission',
      });

      const allowed = service({
        transport: fakeTransport(),
        principal: messagingPrincipalFromPermissions(
          [SEND_MESSAGES_PERMISSION],
          { tenantId: tenantA },
        ),
      });
      await expect(allowed.enqueueEmail(input())).resolves.toMatchObject({
        created: true,
      });
    });

    it("denies another tenant's sender account", async () => {
      const outbox = service({
        transport: fakeTransport(),
        resolveSenderAccountId: () => senders[tenantB] ?? null,
      });
      await expect(outbox.enqueueEmail(input())).rejects.toMatchObject({
        reason: 'sender',
      });
      expect(await deliveriesIn(tenantA)).toHaveLength(0);
    });

    it('dispatches only the requested tenants', async () => {
      const transport = fakeTransport();
      const outbox = service({ transport });
      const a = await outbox.enqueueEmail(input());
      const b = await outbox.enqueueEmail(
        input({ tenantId: tenantB, recipientUserId: bob }),
      );

      const onlyA = await outbox.dispatchDue({ tenantIds: [tenantA] });
      expect(onlyA.outcomes).toEqual([
        { deliveryId: a.delivery.id, tenantId: tenantA, outcome: 'sent' },
      ]);
      expect((await reload(b.delivery)).status).toBe('pending');

      // Without tenantIds the dispatcher discovers every tenant's due rows,
      // still sending each under its own tenant.
      const all = await outbox.dispatchDue();
      expect(all.outcomes).toEqual([
        { deliveryId: b.delivery.id, tenantId: tenantB, outcome: 'sent' },
      ]);
      expect(transport.calls.map((call) => call.message.tenantId)).toEqual([
        tenantA,
        tenantB,
      ]);
    });
  });

  describe('dispatch', () => {
    it('creates one outbound email with the deep link and sends it once', async () => {
      const transport = fakeTransport();
      const outbox = service({ transport });
      const { delivery } = await outbox.enqueueEmail(input());

      const report = await outbox.dispatchDue({ tenantIds: [tenantA] });
      expect(report).toMatchObject({ leased: 1 });
      expect(report.outcomes[0]?.outcome).toBe('sent');
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]?.idempotencyKey).toBe(
        `notification-delivery:${delivery.id}`,
      );

      const sent = await reload(delivery);
      expect(sent).toMatchObject({
        status: 'sent',
        providerMessageId: 'provider-1',
        leaseToken: null,
        attempts: 1,
      });
      expect(sent.deliveredAt).toEqual(clock);

      const messages = await messagesFor(delivery);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.id).toBe(sent.messageId);
      expect(messages[0]?.getToAddresses()).toEqual([
        { address: 'alice@example.com' },
      ]);
      expect(messages[0]?.body).toContain(
        'https://work.example.com/portal/projects/p1/questions#question-q1',
      );

      expect(await outbox.dispatchDue({ tenantIds: [tenantA] })).toEqual({
        leased: 0,
        outcomes: [],
      });
      expect(transport.calls).toHaveLength(1);
    });

    it('a stale dispatcher resuming after takeover creates no second email', async () => {
      // Dispatcher 1 stalls in its suppression check (after leasing, before
      // creating the email); its lease lapses and dispatcher 2 delivers.
      let stall: () => void = () => {};
      const stalled = new Promise<void>((resolve) => {
        stall = resolve;
      });
      let checks = 0;
      const transport = fakeTransport();
      const slow = service({
        transport,
        isSuppressed: async () => {
          checks += 1;
          if (checks === 2) await stalled; // the dispatch-time check
          return false;
        },
      });
      const { delivery } = await slow.enqueueEmail(input());
      const first = slow.dispatchDue();
      await vi.waitFor(() => expect(checks).toBe(2));

      clock = new Date(clock.getTime() + 10 * 60_000);
      expect(
        (await service({ transport }).dispatchDue()).outcomes[0]?.outcome,
      ).toBe('sent');
      // Make the stale dispatcher miss the stored email in its lookup, as if
      // it had looked before dispatcher 2 inserted: its insert must collide.
      const lookup = vi
        .spyOn(MessageCollection.prototype, 'get')
        .mockResolvedValueOnce(null);
      stall();
      expect((await first).outcomes[0]?.outcome).toBe('lease-lost');
      expect(lookup).toHaveBeenCalled();
      lookup.mockRestore();

      const messages = await messagesFor(delivery);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.id).toBe(
        await notificationDeliveryMessageId(delivery.id as string),
      );
      expect(transport.calls).toHaveLength(1);
    });

    it('waits for notBefore', async () => {
      const transport = fakeTransport();
      const outbox = service({ transport });
      await outbox.enqueueEmail(
        input({ notBefore: new Date(clock.getTime() + 60_000) }),
      );
      expect((await outbox.dispatchDue()).leased).toBe(0);
      clock = new Date(clock.getTime() + 60_000);
      expect((await outbox.dispatchDue()).leased).toBe(1);
      expect(transport.calls).toHaveLength(1);
    });

    it('concurrent dispatchers deliver each row exactly once', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const transport = fakeTransport(async () => {
        await gate;
        return { status: 'accepted' };
      });
      const outbox = service({ transport });
      await outbox.enqueueEmail(input());
      await outbox.enqueueEmail(input({ sourceRef: 'event:2' }));

      const racing = Promise.all([
        outbox.dispatchDue({ tenantIds: [tenantA] }),
        service({ transport }).dispatchDue({ tenantIds: [tenantA] }),
        service({ transport }).dispatchDue(),
      ]);
      // Let every dispatcher reach its lease attempt before any send returns.
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      const reports = await racing;

      expect(reports.reduce((sum, report) => sum + report.leased, 0)).toBe(2);
      expect(transport.calls).toHaveLength(2);
      expect(
        new Set(transport.calls.map((call) => call.delivery.id)).size,
      ).toBe(2);
      const rows = await deliveriesIn(tenantA);
      expect(rows.map((row) => row.status)).toEqual(['sent', 'sent']);
      for (const row of rows) expect(await messagesFor(row)).toHaveLength(1);
    });

    it('attempts each delivery only once per sweep even when a zero-delay retry moves to a later page', async () => {
      const transport = fakeTransport(() => ({
        status: 'rejected',
        error: 'Definite refusal',
        retryable: true,
      }));
      const outbox = service({ transport, retryDelayMs: () => 0 });
      const { delivery } = await outbox.enqueueEmail(
        input({ notBefore: new Date(clock.getTime() - 1000) }),
      );
      const report = await outbox.dispatchDue({
        tenantIds: [tenantA],
        limit: 2,
      });
      expect(report.leased).toBe(1);
      expect(transport.calls).toHaveLength(1);
      expect(await reload(delivery)).toMatchObject({
        status: 'pending',
        attempts: 1,
      });
    });

    it('retries provider failures with backoff, then fails for good', async () => {
      const transport = fakeTransport(() => ({
        status: 'rejected',
        error: 'SMTP 451 try later',
        retryable: true,
      }));
      const outbox = service({ transport, maxAttempts: 3 });
      const { delivery } = await outbox.enqueueEmail(input());

      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe(
        'retry-scheduled',
      );
      let row = await reload(delivery);
      expect(row).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastError: 'SMTP 451 try later',
        leaseToken: null,
      });
      expect(row.nextAttemptAt.getTime()).toBe(clock.getTime() + 60_000);

      // Not due yet.
      expect((await outbox.dispatchDue()).leased).toBe(0);

      clock = new Date(clock.getTime() + 60_000);
      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe(
        'retry-scheduled',
      );
      row = await reload(delivery);
      expect(row.nextAttemptAt.getTime()).toBe(clock.getTime() + 120_000);

      clock = new Date(clock.getTime() + 120_000);
      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe('failed');
      row = await reload(delivery);
      expect(row).toMatchObject({ status: 'failed', attempts: 3 });
      expect(transport.calls).toHaveLength(3);
      // Every attempt reused the delivery's single message.
      expect(await messagesFor(delivery)).toHaveLength(1);
    });

    it('fails a non-retryable rejection immediately', async () => {
      const transport = fakeTransport(() => ({
        status: 'rejected',
        error: 'SMTP 550 no such user',
        retryable: false,
      }));
      const outbox = service({ transport });
      const { delivery } = await outbox.enqueueEmail(input());
      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe('failed');
      expect(await reload(delivery)).toMatchObject({
        status: 'failed',
        lastError: 'SMTP 550 no such user',
      });
    });

    it('honours the suppression hook at enqueue and before handoff', async () => {
      const transport = fakeTransport();
      let optedOut = true;
      const outbox = service({ transport, isSuppressed: () => optedOut });
      const suppressed = await outbox.enqueueEmail(input());
      expect(suppressed.delivery.status).toBe('cancelled');

      optedOut = false;
      const later = await outbox.enqueueEmail(input({ sourceRef: 'event:2' }));
      expect(later.delivery.status).toBe('pending');
      optedOut = true;
      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe(
        'cancelled',
      );
      expect(transport.calls).toHaveLength(0);
    });
  });

  describe('crash recovery and uncertain acceptance', () => {
    async function leaseAndCrash(
      delivery: NotificationDelivery,
      { handedOff }: { handedOff: boolean },
    ) {
      // A dispatcher leased the row and died; its lease has since lapsed.
      const row = await reload(delivery);
      await withTenant({ tenantId: row.tenantId }, () =>
        row.transition({
          status: 'sending',
          leaseToken: crypto.randomUUID(),
          leaseExpiresAt: new Date(clock.getTime() - 1),
          attempts: row.attempts + 1,
          handedOffAt: handedOff ? new Date(clock.getTime() - 10_000) : null,
        }),
      );
    }

    it('a live lease is never taken over', async () => {
      const transport = fakeTransport();
      const outbox = service({ transport });
      const { delivery } = await outbox.enqueueEmail(input());
      const row = await reload(delivery);
      await withTenant({ tenantId: tenantA }, () =>
        row.transition({
          status: 'sending',
          leaseToken: crypto.randomUUID(),
          leaseExpiresAt: new Date(clock.getTime() + 60_000),
          attempts: 1,
        }),
      );
      expect((await outbox.dispatchDue()).leased).toBe(0);
      expect(transport.calls).toHaveLength(0);
    });

    it('resends a lapsed lease that never reached the provider', async () => {
      const transport = fakeTransport();
      const outbox = service({ transport });
      const { delivery } = await outbox.enqueueEmail(input());
      await leaseAndCrash(delivery, { handedOff: false });

      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe('sent');
      expect(transport.calls).toHaveLength(1);
      expect(await reload(delivery)).toMatchObject({
        status: 'sent',
        attempts: 2,
      });
    });

    it('records an unknown handoff as uncertain and never resends it', async () => {
      const transport = fakeTransport();
      const outbox = service({ transport });
      const { delivery } = await outbox.enqueueEmail(input());
      await leaseAndCrash(delivery, { handedOff: true });

      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe(
        'uncertain',
      );
      expect(transport.calls).toHaveLength(0);
      expect((await outbox.dispatchDue()).leased).toBe(0);

      const uncertain = await outbox.listUncertain({ tenantId: tenantA });
      expect(uncertain.map((row) => row.id)).toEqual([delivery.id]);
      expect(uncertain[0]?.lastError).toMatch(/outcome unknown/);

      expect(
        await outbox.reconcile({
          tenantId: tenantA,
          deliveryId: delivery.id as string,
          outcome: 'sent',
          note: 'Confirmed in the provider log.',
        }),
      ).toBe(true);
      expect(await reload(delivery)).toMatchObject({ status: 'sent' });
      // Malformed ids match nothing instead of failing the query.
      expect(
        await outbox.reconcile({
          tenantId: tenantA,
          deliveryId: "1' OR '1'='1",
          outcome: 'retry',
        }),
      ).toBe(false);
      // Only uncertain rows reconcile.
      expect(
        await outbox.reconcile({
          tenantId: tenantA,
          deliveryId: delivery.id as string,
          outcome: 'retry',
        }),
      ).toBe(false);
    });

    it('a thrown send after handoff is uncertain; reconcile retry resends', async () => {
      const transport = fakeTransport((_request, call) => {
        if (call === 1) throw new Error('socket hang up');
        return { status: 'accepted' };
      });
      const outbox = service({ transport, maxAttempts: 1 });
      const { delivery } = await outbox.enqueueEmail(input());
      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe(
        'uncertain',
      );
      expect(
        await outbox.reconcile({
          tenantId: tenantA,
          deliveryId: delivery.id as string,
          outcome: 'retry',
        }),
      ).toBe(true);
      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe('sent');
      expect(transport.calls).toHaveLength(2);
      expect(await messagesFor(delivery)).toHaveLength(1);
    });

    it('an idempotent transport resends an unknown handoff with the same key', async () => {
      const transport = fakeTransport(undefined, { idempotent: true });
      const outbox = service({ transport });
      const { delivery } = await outbox.enqueueEmail(input());
      await leaseAndCrash(delivery, { handedOff: true });

      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe('sent');
      expect(transport.calls[0]?.idempotencyKey).toBe(
        `notification-delivery:${delivery.id}`,
      );
    });

    it('reconciles a provider acceptance that a crash left unrecorded', async () => {
      // Default transport over a stubbed account sender: the provider accepts,
      // Message.send() records 'sent', then the dispatcher dies before it
      // settles the delivery.
      const providerSend = vi.fn(async () => ({
        success: true,
        providerMessageId: '<abc@smtp>',
        sentAt: new Date(),
      }));
      vi.spyOn(EmailAccount.prototype, 'createSender').mockResolvedValue({
        providerType: 'smtp',
        isReady: () => true,
        send: providerSend,
      });
      const outbox = service({ transport: messageSendTransport });
      const { delivery } = await outbox.enqueueEmail(input());

      const transition = NotificationDelivery.prototype.transition;
      const crash = vi
        .spyOn(NotificationDelivery.prototype, 'transition')
        .mockImplementation(function (
          this: NotificationDelivery,
          changes,
          expected,
        ) {
          if (changes.status === 'sent') throw new Error('process killed');
          return transition.call(this, changes, expected);
        });
      await expect(outbox.dispatchDue()).rejects.toThrow('process killed');
      crash.mockRestore();
      expect(providerSend).toHaveBeenCalledTimes(1);
      expect(await reload(delivery)).toMatchObject({ status: 'sending' });

      // The lease lapses; recovery reads the message's own outcome.
      clock = new Date(clock.getTime() + 10 * 60_000);
      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe('sent');
      expect(providerSend).toHaveBeenCalledTimes(1);
      expect(await reload(delivery)).toMatchObject({ status: 'sent' });
    });

    it('the default transport retries a recorded provider failure', async () => {
      const providerSend = vi
        .fn()
        .mockResolvedValueOnce({
          success: false,
          error: 'SMTP 421',
          sentAt: new Date(),
        })
        .mockResolvedValueOnce({ success: true, sentAt: new Date() });
      vi.spyOn(EmailAccount.prototype, 'createSender').mockResolvedValue({
        providerType: 'smtp',
        isReady: () => true,
        send: providerSend,
      });
      const outbox = service({ transport: messageSendTransport });
      const { delivery } = await outbox.enqueueEmail(input());

      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe(
        'retry-scheduled',
      );
      clock = new Date(clock.getTime() + 60_000);
      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe('sent');
      expect(providerSend).toHaveBeenCalledTimes(2);
      const [message] = await messagesFor(delivery);
      expect(message?.sendStatus).toBe('sent');
    });

    it('parks an ambiguous provider error from the default transport', async () => {
      // A real EmailSender over a client whose connection drops mid-send:
      // the provider may have taken the message, so it is never resent.
      const clientSend = vi.fn(async () => {
        throw Object.assign(new Error('Connection closed unexpectedly'), {
          code: 'CONNECTION_ERROR',
          cause: Object.assign(new Error('socket hang up'), {
            code: 'ECONNRESET',
          }),
        });
      });
      vi.spyOn(EmailAccount.prototype, 'createSender').mockImplementation(
        async function (this: EmailAccount) {
          return new EmailSender(
            { send: clientSend } as unknown as ConstructorParameters<
              typeof EmailSender
            >[0],
            this,
          );
        },
      );
      const outbox = service({ transport: messageSendTransport });
      const { delivery } = await outbox.enqueueEmail(input());

      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe(
        'uncertain',
      );
      const [message] = await messagesFor(delivery);
      expect(message?.sendStatus).toBe('failed');
      expect(message?.isSendOutcomeUnknown()).toBe(true);
      clock = new Date(clock.getTime() + 60 * 60_000);
      expect((await outbox.dispatchDue()).leased).toBe(0);
      expect(clientSend).toHaveBeenCalledTimes(1);
    });

    it('a crash after an ambiguous failure was recorded stays uncertain', async () => {
      const providerSend = vi.fn(async () => ({
        success: false,
        error: 'timeout',
        outcomeUnknown: true,
        sentAt: new Date(),
      }));
      vi.spyOn(EmailAccount.prototype, 'createSender').mockResolvedValue({
        providerType: 'smtp',
        isReady: () => true,
        send: providerSend,
      });
      const outbox = service({ transport: messageSendTransport });
      const { delivery } = await outbox.enqueueEmail(input());
      const transition = NotificationDelivery.prototype.transition;
      const crash = vi
        .spyOn(NotificationDelivery.prototype, 'transition')
        .mockImplementation(function (
          this: NotificationDelivery,
          changes,
          expected,
        ) {
          if (changes.status === 'uncertain') throw new Error('process killed');
          return transition.call(this, changes, expected);
        });
      await expect(outbox.dispatchDue()).rejects.toThrow('process killed');
      crash.mockRestore();

      clock = new Date(clock.getTime() + 10 * 60_000);
      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe(
        'uncertain',
      );
      expect(providerSend).toHaveBeenCalledTimes(1);
    });

    it('operator retry releases a message a crash left claimed and sends once more', async () => {
      // The dispatcher dies inside the provider call: Message stays 'sending'.
      const providerSend = vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce({ success: true, sentAt: new Date() });
      vi.spyOn(EmailAccount.prototype, 'createSender').mockResolvedValue({
        providerType: 'smtp',
        isReady: () => true,
        send: providerSend,
      });
      const outbox = service({ transport: messageSendTransport });
      const { delivery } = await outbox.enqueueEmail(input());
      void outbox.dispatchDue(); // never settles: the "dead" dispatcher
      await vi.waitFor(() => expect(providerSend).toHaveBeenCalledTimes(1));
      expect((await messagesFor(delivery))[0]?.sendStatus).toBe('sending');

      clock = new Date(clock.getTime() + 10 * 60_000);
      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe(
        'uncertain',
      );
      expect(
        await outbox.reconcile({
          tenantId: tenantA,
          deliveryId: delivery.id as string,
          outcome: 'retry',
          note: 'Not in the provider log.',
        }),
      ).toBe(true);
      const released = (await messagesFor(delivery))[0];
      expect(released?.sendStatus).toBe('failed');

      expect((await outbox.dispatchDue()).outcomes[0]?.outcome).toBe('sent');
      expect(providerSend).toHaveBeenCalledTimes(2);
      expect(await messagesFor(delivery)).toHaveLength(1);
      expect((await messagesFor(delivery))[0]?.sendStatus).toBe('sent');
    });
  });

  describe('isDefiniteSendRejection', () => {
    it('separates refused sends from ones the provider may have accepted', () => {
      const withCause = (cause: object, code = 'SMTP_ERROR') =>
        Object.assign(new Error('x'), { code, cause });
      // Definite: an SMTP reply, an auth/validation failure, never connected.
      expect(isDefiniteSendRejection(withCause({ responseCode: 550 }))).toBe(
        true,
      );
      expect(
        isDefiniteSendRejection(withCause({}, 'AUTHENTICATION_ERROR')),
      ).toBe(true);
      expect(
        isDefiniteSendRejection(
          withCause({ code: 'ECONNREFUSED' }, 'CONNECTION_ERROR'),
        ),
      ).toBe(true);
      expect(
        isDefiniteSendRejection(
          Object.assign(new Error('x'), { code: 'SEND_ERROR', accepted: [] }),
        ),
      ).toBe(true);
      // Unknown: timeouts, resets, partial acceptance, anything unclassified.
      expect(
        isDefiniteSendRejection(
          withCause({ code: 'ETIMEDOUT' }, 'TIMEOUT_ERROR'),
        ),
      ).toBe(false);
      expect(
        isDefiniteSendRejection(
          withCause({ code: 'ECONNRESET' }, 'CONNECTION_ERROR'),
        ),
      ).toBe(false);
      expect(
        isDefiniteSendRejection(
          Object.assign(new Error('x'), {
            code: 'SEND_ERROR',
            accepted: ['a@example.com'],
          }),
        ),
      ).toBe(false);
      expect(isDefiniteSendRejection(new Error('boom'))).toBe(false);
      expect(isDefiniteSendRejection('boom')).toBe(false);
    });
  });
});
