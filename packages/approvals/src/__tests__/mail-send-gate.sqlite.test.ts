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
      verifyApprovers: (ids: string[]) => Promise<boolean> = async () => true,
      requester: { id: string; kind: string | null } = agent,
    ) =>
      gate.check({
        tenantId,
        messageId,
        bindingHash,
        requester,
        summary: 'Reply to Ada',
        verifyApprovers,
      });
    return { tenantId, clock, gate, agent, person, messageId, check };
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

    const seen: string[][] = [];
    const released = await w.check('draft-1', async (ids) => {
      seen.push(ids);
      return true;
    });
    expect(released).toMatchObject({
      state: 'approved',
      approvalId: first.approvalId,
      approverIds: [w.person.id],
    });
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
    const refused = await w.check('draft-1', async () => false);
    expect(refused).toMatchObject({
      state: 'refused',
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
