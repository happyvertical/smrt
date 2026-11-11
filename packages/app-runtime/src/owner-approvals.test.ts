import { randomUUID } from 'node:crypto';
import { ApprovalEventCollection } from '@happyvertical/smrt-approvals';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import {
  MembershipCollection,
  MembershipStatus,
  RoleCollection,
  TenantCollection,
  UserCollection,
  UserStatus,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSqliteOwnerApprovalStore,
  isApprovalOwner,
  OwnerApprovalAuthority,
  type OwnerApprovalInput,
} from './owner-approvals.js';

describe('owner tool holds over the canonical approval ledger (SQLite)', () => {
  let db: DatabaseInterface;
  let authority: OwnerApprovalAuthority;
  let now: number;
  let tenantId: string;
  let owner: { id: string; tenantId: string };
  let input: OwnerApprovalInput;
  const open = async () =>
    new OwnerApprovalAuthority(
      await createSqliteOwnerApprovalStore(db, () => now),
      async (actor) => actor.id === owner.id && actor.tenantId === tenantId,
      () => now,
    );
  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        '@happyvertical/smrt-users:User',
        '@happyvertical/smrt-users:Role',
        '@happyvertical/smrt-users:Membership',
        '@happyvertical/smrt-users:Tenant',
        '@happyvertical/smrt-approvals:ApprovalRequest',
        '@happyvertical/smrt-approvals:ApprovalEvent',
        '@happyvertical/smrt-approvals:ApprovalPolicy',
      ],
    });
    now = Date.parse('2026-11-10T12:00:00Z');
    tenantId = randomUUID();
    owner = { id: randomUUID(), tenantId };
    input = {
      tenantId,
      requestedBy: owner.id,
      tool: 'invoices.delete',
      callId: 'delete-1',
      args: { id: 'invoice-1' },
      summary: 'Delete invoice INV-1?',
      context: {
        principal: { userId: owner.id, tenantId },
        threadId: 'thread-1',
      },
      ttlMs: 60_000,
    };
    authority = await open();
  });
  afterEach(async () => {
    await db?.close();
  });

  it('survives re-creating authority, records the human actor, and consumes once across instances', async () => {
    const record = await authority.request(input);
    input.args.id = 'changed-after-request';
    const reopened = await open();
    expect((await reopened.list(owner))[0]).toMatchObject({
      id: record.id,
      status: 'pending',
      args: { id: 'invoice-1' },
    });
    const decisions = await Promise.allSettled([
      authority.decide(owner, record.id, true),
      reopened.decide(owner, record.id, true),
    ]);
    expect(decisions.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await reopened.get(tenantId, record.id)).toMatchObject({
      status: 'approved',
      decidedBy: owner.id,
      decidedAt: now,
    });
    const consumers = await Promise.allSettled([
      authority.consume(tenantId, record.id),
      reopened.consume(tenantId, record.id),
    ]);
    expect(consumers.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await reopened.complete(tenantId, record.id, true, {
      removed: 'invoice-1',
    });
    expect(await authority.get(tenantId, record.id)).toMatchObject({
      status: 'succeeded',
      result: { removed: 'invoice-1' },
      decidedBy: owner.id,
    });
    await expect(authority.consume(tenantId, record.id)).rejects.toMatchObject({
      code: 'conflict',
    });
    const events = await withTenant({ tenantId }, async () =>
      (await ApprovalEventCollection.create({ db })).list({
        where: { tenantId },
      }),
    );
    expect(events.map((event) => event.type).sort()).toEqual([
      'approved',
      'consumed',
      'created',
    ]);
  });

  it('denies without consuming, rejects repeat decisions and refuses non-owners and other tenants', async () => {
    const record = await authority.request(input);
    await expect(
      authority.list({ id: 'stranger', tenantId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      authority.decide({ id: 'stranger', tenantId }, record.id, true),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      authority.decide({ ...owner, tenantId: randomUUID() }, record.id, true),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await authority.get(randomUUID(), record.id)).toBeNull();
    await authority.decide(owner, record.id, false);
    await expect(authority.consume(tenantId, record.id)).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      authority.decide(owner, record.id, true),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await authority.get(tenantId, record.id)).toMatchObject({
      status: 'denied',
      decidedBy: owner.id,
    });
  });

  it('expires at the boundary, cannot revive a hold, and releases waits on abort', async () => {
    const record = await authority.request(input);
    now += 60_000;
    expect(await authority.get(tenantId, record.id)).toMatchObject({
      status: 'expired',
    });
    await expect(
      authority.decide(owner, record.id, true),
    ).rejects.toMatchObject({ code: 'conflict' });
    const approved = await authority.request(input);
    await authority.decide(owner, approved.id, true);
    now += 60_000;
    expect(await authority.get(tenantId, approved.id)).toMatchObject({
      status: 'expired',
    });
    await expect(
      authority.consume(tenantId, approved.id),
    ).rejects.toMatchObject({ code: 'conflict' });
    const pending = await authority.request(input);
    const abort = new AbortController();
    const wait = authority.wait(tenantId, pending.id, abort.signal);
    abort.abort();
    expect(await wait).toBeNull();
    expect(await authority.get(tenantId, pending.id)).toMatchObject({
      status: 'pending',
    });
  });

  it('does not execute a consumed hold again after restart or failure', async () => {
    const record = await authority.request(input);
    await authority.decide(owner, record.id, true);
    await authority.consume(tenantId, record.id);
    const reopened = await open();
    expect(await reopened.get(tenantId, record.id)).toMatchObject({
      status: 'executing',
    });
    await expect(reopened.consume(tenantId, record.id)).rejects.toMatchObject({
      code: 'conflict',
    });
    await reopened.complete(tenantId, record.id, false, {
      error: 'host failed',
    });
    await expect(
      reopened.complete(tenantId, record.id, true, {}),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await authority.get(tenantId, record.id)).toMatchObject({
      status: 'failed',
      decidedBy: owner.id,
    });
  });

  it('rejects malformed and executable envelopes before creating a gate', async () => {
    await expect(
      authority.request({ ...input, ttlMs: 0 }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      authority.request({ ...input, tool: '' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      authority.request({ ...input, args: { execute: () => {} } }),
    ).rejects.toThrow();
    expect(await authority.list(owner)).toEqual([]);
  });
  it('checks the canonical live owner role, direct tenant membership and active user status', async () => {
    const users = await UserCollection.create({ db });
    const tenants = await TenantCollection.create({ db });
    const roles = await RoleCollection.create({ db });
    const memberships = await MembershipCollection.create({ db });
    const user = await users.create({ email: 'owner@test.invalid' });
    await user.save();
    const tenant = await tenants.create({ name: 'Owner tenant' });
    await tenant.save();
    await roles.seedSystemRoles();
    const role = await roles.findSystemRoleBySlug('owner');
    if (!role) throw new Error('missing canonical owner role');
    const actor = { id: String(user.id), tenantId: String(tenant.id) };
    expect(await isApprovalOwner(db, actor)).toBe(false);
    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: role.id,
    });
    await membership.save();
    expect(await isApprovalOwner(db, actor)).toBe(true);
    expect(
      await isApprovalOwner(db, { ...actor, tenantId: randomUUID() }),
    ).toBe(false);
    membership.status = MembershipStatus.SUSPENDED;
    await membership.save();
    expect(await isApprovalOwner(db, actor)).toBe(false);
    membership.status = MembershipStatus.ACTIVE;
    await membership.save();
    user.status = UserStatus.SUSPENDED;
    await user.save();
    expect(await isApprovalOwner(db, actor)).toBe(false);
  });
});
