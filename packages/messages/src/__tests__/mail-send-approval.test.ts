/**
 * Agent send policy and held sends (#5141). HIGH-RISK (authorization and an
 * approval boundary), so most cases are bypass attempts: an agent approving
 * itself, approvers without the account grant, edits after approval, double
 * release, unsaved and send-time content, send-as, tenant crossing.
 *
 * Runs against the real approvals gate from smrt-approvals (dev dependency;
 * smrt-messages never imports it at runtime).
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApprovalService,
  createApprovalMailSendGate,
} from '@happyvertical/smrt-approvals';
import { type AuditEntry, withAuditContext } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  MembershipCollection,
  PermissionCollection,
  ResourceGrantCollection,
  RoleCollection,
  RolePermissionCollection,
  syncPermissionCatalog,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureMailAccess,
  MailAccessError,
  MailAccessService,
  type MailPrincipal,
  type MailScope,
  resetMailAccess,
} from '../access.js';
// The package entry registers the messages permission catalog.
import '../index.js';
import { MailDraftService } from '../mail-drafts.js';
import { Attachment } from '../models/Attachment';
import { Email } from '../models/Email';
import { EmailAccount } from '../models/EmailAccount';
import {
  configureMailSendApprovals,
  type MailSendApprovalGate,
  MailSendApprovalService,
  resetMailSendApprovals,
  threadHandledBy,
} from '../send-approval.js';
import { prepareMessageParents } from './fk-fixtures.js';

const ALL_MAIL_SLUGS = [
  'messages.read',
  'messages.triage',
  'messages.draft',
  'messages.send',
  'messages.manage-access',
];

interface Person {
  id: string;
}

describe('agent send policy and held sends (#5141)', () => {
  let db: DatabaseInterface;
  let options: { db: DatabaseInterface };
  let tenantA: string;
  let tenantB: string;
  let owner: Person;
  let colleague: Person;
  let outsider: Person;
  let agent: Person;
  let current: MailPrincipal | null = null;
  let accountId: string;
  let gate: MailSendApprovalGate;
  let providerSend: ReturnType<typeof vi.fn>;

  const person = (p: Person, tenantId = tenantA): MailPrincipal => ({
    id: `session-${p.id}`,
    userId: p.id,
    tenantId,
    kind: 'person',
  });
  const asAgent = (overrides: Partial<MailPrincipal> = {}): MailPrincipal => ({
    id: `credential-${agent.id}`,
    userId: agent.id,
    tenantId: tenantA,
    kind: 'agent',
    ...overrides,
  });

  async function newPerson(
    tenantId: string,
    label: string,
    slugs: string[] = ALL_MAIL_SLUGS,
  ): Promise<Person> {
    const users = await UserCollection.create(options);
    const user = await users.create({
      email: `${label}-${randomUUID()}@example.com`,
    });
    await user.save();
    const roles = await RoleCollection.create(options);
    const role = await roles.create({
      name: `role ${randomUUID()}`,
      slug: `role-${randomUUID()}`,
    });
    await role.save();
    const permissions = await PermissionCollection.create(options);
    const rolePermissions = await RolePermissionCollection.create(options);
    for (const slug of slugs) {
      const permission = await permissions.findBySlug(slug);
      if (!permission?.id) throw new Error(`missing permission ${slug}`);
      await rolePermissions.addPermission(role.id as string, permission.id);
    }
    const memberships = await MembershipCollection.create(options);
    const membership = await memberships.create({
      roleId: role.id as string,
      tenantId,
      userId: user.id as string,
    });
    await membership.save();
    return { id: user.id as string };
  }

  async function grant(userId: string, scope: MailScope) {
    await withTenant({ tenantId: tenantA }, async () => {
      const grants = await ResourceGrantCollection.create(options);
      const row = await grants.create({
        tenantId: tenantA,
        userId,
        resourceType: 'messages:account',
        resourceId: accountId,
        permission: `messages.${scope}`,
      });
      await row.save();
    });
  }

  const as = async <T>(
    principal: MailPrincipal | null,
    fn: () => Promise<T>,
  ): Promise<T> => {
    current = principal;
    return withTenant({ tenantId: principal?.tenantId ?? tenantA }, fn);
  };

  async function draftAsAgent(subject = 'Re: your invoice'): Promise<Email> {
    return as(asAgent(), () =>
      new MailDraftService(options).save({
        accountId,
        subject,
        textBody: 'Paid on Monday.',
        toAddresses: [{ address: 'ada@example.com', name: 'Ada' }],
      }),
    );
  }

  async function reload(id: string): Promise<Email> {
    return as(person(owner), async () => {
      const email = new Email({ ...options, id });
      await email.initialize();
      return email;
    });
  }

  const submitAsAgent = (draftId: string) =>
    as(asAgent(), () => new MailDraftService(options).submit(draftId));

  const approvals = (principal: MailPrincipal) => ({
    approve: (
      id: string,
      input?: Parameters<MailSendApprovalService['approve']>[1],
    ) =>
      as(principal, () =>
        new MailSendApprovalService(options).approve(id, input),
      ),
    reject: (id: string, reason: string) =>
      as(principal, () =>
        new MailSendApprovalService(options).reject(id, reason),
      ),
  });

  /** A person approves through the generic approvals inbox (no send). */
  async function approveViaInbox(id: string, who: Person = owner) {
    const view = await gate.get(tenantA, id, { id: who.id, kind: 'person' });
    return gate.decide({
      tenantId: tenantA,
      approvalId: id,
      decider: { id: who.id, kind: 'person', permissions: ['messages.send'] },
      decision: 'approve',
      expectedBindingHash: view?.bindingHash ?? '',
    });
  }

  const releaseAs = (principal: MailPrincipal, id: string) =>
    as(principal, () => new MailSendApprovalService(options).release(id));

  async function pendingId(draft: Email): Promise<string> {
    const held = await submitAsAgent(draft.id as string);
    expect(held.success).toBe(false);
    const id = held.pendingApproval?.approvalId;
    if (!id) throw new Error(`expected a held send, got ${held.error}`);
    return id;
  }

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    options = { db };
    await prepareMessageParents(db);
    enableTenancy();
    await withSystemContext(async () => {
      await syncPermissionCatalog(options);
      const tenants = await TenantCollection.create(options);
      const a = await tenants.create({ name: 'Tenant A' });
      await a.save();
      const b = await tenants.create({ name: 'Tenant B' });
      await b.save();
      tenantA = a.id as string;
      tenantB = b.id as string;
      owner = await newPerson(tenantA, 'owner');
      colleague = await newPerson(tenantA, 'colleague');
      outsider = await newPerson(tenantA, 'outsider');
      agent = await newPerson(tenantA, 'agent');
    });
    accountId = await withTenant({ tenantId: tenantA }, async () => {
      const account = new EmailAccount({
        ...options,
        tenantId: tenantA,
        name: 'Will',
        email: 'will@example.com',
        providerType: 'smtp',
        ownerUserId: owner.id,
      });
      await account.initialize();
      await account.save();
      return account.id as string;
    });
    for (const scope of ['read', 'draft', 'send'] as const) {
      await grant(agent.id, scope);
      await grant(colleague.id, scope);
    }
    current = null;
    configureMailAccess({ options, resolvePrincipal: () => current });
    gate = createApprovalMailSendGate({
      service: new ApprovalService({ db }),
    });
    configureMailSendApprovals({ gate });
    providerSend = vi.fn(async () => ({
      success: true,
      providerMessageId: `sent-${randomUUID()}`,
      sentAt: new Date(),
    }));
    vi.spyOn(EmailAccount.prototype, 'createSender').mockResolvedValue({
      providerType: 'smtp',
      isReady: () => true,
      send: providerSend,
    } as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetMailSendApprovals();
    resetMailAccess();
    disableTenancy();
    await db.close?.();
  });

  describe('holding', () => {
    it('holds an agent send by default and sends nothing', async () => {
      const draft = await draftAsAgent();
      const held = await submitAsAgent(draft.id as string);
      expect(held).toMatchObject({
        success: false,
        pendingApproval: { created: true },
      });
      expect(providerSend).not.toHaveBeenCalled();
      const stored = await reload(draft.id as string);
      expect(stored.sendStatus).toBe('draft');
      expect(stored.getHandledBy()).toMatchObject({
        id: agent.id,
        kind: 'agent',
      });
      // Retrying returns the same waiting request.
      const again = await submitAsAgent(draft.id as string);
      expect(again.pendingApproval).toMatchObject({
        approvalId: held.pendingApproval?.approvalId,
        created: false,
      });
    });

    it('treats an unlabelled principal as an agent', async () => {
      const draft = await draftAsAgent();
      const held = await as(asAgent({ kind: undefined }), () =>
        new MailDraftService(options).submit(draft.id as string),
      );
      expect(held.pendingApproval).toBeDefined();
      expect(providerSend).not.toHaveBeenCalled();
    });

    it('refuses an agent send when no gate is configured', async () => {
      resetMailSendApprovals();
      const draft = await draftAsAgent();
      const result = await submitAsAgent(draft.id as string);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no approval gate is configured/);
      expect(providerSend).not.toHaveBeenCalled();
    });

    it('leaves person sends alone', async () => {
      const result = await as(person(colleague), async () => {
        const draft = await new MailDraftService(options).save({
          accountId,
          subject: 'Hello',
          textBody: 'hi',
          toAddresses: [{ address: 'ada@example.com' }],
        });
        return draft.send();
      });
      expect(result.success).toBe(true);
      expect(providerSend).toHaveBeenCalledTimes(1);
    });

    it('refuses unsaved changes and send-time attachments on a held send', async () => {
      const draft = await draftAsAgent();
      const unsaved = await as(asAgent(), async () => {
        const copy = await reload(draft.id as string);
        copy.subject = 'something else';
        current = asAgent();
        return copy.send();
      });
      expect(unsaved.error).toMatch(/unsaved changes/);
      const withBytes = await as(asAgent(), async () => {
        const copy = await reload(draft.id as string);
        current = asAgent();
        return copy.send({
          attachments: [{ filename: 'x.txt', content: new Uint8Array([1]) }],
        } as never);
      });
      expect(withBytes.error).toMatch(/send-time attachments/);
      expect(providerSend).not.toHaveBeenCalled();
    });

    it('refuses sending as another address on an owned account', async () => {
      const draft = await draftAsAgent();
      const result = await as(person(owner), async () => {
        const copy = await reload(draft.id as string);
        copy.fromAddress = 'ceo@example.com';
        await copy.save();
        current = person(owner);
        return copy.send();
      });
      expect(result.error).toMatch(/account's own address/);
      expect(providerSend).not.toHaveBeenCalled();
    });
  });

  describe('approve, edit-then-approve, reject', () => {
    it('sends exactly once when a person with send approves', async () => {
      const draft = await draftAsAgent();
      const id = await pendingId(draft);
      const decided = await approvals(person(colleague)).approve(id);
      expect(decided).toMatchObject({
        state: 'sent',
        result: { success: true },
      });
      expect(providerSend).toHaveBeenCalledTimes(1);
      const stored = await reload(draft.id as string);
      expect(stored.sendStatus).toBe('sent');
      expect(stored.getHandledBy()).toMatchObject({
        id: colleague.id,
        kind: 'person',
      });
      // Neither a second approval (with or without edits) nor the agent's
      // retry sends again or rewrites the sent message.
      await expect(approvals(person(owner)).approve(id)).rejects.toMatchObject({
        reason: 'not_a_draft',
      });
      await expect(
        approvals(person(owner)).approve(id, { edits: { subject: 'rewrite' } }),
      ).rejects.toMatchObject({ reason: 'not_a_draft' });
      expect((await reload(draft.id as string)).subject).toBe(
        'Re: your invoice',
      );
      const retry = await submitAsAgent(draft.id as string);
      expect(retry.success).toBe(false);
      expect(providerSend).toHaveBeenCalledTimes(1);
    });

    it('releases once under concurrent approvals', async () => {
      const draft = await draftAsAgent();
      const id = await pendingId(draft);
      const results = await Promise.allSettled([
        approvals(person(colleague)).approve(id),
        approvals(person(owner)).approve(id),
      ]);
      const sent = results.filter(
        (r) => r.status === 'fulfilled' && r.value.state === 'sent',
      );
      expect(sent).toHaveLength(1);
      expect(providerSend).toHaveBeenCalledTimes(1);
    });

    it('sends the edited draft on edit-then-approve, bound to the edit', async () => {
      const draft = await draftAsAgent();
      const id = await pendingId(draft);
      const decided = await approvals(person(owner)).approve(id, {
        edits: { subject: 'Re: your invoice (paid)', textBody: 'Paid today.' },
        reason: 'clearer',
      });
      expect(decided.state).toBe('sent');
      expect(providerSend).toHaveBeenCalledTimes(1);
      const sent = providerSend.mock.calls[0]?.[0] as Email;
      expect(sent.subject).toBe('Re: your invoice (paid)');
      expect(sent.textBody).toBe('Paid today.');
      const view = await gate.get(tenantA, id, {
        id: owner.id,
        kind: 'person',
      });
      expect(view).toMatchObject({ status: 'approved', consumed: true });
    });

    it('rejects with a reason and keeps the draft', async () => {
      const draft = await draftAsAgent();
      const id = await pendingId(draft);
      await expect(
        approvals(person(owner)).reject(id, ''),
      ).rejects.toMatchObject({ reason: 'invalid' });
      const decided = await approvals(person(owner)).reject(id, 'Not yet');
      expect(decided.state).toBe('rejected');
      const retry = await submitAsAgent(draft.id as string);
      expect(retry.error).toMatch(/not approved \(rejected\)/);
      expect(providerSend).not.toHaveBeenCalled();
      expect((await reload(draft.id as string)).sendStatus).toBe('draft');
    });
  });

  describe('bypass attempts', () => {
    it('never lets the agent approve its own send', async () => {
      const draft = await draftAsAgent();
      const id = await pendingId(draft);
      await expect(approvals(asAgent()).approve(id)).rejects.toMatchObject({
        reason: 'not_person',
      });
      // The agent's user labelled as a person is still the requester.
      const relabelled = await approvals({
        ...asAgent(),
        kind: 'person',
      }).approve(id);
      expect(relabelled).toMatchObject({
        state: 'refused',
        reason: 'self_approval',
      });
      expect(providerSend).not.toHaveBeenCalled();
    });

    it('refuses a person without send on this mailbox, even with the tenant permission', async () => {
      const draft = await draftAsAgent();
      const id = await pendingId(draft);
      await expect(
        approvals(person(outsider)).approve(id),
      ).rejects.toMatchObject({ reason: 'forbidden' });
      // Approving through the generic approvals service with only the tenant
      // slug does not release it either: approvers are re-checked per account.
      expect((await approveViaInbox(id, outsider)).ok).toBe(true);
      const retry = await submitAsAgent(draft.id as string);
      expect(retry.success).toBe(false);
      await expect(releaseAs(person(outsider), id)).rejects.toMatchObject({
        reason: 'forbidden',
      });
      const used = await gate.consume({
        tenantId: tenantA,
        approvalId: id,
        consumer: { id: owner.id, kind: 'person' },
        bindingHash:
          (await gate.get(tenantA, id, { id: owner.id, kind: 'person' }))
            ?.bindingHash ?? '',
        verifyApprovers: async () => false,
      });
      expect(used).toMatchObject({
        ok: false,
        reason: 'approver_not_authorized',
      });
      expect(providerSend).not.toHaveBeenCalled();
    });

    it('never releases a draft changed after it was approved', async () => {
      const draft = await draftAsAgent();
      const id = await pendingId(draft);
      await approveViaInbox(id);
      // The agent changes the draft, then submits: a new request waits.
      await as(asAgent(), () =>
        new MailDraftService(options).save({
          accountId,
          draftId: draft.id as string,
          textBody: 'Actually, we will never pay.',
        }),
      );
      const changed = await submitAsAgent(draft.id as string);
      expect(changed.pendingApproval?.approvalId).toBeDefined();
      expect(changed.pendingApproval?.approvalId).not.toBe(id);
      // The old approval no longer matches the stored draft.
      expect(await releaseAs(person(owner), id)).toMatchObject({
        state: 'refused',
        reason: 'revision_mismatch',
      });
      // A new attachment row changes the draft too.
      await as(asAgent(), async () => {
        const attachment = new Attachment({
          ...options,
          tenantId: tenantA,
          messageId: draft.id as string,
          filename: 'payload.exe',
        });
        await attachment.initialize();
        await attachment.save();
      });
      const withFile = await approvals(person(owner)).approve(
        changed.pendingApproval?.approvalId as string,
      );
      expect(withFile).toMatchObject({
        state: 'refused',
        reason: 'draft_changed',
      });
      expect(providerSend).not.toHaveBeenCalled();
    });

    it('never lets the agent send an approved draft; the approving person releases it once', async () => {
      const draft = await draftAsAgent();
      const id = await pendingId(draft);
      await approveViaInbox(id);
      const agentTry = await submitAsAgent(draft.id as string);
      expect(agentTry).toMatchObject({
        success: false,
        pendingApproval: { approvalId: id, created: false },
      });
      expect(providerSend).not.toHaveBeenCalled();
      expect(
        await gate.get(tenantA, id, { id: owner.id, kind: 'person' }),
      ).toMatchObject({ status: 'approved', consumed: false });
      // Someone with send who did not approve cannot release it.
      expect(await releaseAs(person(colleague), id)).toMatchObject({
        state: 'refused',
        reason: 'not_an_approver',
      });
      const released = await releaseAs(person(owner), id);
      expect(released).toMatchObject({
        state: 'sent',
        result: { success: true },
      });
      expect(providerSend).toHaveBeenCalledTimes(1);
      expect((await reload(draft.id as string)).getHandledBy()).toMatchObject({
        id: owner.id,
        kind: 'person',
      });
      await expect(releaseAs(person(owner), id)).rejects.toMatchObject({
        reason: 'not_a_draft',
      });
      expect((await submitAsAgent(draft.id as string)).success).toBe(false);
      expect(providerSend).toHaveBeenCalledTimes(1);
    });

    it('sends nothing when an attachment row appears after the approval was consumed', async () => {
      const draft = await draftAsAgent();
      const id = await pendingId(draft);
      await approveViaInbox(id);
      configureMailSendApprovals({
        gate: {
          ...gate,
          consume: async (input) => {
            const result = await gate.consume(input);
            // Lands between the consume and the provider handoff.
            const attachment = new Attachment({
              ...options,
              tenantId: tenantA,
              messageId: draft.id as string,
              filename: 'late.exe',
            });
            await attachment.initialize();
            await attachment.save();
            return result;
          },
        },
      });
      const released = await releaseAs(person(owner), id);
      expect(released.state).toBe('sent');
      const result = (
        released as {
          result: {
            success: boolean;
            error?: string;
            outcomeUnknown?: boolean;
          };
        }
      ).result;
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/changed after it was approved/);
      expect(result.outcomeUnknown).toBeUndefined();
      expect(providerSend).not.toHaveBeenCalled();
    });

    it('binds attachment bytes, not just the file path', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'smrt-held-send-'));
      const file = join(dir, 'invoice.pdf');
      await writeFile(file, 'original bytes');
      try {
        const draft = await draftAsAgent();
        await as(asAgent(), async () => {
          const attachment = new Attachment({
            ...options,
            tenantId: tenantA,
            messageId: draft.id as string,
            filename: 'invoice.pdf',
            filePath: file,
          });
          await attachment.initialize();
          await attachment.save();
        });
        const id = await pendingId(draft);
        await approveViaInbox(id);
        await writeFile(file, 'swapped bytes!');
        expect(await releaseAs(person(owner), id)).toMatchObject({
          state: 'refused',
          reason: 'revision_mismatch',
        });
        expect(providerSend).not.toHaveBeenCalled();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('treats a persona route as an agent send, even when a person invokes it', async () => {
      const draft = await draftAsAgent();
      await as(person(owner), async () => {
        const copy = await reload(draft.id as string);
        copy.personaId = randomUUID();
        await copy.save();
      });
      const result = await as(person(owner), async () => {
        const copy = await reload(draft.id as string);
        current = person(owner);
        return copy.send();
      });
      expect(result.pendingApproval).toBeDefined();
      expect(providerSend).not.toHaveBeenCalled();
      // The invoking person is not the requester and may approve it.
      const decided = await approvals(person(owner)).approve(
        result.pendingApproval?.approvalId as string,
      );
      expect(decided).toMatchObject({
        state: 'sent',
        result: { success: true },
      });
    });

    it('keeps mail content out of the tenant-readable approval rows', async () => {
      const draft = await draftAsAgent('Confidential: layoffs');
      const id = await pendingId(draft);
      const { ApprovalRequestCollection, ApprovalEventCollection } =
        await import('@happyvertical/smrt-approvals');
      await withTenant({ tenantId: tenantA }, async () => {
        const request = await (
          await ApprovalRequestCollection.create(options)
        ).get({ id });
        expect(request?.summary).not.toMatch(/layoffs/);
        const events = await (
          await ApprovalEventCollection.create(options)
        ).list({ where: { requestId: id } });
        expect(events.map((e) => e.reason).join(' ')).not.toMatch(/layoffs/);
      });
    });

    it('lets a person approve a resubmitted draft whose earlier send definitely failed', async () => {
      providerSend.mockResolvedValueOnce({
        success: false,
        error: 'mailbox full',
        sentAt: new Date(),
      });
      const draft = await draftAsAgent();
      const first = await pendingId(draft);
      const failed = await approvals(person(owner)).approve(first);
      expect(failed).toMatchObject({
        state: 'sent',
        result: { success: false },
      });
      expect((await reload(draft.id as string)).sendStatus).toBe('failed');
      const again = await pendingId(draft);
      expect(again).not.toBe(first);
      const sent = await approvals(person(owner)).approve(again);
      expect(sent).toMatchObject({ state: 'sent', result: { success: true } });
      expect(providerSend).toHaveBeenCalledTimes(2);
    });

    it('keeps held sends inside their tenant', async () => {
      const draft = await draftAsAgent();
      const id = await pendingId(draft);
      await expect(
        approvals(person(owner, tenantB)).approve(id),
      ).rejects.toMatchObject({ reason: 'not_found' });
      expect(providerSend).not.toHaveBeenCalled();
    });
  });

  describe('unowned (tenant-wide) mailbox', () => {
    let openId: string;
    let viewer: Person;
    beforeEach(async () => {
      viewer = await withSystemContext(() =>
        newPerson(tenantA, 'viewer', ['messages.read']),
      );
      openId = await withTenant({ tenantId: tenantA }, async () => {
        const account = new EmailAccount({
          ...options,
          tenantId: tenantA,
          name: 'Support',
          email: 'support@example.com',
          providerType: 'smtp',
          ownerUserId: null,
        });
        await account.initialize();
        await account.save();
        return account.id as string;
      });
    });
    const openDraft = (principal: MailPrincipal | null = asAgent()) =>
      as(principal, () =>
        new MailDraftService(options).save({
          accountId: openId,
          subject: 'Ticket 42',
          textBody: 'Fixed.',
          toAddresses: [{ address: 'ada@example.com' }],
        }),
      );

    it('holds an agent send and refuses a person without messages.send', async () => {
      const draft = await openDraft();
      const id = await pendingId(draft);
      await expect(approvals(person(viewer)).approve(id)).rejects.toMatchObject(
        { reason: 'forbidden' },
      );
      // Approved through a generic inbox that trusted the slug: the viewer
      // still cannot release it, and is not a valid approver for anyone.
      expect((await approveViaInbox(id, viewer)).ok).toBe(true);
      await expect(releaseAs(person(viewer), id)).rejects.toMatchObject({
        reason: 'forbidden',
      });
      expect(await releaseAs(person(colleague), id)).toMatchObject({
        state: 'refused',
        reason: 'not_an_approver',
      });
      expect(providerSend).not.toHaveBeenCalled();
      // A person who holds messages.send approves and sends.
      const other = await openDraft();
      await as(asAgent(), () =>
        new MailDraftService(options).save({
          accountId: openId,
          draftId: other.id as string,
          textBody: 'Fixed, really.',
        }),
      );
      const otherId = await pendingId(other);
      expect(await approvals(person(colleague)).approve(otherId)).toMatchObject(
        {
          state: 'sent',
          result: { success: true },
        },
      );
      expect(providerSend).toHaveBeenCalledTimes(1);
    });

    it('refuses an unattributed send when a gate is configured', async () => {
      const draft = await openDraft();
      const result = await as(null, async () => {
        const copy = await reload(draft.id as string);
        current = null;
        return copy.send();
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/signed-in person or agent/);
      expect(providerSend).not.toHaveBeenCalled();
    });

    it('refuses sending as another address', async () => {
      const result = await as(person(colleague), async () => {
        const draft = await openDraft(person(colleague));
        draft.fromAddress = 'ceo@example.com';
        await draft.save();
        current = person(colleague);
        return draft.send();
      });
      expect(result.error).toMatch(/account's own address/);
      expect(providerSend).not.toHaveBeenCalled();
    });
  });

  describe('policy', () => {
    const service = (p: Person, kind = 'person') =>
      new MailAccessService(options, { userId: p.id, tenantId: tenantA, kind });

    it('lets only the owner, as a person, opt in to auto-send, with confirmation', async () => {
      await expect(
        service(owner).setAgentSendPolicy(accountId, 'auto_send'),
      ).rejects.toThrow(/confirmAutoSend/);
      await expect(
        service(colleague).setAgentSendPolicy(accountId, 'auto_send', {
          confirmAutoSend: true,
        }),
      ).rejects.toThrow(/owner/);
      await expect(
        service(owner, 'agent').setAgentSendPolicy(accountId, 'auto_send', {
          confirmAutoSend: true,
        }),
      ).rejects.toThrow(/person/);
      await service(owner).setAgentSendPolicy(accountId, 'auto_send', {
        confirmAutoSend: true,
      });
      const draft = await draftAsAgent();
      const sent = await submitAsAgent(draft.id as string);
      expect(sent.success).toBe(true);
      expect(providerSend).toHaveBeenCalledTimes(1);
      // Lowering is instant.
      await service(owner).setAgentSendPolicy(accountId, 'require_approval');
      const next = await draftAsAgent('second');
      expect(
        (await submitAsAgent(next.id as string)).pendingApproval,
      ).toBeDefined();
      expect(providerSend).toHaveBeenCalledTimes(1);
    });

    it('drops an auto-send opt-in when the account changes owner', async () => {
      await service(owner).setAgentSendPolicy(accountId, 'auto_send', {
        confirmAutoSend: true,
      });
      await service(owner).setOwner(accountId, colleague.id);
      const draft = await draftAsAgent();
      expect(
        (await submitAsAgent(draft.id as string)).pendingApproval,
      ).toBeDefined();
      expect(providerSend).not.toHaveBeenCalled();
    });

    it('lets the host override per rule, in both directions', async () => {
      configureMailSendApprovals({
        gate,
        resolveAgentSendPolicy: ({ message }) =>
          message.subject.startsWith('[auto]')
            ? 'auto_send'
            : 'require_approval',
      });
      await service(owner).setAgentSendPolicy(accountId, 'auto_send', {
        confirmAutoSend: true,
      });
      const ruled = await draftAsAgent('[auto] receipt');
      expect((await submitAsAgent(ruled.id as string)).success).toBe(true);
      const held = await draftAsAgent('anything else');
      expect(
        (await submitAsAgent(held.id as string)).pendingApproval,
      ).toBeDefined();
      expect(providerSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('drafts and handled-by', () => {
    it('needs the draft scope and always sends from the account address', async () => {
      await expect(
        as(person(outsider), () =>
          new MailDraftService(options).save({ accountId, subject: 'x' }),
        ),
      ).rejects.toBeInstanceOf(MailAccessError);
      const draft = await draftAsAgent();
      expect(draft.fromAddress).toBe('will@example.com');
      expect(draft.isDraft).toBe(true);
    });

    it('refuses to change a sent message through the draft service', async () => {
      const draft = await draftAsAgent();
      const id = await pendingId(draft);
      await approvals(person(owner)).approve(id);
      await expect(
        as(asAgent(), () =>
          new MailDraftService(options).save({
            accountId,
            draftId: draft.id as string,
            textBody: 'edit after send',
          }),
        ),
      ).rejects.toThrow(/unsent draft/);
    });

    it('records each action through the host audit context, with who acted', async () => {
      const entries: AuditEntry[] = [];
      const audited = <T>(actorId: string, fn: () => Promise<T>) =>
        withAuditContext(
          {
            actorId,
            source: 'mcp',
            writer: async (entry) => {
              entries.push(entry);
            },
          },
          fn,
        );
      const draft = await audited('credential-paperclip', () => draftAsAgent());
      const id = await audited('credential-paperclip', () => pendingId(draft));
      await audited(`session-${owner.id}`, () =>
        approvals(person(owner)).approve(id),
      );
      expect(entries.map((e) => [e.action, e.actorId])).toEqual([
        ['messages.draft.save', 'credential-paperclip'],
        ['messages.send.held', 'credential-paperclip'],
        ['messages.send.approved', `session-${owner.id}`],
        ['messages.send', `session-${owner.id}`],
      ]);
      expect(entries.every((e) => e.resourceId === draft.id)).toBe(true);
    });

    it('summarises who handled a thread, latest first', () => {
      const t = (iso: string) => new Date(iso);
      expect(
        threadHandledBy([
          {
            handledById: 'a',
            handledByKind: 'agent',
            handledAt: t('2026-01-01'),
          },
          {
            handledById: 'p',
            handledByKind: 'person',
            handledAt: t('2026-01-03'),
          },
          {
            handledById: 'a',
            handledByKind: 'agent',
            handledAt: t('2026-01-02'),
          },
          { handledById: null, handledByKind: null, handledAt: null },
        ]),
      ).toEqual([
        { id: 'p', kind: 'person', at: t('2026-01-03') },
        { id: 'a', kind: 'agent', at: t('2026-01-02') },
      ]);
    });
  });
});
