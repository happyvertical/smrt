/**
 * SupportIntakeService tests (#1926): deterministic create-or-join over both
 * wired channels — chat rooms and email accounts — plus the opt-in ambient
 * interceptor. Covers binding gates, idempotent re-ingestion, thread joins,
 * reopen-on-resolved, self-address skips, and unresolved-client parking.
 */

import {
  createInterceptorContext,
  GlobalInterceptors,
} from '@happyvertical/smrt-core';
import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  registerSupportIntake,
  SupportIntakeService,
} from './support-intake-service.js';

const MODEL_NAMES = [
  'SupportCase',
  'SupportInteraction',
  'SupportCaseEvent',
  'SupportWorkLink',
  'SupportPlan',
  'SupportChannelBinding',
];

describe('SupportIntakeService', () => {
  let ctx: Awaited<ReturnType<typeof createIsolatedTestDbFromManifest>>;
  let intake: SupportIntakeService;

  beforeEach(async () => {
    ctx = await createIsolatedTestDbFromManifest({
      includeObjects: MODEL_NAMES,
    });
    intake = await SupportIntakeService.create({ db: ctx.db });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  describe('chat intake', () => {
    async function bindRoom(roomId = 'room-1') {
      return intake.bindings.create({
        name: `binding ${roomId}`,
        bindingKind: 'chat_room',
        channelKind: 'chat',
        targetType: '@happyvertical/smrt-chat:ChatRoom',
        targetId: roomId,
        clientProfileId: 'client-org-1',
        projectId: 'project-1',
      });
    }

    it('creates a case from the first message and joins subsequent ones', async () => {
      await bindRoom();
      const first = await intake.ingestChatMessage({
        messageId: 'msg-1',
        roomId: 'room-1',
        senderProfileId: 'person-1',
        content: 'The site is down!',
      });
      expect(first.outcome).toBe('created');
      expect(first.supportCase?.subject).toBe('The site is down!');
      expect(first.supportCase?.clientProfileId).toBe('client-org-1');
      expect(first.supportCase?.projectId).toBe('project-1');
      expect(first.supportCase?.channelKind).toBe('chat');

      const second = await intake.ingestChatMessage({
        messageId: 'msg-2',
        roomId: 'room-1',
        senderProfileId: 'person-1',
        content: 'Any update?',
      });
      expect(second.outcome).toBe('joined');
      expect(second.supportCase?.id).toBe(first.supportCase?.id);

      const interactions = await intake.caseService.interactions.forCase(
        first.supportCase?.id ?? '',
      );
      expect(interactions).toHaveLength(2);
    });

    it('is idempotent when the same message is ingested twice', async () => {
      await bindRoom();
      await intake.ingestChatMessage({
        messageId: 'msg-1',
        roomId: 'room-1',
        senderProfileId: 'person-1',
        content: 'hello',
      });
      const replay = await intake.ingestChatMessage({
        messageId: 'msg-1',
        roomId: 'room-1',
        senderProfileId: 'person-1',
        content: 'hello',
      });
      expect(replay.outcome).toBe('joined');
      expect(replay.reason).toBe('duplicate-source');

      const cases = await intake.caseService.cases.findQueue({});
      expect(cases).toHaveLength(1);
      const interactions = await intake.caseService.interactions.forCase(
        cases[0]?.id ?? '',
      );
      expect(interactions).toHaveLength(1);
    });

    it('opens distinct cases per thread within one room', async () => {
      await bindRoom();
      const main = await intake.ingestChatMessage({
        messageId: 'msg-1',
        roomId: 'room-1',
        senderProfileId: 'person-1',
        content: 'main conversation',
      });
      const threaded = await intake.ingestChatMessage({
        messageId: 'msg-2',
        roomId: 'room-1',
        threadId: 'thread-9',
        senderProfileId: 'person-1',
        content: 'separate thread topic',
      });
      expect(threaded.outcome).toBe('created');
      expect(threaded.supportCase?.id).not.toBe(main.supportCase?.id);
    });

    it('skips unbound rooms and non-user roles', async () => {
      await bindRoom('room-1');
      const unbound = await intake.ingestChatMessage({
        messageId: 'msg-1',
        roomId: 'room-unbound',
        senderProfileId: 'person-1',
        content: 'not support',
      });
      expect(unbound.outcome).toBe('skipped');
      expect(unbound.reason).toBe('no-binding');

      const agentReply = await intake.ingestChatMessage({
        messageId: 'msg-2',
        roomId: 'room-1',
        senderProfileId: 'bot-1',
        role: 'assistant',
        content: 'I am the agent replying',
      });
      expect(agentReply.outcome).toBe('skipped');
      expect(agentReply.reason).toBe('role:assistant');
    });

    it('reopens a resolved case when the client writes again', async () => {
      await bindRoom();
      const first = await intake.ingestChatMessage({
        messageId: 'msg-1',
        roomId: 'room-1',
        senderProfileId: 'person-1',
        content: 'issue!',
      });
      expect(first.supportCase).toBeDefined();
      await intake.caseService.resolve(first.supportCase?.id ?? '', {
        actorKind: 'specialist',
        summary: 'fixed',
      });

      const again = await intake.ingestChatMessage({
        messageId: 'msg-2',
        roomId: 'room-1',
        senderProfileId: 'person-1',
        content: 'it broke again',
      });
      expect(again.outcome).toBe('reopened');
      expect(again.supportCase?.id).toBe(first.supportCase?.id);
      expect(again.supportCase?.reopenCount).toBe(1);
      // Reopened cases land back in triage; the new inbound interaction is
      // already attached below it in the timeline.
      expect(again.supportCase?.status).toBe('triaged');
    });
  });

  describe('email intake', () => {
    async function bindAccount(accountId = 'acct-1') {
      const binding = await intake.bindings.create({
        name: `mailbox ${accountId}`,
        bindingKind: 'email_account',
        channelKind: 'email',
        targetType: '@happyvertical/smrt-messages:EmailAccount',
        targetId: accountId,
      });
      binding.setSelfAddresses(['support@acme.test']);
      await binding.save();
      return binding;
    }

    it('creates a case from a new email and joins the RFC thread on reply', async () => {
      await bindAccount();
      const first = await intake.ingestEmail({
        emailId: 'email-1',
        accountId: 'acct-1',
        fromAddress: 'customer@client.test',
        fromName: 'Customer',
        subject: 'Invoice discrepancy',
        body: 'Our invoice looks wrong.',
        rfcMessageId: '<m1@client.test>',
      });
      expect(first.outcome).toBe('created');
      expect(first.supportCase?.subject).toBe('Invoice discrepancy');
      expect(first.supportCase?.channelKind).toBe('email');

      const reply = await intake.ingestEmail({
        emailId: 'email-2',
        accountId: 'acct-1',
        fromAddress: 'customer@client.test',
        subject: 'Re: Invoice discrepancy',
        body: 'Adding more detail.',
        rfcMessageId: '<m2@client.test>',
        inReplyTo: '<m1@client.test>',
      });
      expect(reply.outcome).toBe('joined');
      expect(reply.supportCase?.id).toBe(first.supportCase?.id);

      // Threading rides a first-class keyed column, not a bounded metadata
      // scan (codex P2, PR #1943) — the Message-ID is persisted and
      // queryable directly.
      expect(first.interaction?.rfcMessageId).toBe('<m1@client.test>');
      const parent =
        await intake.caseService.interactions.byRfcMessageId(
          '<m1@client.test>',
        );
      expect(parent?.id).toBe(first.interaction?.id);
    });

    it('skips mail sent from the binding self addresses', async () => {
      await bindAccount();
      const outbound = await intake.ingestEmail({
        emailId: 'email-1',
        accountId: 'acct-1',
        fromAddress: 'Support@Acme.test',
        subject: 'Re: your ticket',
        body: 'our own reply synced back in',
      });
      expect(outbound.outcome).toBe('skipped');
      expect(outbound.reason).toBe('self-address');
    });

    it('parks unresolved senders for triage and uses the resolver when given', async () => {
      await bindAccount();
      const parked = await intake.ingestEmail({
        emailId: 'email-1',
        accountId: 'acct-1',
        fromAddress: 'stranger@nowhere.test',
        subject: 'help',
        body: 'who am I?',
      });
      expect(parked.outcome).toBe('created');
      expect(parked.supportCase?.clientProfileId).toBeNull();
      expect(parked.supportCase?.getMetadata()).toMatchObject({
        unresolvedClient: true,
        fromAddress: 'stranger@nowhere.test',
      });

      const resolving = await SupportIntakeService.create({
        db: ctx.db,
        resolveClientProfileId: async ({ email }) =>
          email === 'known@client.test' ? 'profile-known' : null,
      });
      const resolved = await resolving.ingestEmail({
        emailId: 'email-2',
        accountId: 'acct-1',
        fromAddress: 'known@client.test',
        subject: 'hi',
        body: 'known sender',
      });
      expect(resolved.supportCase?.clientProfileId).toBe('profile-known');
      expect(resolved.supportCase?.getMetadata()).toEqual({});
    });
  });

  describe('ambient interceptor', () => {
    it('feeds ChatMessage saves through intake and never throws into the save path', async () => {
      await intake.bindings.create({
        name: 'room binding',
        bindingKind: 'chat_room',
        channelKind: 'chat',
        targetType: '@happyvertical/smrt-chat:ChatRoom',
        targetId: 'room-1',
      });

      const unregister = registerSupportIntake(intake);
      try {
        // Simulate the source package's saved instance: the interceptor keys
        // off the constructor name and reads the transport fields.
        class ChatMessage {
          id = 'msg-77';
          roomId = 'room-1';
          threadId = null;
          senderProfileId = 'person-9';
          role = 'user';
          content = 'ambient hello';
          tenantId = null;
          isDeleted = false;
        }
        await GlobalInterceptors.executeAfterSave(
          new ChatMessage() as never,
          createInterceptorContext('ChatMessage', 'save'),
        );

        const cases = await intake.caseService.cases.findQueue({});
        expect(cases).toHaveLength(1);
        expect(cases[0]?.subject).toBe('ambient hello');

        // A model the interceptor does not understand passes through silently.
        class SomethingElse {
          id = 'x';
        }
        await expect(
          GlobalInterceptors.executeAfterSave(
            new SomethingElse() as never,
            createInterceptorContext('SomethingElse', 'save'),
          ),
        ).resolves.toBeUndefined();
      } finally {
        unregister();
      }
    });
  });
});
