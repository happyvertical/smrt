/**
 * Mail-send approval gate (#5141): an agent's held send, approve,
 * edit-then-approve, reject, approver re-verification and single use,
 * in-process SQLite with tenancy on.
 */

import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineApprovalKind } from '../kinds.js';
import {
  APPROVE_MAIL_SEND_PERMISSION,
  createApprovalMailSendGate,
} from '../mail-send-gate.js';
import { ApprovalService } from '../service.js';
import { TestClock } from './helpers/approval-suite.js';
import { APPROVAL_CLASSES } from './helpers/classes.js';

describe('mail-send approval gate (SQLite)', () => {
  let db: DatabaseInterface;
  beforeAll(async () => {
    enableTenancy();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: APPROVAL_CLASSES,
    });
  });
  afterAll(async () => {
    disableTenancy();
    await (db as { close?: () => Promise<void> }).close?.();
  });

  function world() {
    const tenantId = randomUUID();
    const clock = new TestClock();
    const service = new ApprovalService({ db, now: clock.now });
    const gate = createApprovalMailSendGate({ service, now: clock.now });
    const agent = { id: randomUUID(), kind: 'agent' };
    const person = {
      id: randomUUID(),
      kind: 'person',
      permissions: [APPROVE_MAIL_SEND_PERMISSION],
    };
    const messageId = randomUUID();
    const check = (
      bindingHash = 'draft-1',
      requester: { id: string; kind: string | null } = agent,
    ) =>
      gate.check({
        tenantId,
        messageId,
        bindingHash,
        requester,
        summary: 'An agent asked to send an email.',
      });
    const release = (
      bindingHash = 'draft-1',
      approvalId: string,
      verifyApprovers: (ids: string[]) => Promise<boolean> = async () => true,
    ) =>
      gate.consume({
        tenantId,
        approvalId,
        consumer: person,
        bindingHash,
        verifyApprovers,
      });
    return { tenantId, clock, gate, agent, person, messageId, check, release };
  }

  it('holds an agent send until a person approves, then releases it once', async () => {
    const w = world();
    const first = await w.check();
    expect(first).toMatchObject({ state: 'pending', created: true });
    const again = await w.check();
    expect(again).toMatchObject({ state: 'pending', created: false });
    if (first.state !== 'pending') throw new Error('expected pending');

    const decided = await w.gate.decide({
      tenantId: w.tenantId,
      approvalId: first.approvalId,
      decider: w.person,
      decision: 'approve',
      expectedBindingHash: 'draft-1',
    });
    expect(decided.ok).toBe(true);

    // The requester sees the approval but cannot consume it.
    const status = await w.check();
    expect(status).toMatchObject({
      state: 'approved',
      approvalId: first.approvalId,
      approverIds: [w.person.id],
    });
    expect(
      await w.gate.get(w.tenantId, first.approvalId, w.agent),
    ).toMatchObject({ consumed: false });

    // The approving person releases it, after re-verification.
    const seen: string[][] = [];
    const released = await w.release(
      'draft-1',
      first.approvalId,
      async (ids) => {
        seen.push(ids);
        return true;
      },
    );
    expect(released).toMatchObject({ ok: true, view: { consumed: true } });
    expect(seen).toEqual([[w.person.id]]);

    // Single use: the same content opens a new request instead of reusing it.
    const resend = await w.check();
    expect(resend).toMatchObject({ state: 'pending', created: true });
    expect(
      resend.state === 'pending' && resend.approvalId !== first.approvalId,
    ).toBe(true);
  });

  it('never lets the agent decide its own send, whatever it is labelled', async () => {
    const w = world();
    const opened = await w.check();
    if (opened.state !== 'pending') throw new Error('expected pending');
    const asAgent = await w.gate.decide({
      tenantId: w.tenantId,
      approvalId: opened.approvalId,
      decider: { ...w.agent, permissions: [APPROVE_MAIL_SEND_PERMISSION] },
      decision: 'approve',
      expectedBindingHash: 'draft-1',
    });
    expect(asAgent).toMatchObject({ ok: false, reason: 'not_human' });
    // Relabelled as a person, the requester is still refused.
    const relabelled = await w.gate.decide({
      tenantId: w.tenantId,
      approvalId: opened.approvalId,
      decider: {
        id: w.agent.id,
        kind: 'person',
        permissions: [APPROVE_MAIL_SEND_PERMISSION],
      },
      decision: 'approve',
      expectedBindingHash: 'draft-1',
    });
    expect(relabelled).toMatchObject({ ok: false, reason: 'self_approval' });
    // An unlabelled decider is an agent.
    const unlabelled = await w.gate.decide({
      tenantId: w.tenantId,
      approvalId: opened.approvalId,
      decider: {
        id: randomUUID(),
        kind: null,
        permissions: [APPROVE_MAIL_SEND_PERMISSION],
      },
      decision: 'approve',
      expectedBindingHash: 'draft-1',
    });
    expect(unlabelled).toMatchObject({ ok: false, reason: 'not_human' });
    // A person without the send permission is refused.
    const viewer = await w.gate.decide({
      tenantId: w.tenantId,
      approvalId: opened.approvalId,
      decider: { id: randomUUID(), kind: 'person', permissions: [] },
      decision: 'approve',
      expectedBindingHash: 'draft-1',
    });
    expect(viewer).toMatchObject({ ok: false, reason: 'forbidden' });
  });

  it('refuses to release when an approver no longer holds send, and keeps the approval', async () => {
    const w = world();
    const opened = await w.check();
    if (opened.state !== 'pending') throw new Error('expected pending');
    await w.gate.decide({
      tenantId: w.tenantId,
      approvalId: opened.approvalId,
      decider: w.person,
      decision: 'approve',
      expectedBindingHash: 'draft-1',
    });
    const refused = await w.release(
      'draft-1',
      opened.approvalId,
      async () => false,
    );
    expect(refused).toMatchObject({
      ok: false,
      reason: 'approver_not_authorized',
    });
    const view = await w.gate.get(w.tenantId, opened.approvalId, w.agent);
    expect(view).toMatchObject({ status: 'approved', consumed: false });
  });

  it('binds an edit-then-approve to the edited draft only', async () => {
    const w = world();
    const opened = await w.check('draft-1');
    if (opened.state !== 'pending') throw new Error('expected pending');
    const edited = await w.gate.decide({
      tenantId: w.tenantId,
      approvalId: opened.approvalId,
      decider: w.person,
      decision: 'approve',
      reason: 'softened the tone',
      expectedBindingHash: 'draft-1',
      revisedBindingHash: 'draft-2',
    });
    expect(edited).toMatchObject({
      ok: true,
      view: { status: 'approved', bindingHash: 'draft-2' },
    });
    const wrong = await w.gate.consume({
      tenantId: w.tenantId,
      approvalId: opened.approvalId,
      consumer: w.person,
      bindingHash: 'draft-1',
      verifyApprovers: async () => true,
    });
    expect(wrong).toMatchObject({ ok: false, reason: 'revision_mismatch' });
    const used = await w.gate.consume({
      tenantId: w.tenantId,
      approvalId: opened.approvalId,
      consumer: w.person,
      bindingHash: 'draft-2',
      verifyApprovers: async () => true,
    });
    expect(used).toMatchObject({ ok: true, view: { consumed: true } });
    const twice = await w.gate.consume({
      tenantId: w.tenantId,
      approvalId: opened.approvalId,
      consumer: w.person,
      bindingHash: 'draft-2',
      verifyApprovers: async () => true,
    });
    expect(twice).toMatchObject({ ok: false, reason: 'already_consumed' });
  });

  it('refuses a draft changed after approval and a rejected draft', async () => {
    const w = world();
    const opened = await w.check('draft-1');
    if (opened.state !== 'pending') throw new Error('expected pending');
    await w.gate.decide({
      tenantId: w.tenantId,
      approvalId: opened.approvalId,
      decider: w.person,
      decision: 'approve',
      expectedBindingHash: 'draft-1',
    });
    // The agent changed the draft after approval: a new revision waits again.
    const changed = await w.check('draft-3');
    expect(changed).toMatchObject({ state: 'pending', created: true });
    if (changed.state !== 'pending') throw new Error('expected pending');

    const rejected = await w.gate.decide({
      tenantId: w.tenantId,
      approvalId: changed.approvalId,
      decider: w.person,
      decision: 'reject',
      reason: 'do not promise a date',
      expectedBindingHash: 'draft-3',
    });
    expect(rejected).toMatchObject({ ok: true, view: { status: 'rejected' } });
    expect(await w.check('draft-3')).toMatchObject({
      state: 'refused',
      reason: 'rejected',
    });
  });

  it('refuses a decision that does not name the reviewed draft', async () => {
    const w = world();
    const opened = await w.check();
    if (opened.state !== 'pending') throw new Error('expected pending');
    for (const expectedBindingHash of ['', '   ', undefined]) {
      await expect(
        w.gate.decide({
          tenantId: w.tenantId,
          approvalId: opened.approvalId,
          decider: w.person,
          decision: 'approve',
          expectedBindingHash: expectedBindingHash as unknown as string,
        }),
      ).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    }
    const view = await w.gate.get(w.tenantId, opened.approvalId, w.person);
    expect(view).toMatchObject({ status: 'pending', approverIds: [] });
  });

  it('verifies approvers only once quorum is reached', async () => {
    const w = world();
    const dual = defineApprovalKind({
      key: 'messages.mail.send-dual-test',
      subject: '@happyvertical/smrt-messages:Message',
      permission: APPROVE_MAIL_SEND_PERMISSION,
      allowRevisedApproval: true,
      defaults: { requiredApprovals: 2 },
    });
    const gate = createApprovalMailSendGate({
      service: new ApprovalService({ db, now: w.clock.now }),
      kind: dual,
      now: w.clock.now,
    });
    const opened = await gate.check({
      tenantId: w.tenantId,
      messageId: w.messageId,
      bindingHash: 'draft-1',
      requester: w.agent,
      summary: 'x',
    });
    if (opened.state !== 'pending') throw new Error('expected pending');
    await gate.decide({
      tenantId: w.tenantId,
      approvalId: opened.approvalId,
      decider: w.person,
      decision: 'approve',
      expectedBindingHash: 'draft-1',
    });
    const seen: string[][] = [];
    const early = await gate.consume({
      tenantId: w.tenantId,
      approvalId: opened.approvalId,
      consumer: w.person,
      bindingHash: 'draft-1',
      verifyApprovers: async (ids) => {
        seen.push(ids);
        return true;
      },
    });
    expect(early).toMatchObject({ ok: false, reason: 'not_approved' });
    expect(seen).toEqual([]);
  });

  it('opens a fresh request for a revision whose request was rebound by an edit', async () => {
    const w = world();
    const opened = await w.check('draft-1');
    if (opened.state !== 'pending') throw new Error('expected pending');
    await w.gate.decide({
      tenantId: w.tenantId,
      approvalId: opened.approvalId,
      decider: w.person,
      decision: 'approve',
      expectedBindingHash: 'draft-1',
      revisedBindingHash: 'draft-2',
    });
    // The draft went back to its original content: it waits again rather
    // than being refused forever under the rebound key.
    const again = await w.check('draft-1');
    expect(again).toMatchObject({ state: 'pending', created: true });
    expect(
      again.state === 'pending' && again.approvalId !== opened.approvalId,
    ).toBe(true);
  });

  it('keeps requests per tenant', async () => {
    const w = world();
    const opened = await w.check();
    if (opened.state !== 'pending') throw new Error('expected pending');
    const otherTenant = randomUUID();
    expect(
      await w.gate.get(otherTenant, opened.approvalId, w.person),
    ).toBeNull();
    const foreign = await w.gate.decide({
      tenantId: otherTenant,
      approvalId: opened.approvalId,
      decider: w.person,
      decision: 'approve',
      expectedBindingHash: 'draft-1',
    });
    expect(foreign).toMatchObject({ ok: false, reason: 'not_found' });
  });
});
