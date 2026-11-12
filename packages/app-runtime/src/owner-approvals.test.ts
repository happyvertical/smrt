import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  createOwnerApprovalStore,
  createSqliteOwnerApprovalStore,
  isApprovalOwner,
  type OwnerApproval,
  OwnerApprovalAuthority,
  OwnerApprovalContinuations,
  type OwnerApprovalInput,
  type OwnerApprovalStore,
} from './owner-approvals.js';

const databaseType = process.env.SMRT_TEST_PGLITE === '1' ? 'pglite' : 'sqlite';

describe(`owner tool holds over the canonical approval ledger (${databaseType})`, () => {
  let db: DatabaseInterface;
  let authority: OwnerApprovalAuthority;
  let now: number;
  let tenantId: string;
  let owner: { id: string; tenantId: string };
  let input: OwnerApprovalInput;
  const open = async () =>
    new OwnerApprovalAuthority(
      await createOwnerApprovalStore(db, () => now),
      async (actor) => actor.id === owner.id && actor.tenantId === tenantId,
      () => now,
    );
  beforeEach(async () => {
    db = await getTestDatabase({
      type: databaseType,
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

  it('retains the local alias and uses native UUIDs for PostgreSQL hold identities', async () => {
    expect(createSqliteOwnerApprovalStore).toBe(createOwnerApprovalStore);
    if (databaseType === 'pglite') {
      const { rows } = await db.query(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '_smrt_owner_tool_holds' AND column_name IN ('id', 'tenant_id', 'gate_id') ORDER BY column_name",
      );
      expect(rows).toEqual(
        ['gate_id', 'id', 'tenant_id'].map((column_name) => ({
          column_name,
          data_type: 'uuid',
        })),
      );
    }
  });

  it.runIf(databaseType === 'pglite')(
    'refuses legacy text hold identifiers before using the ledger',
    async () => {
      await db.query(
        'ALTER TABLE _smrt_owner_tool_holds ALTER COLUMN gate_id TYPE TEXT USING gate_id::TEXT',
      );
      await expect(createOwnerApprovalStore(db)).rejects.toThrow(
        'OWNER_APPROVAL_MIGRATION_REQUIRED',
      );
      expect(
        (await db.query('SELECT * FROM _smrt_owner_tool_holds')).rows,
      ).toHaveLength(0);
    },
  );

  it('deduplicates concurrent stable host requests through one canonical approval and preserves expiry after reopen', async () => {
    const stable = { ...input, requestKey: 'application/run/action' };
    const records = await Promise.all([
      authority.request(stable),
      authority.request(stable),
      authority.request(stable),
    ]);
    expect(new Set(records.map((r) => r.id)).size).toBe(1);
    const saved = records[0];
    now += 10_000;
    authority = await open();
    expect(await authority.request(stable)).toStrictEqual(saved);
    expect(await authority.list(owner, false)).toHaveLength(1);
    expect(
      (
        await db.query(
          'SELECT COUNT(*) AS n FROM approval_requests WHERE tenant_id = ?',
          tenantId,
        )
      ).rows[0].n,
    ).toBe(1);
    await expect(
      authority.request({ ...stable, args: { id: 'another' } }),
    ).rejects.toThrow('conflict');
    await expect(
      authority.request({
        ...stable,
        context: { ...input.context, widened: true },
      }),
    ).rejects.toThrow('conflict');
    await expect(
      authority.request({ ...stable, tool: 'invoices.purge' }),
    ).rejects.toThrow('conflict');
    const foreign = await authority.request({
      ...stable,
      tenantId: randomUUID(),
    });
    expect(foreign.id).not.toBe(saved.id);
  });
  it('repairs an interrupted native envelope link using the original canonical request key', async () => {
    const stable = { ...input, requestKey: 'recovery' };
    const saved = await authority.request(stable);
    await db.query(
      'UPDATE _smrt_owner_tool_holds SET gate_id = NULL WHERE tenant_id = ? AND id = ?',
      tenantId,
      saved.id,
    );
    now += 30_000;
    authority = await open();
    expect(await authority.request(stable)).toStrictEqual(saved);
    expect(
      (
        await db.query(
          'SELECT COUNT(*) AS n FROM approval_requests WHERE tenant_id = ?',
          tenantId,
        )
      ).rows[0].n,
    ).toBe(1);
    now += 40_000;
    expect((await authority.request(stable)).status).toBe('expired');
    expect((await authority.get(tenantId, saved.id))?.expiresAt).toBe(
      saved.expiresAt,
    );
  });
  it('refuses stable host requests on legacy stores before inserting an envelope', async () => {
    let inserts = 0;
    const legacy: OwnerApprovalStore = {
      insert: async () => {
        inserts++;
      },
      get: async () => null,
      list: async () => [],
      transition: async () => false,
    };
    const unsupported = new OwnerApprovalAuthority(
      legacy,
      async () => true,
      () => now,
    );
    await expect(
      unsupported.request({ ...input, requestKey: 'stable' }),
    ).rejects.toThrow('invalid_request');
    expect(inserts).toBe(0);
  });
  it('reopens a non-thread continuation and records one original-caller result under concurrent resume', async () => {
    let executions = 0;
    const principal = {
      id: owner.id,
      tenantId,
      permissions: ['invoices.delete'],
      allowedTools: ['invoices.delete'],
    };
    const first = new OwnerApprovalContinuations(authority, {});
    const hold = await first.capture(principal, () =>
      first.adapter('delete', 'continuation').request(input),
    );
    principal.permissions.push('secret.read');
    const reopened = new OwnerApprovalContinuations(await open(), {
      delete: async (record) => {
        expect(record.continuation?.principal.permissions).toEqual([
          'invoices.delete',
        ]);
        expect(record.requestedBy).toBe(owner.id);
        expect(record.args).toEqual({ id: 'invoice-1' });
        executions++;
        return { deleted: record.args.id };
      },
    });
    await authority.decide(owner, hold.id, true);
    const results = await Promise.allSettled([
      reopened.resume(owner, hold.id),
      reopened.resume(owner, hold.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(executions).toBe(1);
    expect(await reopened.outcome(owner, hold.id)).toMatchObject({
      status: 'succeeded',
      result: { deleted: 'invoice-1' },
    });
    await expect(
      reopened.outcome({ ...owner, id: 'someone-else' }, hold.id),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(reopened.resume(owner, hold.id)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('resumes a pending hold from a closed and reopened database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owner-continuation-'));
    try {
      await db.close();
      const options = {
        type: databaseType,
        url: join(directory, 'holds.sqlite'),
        classes: [
          '@happyvertical/smrt-approvals:ApprovalRequest',
          '@happyvertical/smrt-approvals:ApprovalEvent',
          '@happyvertical/smrt-approvals:ApprovalPolicy',
        ],
      };
      db = await getTestDatabase(options);
      authority = await open();
      const first = new OwnerApprovalContinuations(authority, {});
      const hold = await first.capture(
        {
          id: owner.id,
          tenantId,
          permissions: [input.tool],
          allowedTools: [input.tool],
        },
        () => first.adapter('disk', 'continuation').request(input),
      );
      await db.close();
      db = await getTestDatabase(options);
      authority = await open();
      let count = 0;
      const reopened = new OwnerApprovalContinuations(authority, {
        disk: async () => ({ executions: ++count }),
      });
      expect(await reopened.decide(owner, hold.id, true)).toMatchObject({
        status: 'succeeded',
        result: { executions: 1 },
      });
      await db.close();
      db = await getTestDatabase(options);
      authority = await open();
      expect(
        await new OwnerApprovalContinuations(authority, {}).outcome(
          owner,
          hold.id,
        ),
      ).toMatchObject({ status: 'succeeded', result: { executions: 1 } });
      expect(count).toBe(1);
    } finally {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains native binding and lets the executor consume and complete its own hold once', async () => {
    const continuations = new OwnerApprovalContinuations(authority, {
      native: async (record) => {
        expect(record.context).toEqual(input.context);
        await authority.consume(tenantId, record.id);
        await authority.complete(tenantId, record.id, true, { revision: 2 });
      },
    });
    const hold = await continuations.capture(
      {
        id: owner.id,
        tenantId,
        permissions: ['invoices.delete'],
        allowedTools: ['invoices.delete'],
        clientName: 'Claude Desktop',
      },
      () => continuations.adapter('native').request(input),
    );
    expect(hold.summary).toBe(`Claude Desktop: ${input.summary}`);
    expect(await continuations.decide(owner, hold.id, true)).toMatchObject({
      status: 'succeeded',
      result: { revision: 2 },
    });
    await expect(
      continuations.adapter('native').request(input),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('shares a native executor between an owner decision and concurrent catalog recovery', async () => {
    let executions = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const continuations = new OwnerApprovalContinuations(authority, {
      native: async (record) => {
        executions++;
        await barrier;
        await authority.consume(tenantId, record.id);
        await authority.complete(tenantId, record.id, true, { deleted: true });
      },
    });
    const hold = await continuations.capture(
      {
        id: owner.id,
        tenantId,
        permissions: ['invoices.delete'],
        allowedTools: ['invoices.delete'],
      },
      () => continuations.adapter('native').request(input),
    );
    const deciding = continuations.decide(owner, hold.id, true);
    await expect.poll(() => executions).toBe(1);
    const recovering = continuations.resume(owner, hold.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executions).toBe(1);
    release();
    expect(
      (await Promise.all([deciding, recovering])).map(
        (record) => record.status,
      ),
    ).toEqual(['succeeded', 'succeeded']);
    expect(executions).toBe(1);
    await expect(continuations.resume(owner, hold.id)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('denies and expires non-thread continuations without running their executor', async () => {
    let executions = 0;
    const c = new OwnerApprovalContinuations(authority, {
      test: async () => executions++,
    });
    const request = () =>
      c.capture(
        { id: owner.id, tenantId, permissions: [], allowedTools: [input.tool] },
        () => c.adapter('test', 'continuation').request(input),
      );
    const denied = await request();
    expect((await c.decide(owner, denied.id, false)).status).toBe('denied');
    const expired = await request();
    now += 60_001;
    await expect(c.decide(owner, expired.id, true)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(executions).toBe(0);
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
  it('pins the deciding actor before an asynchronous owner check yields', async () => {
    let release!: () => void;
    const checked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guarded = new OwnerApprovalAuthority(
      await createOwnerApprovalStore(db, () => now),
      async (actor) => {
        const allowed = actor.id === owner.id && actor.tenantId === tenantId;
        await checked;
        return allowed;
      },
      () => now,
    );
    const record = await guarded.request(input);
    const actor = { ...owner };
    const decision = guarded.decide(actor, record.id, true);
    actor.id = 'impersonated-after-check';
    actor.tenantId = randomUUID();
    release();
    expect(await decision).toMatchObject({
      status: 'approved',
      decidedBy: owner.id,
      tenantId,
    });
  });
  it('resumes a continuation from a non-expiring legacy SQLite store beyond the default TTL', async () => {
    // Test-local legacy host storage: preserves the full inert envelope and uses SQL CAS.
    // The canonical ApprovalService store remains bounded and is not wrapped or bypassed.
    await db.query(
      'CREATE TABLE _smrt_legacy_continuation_fixture (tenant TEXT, id TEXT, status TEXT, body TEXT, PRIMARY KEY (tenant, id))',
    );
    const store: OwnerApprovalStore = {
      supportsNonExpiring: true,
      async insert(record) {
        await db.query(
          'INSERT INTO _smrt_legacy_continuation_fixture VALUES (?, ?, ?, ?)',
          record.tenantId,
          record.id,
          record.status,
          JSON.stringify(record),
        );
      },
      async get(tenant, id) {
        const row = (
          await db.query(
            'SELECT body FROM _smrt_legacy_continuation_fixture WHERE tenant = ? AND id = ?',
            tenant,
            id,
          )
        ).rows[0];
        return row ? (JSON.parse(String(row.body)) as OwnerApproval) : null;
      },
      async list(tenant) {
        return (
          await db.query(
            'SELECT body FROM _smrt_legacy_continuation_fixture WHERE tenant = ?',
            tenant,
          )
        ).rows.map((row) => JSON.parse(String(row.body)) as OwnerApproval);
      },
      async transition(tenant, id, from, to, when, patch) {
        const record = await store.get(tenant, id);
        if (!record || record.expiresAt <= when) return false;
        const next = {
          ...record,
          status: to,
          ...(from === 'pending'
            ? (patch ?? {})
            : patch?.result === undefined
              ? {}
              : { result: patch.result }),
        };
        const changed = await db.query(
          'UPDATE _smrt_legacy_continuation_fixture SET status = ?, body = ? WHERE tenant = ? AND id = ? AND status = ? RETURNING id',
          to,
          JSON.stringify(next),
          tenant,
          id,
          from,
        );
        return changed.rows.length === 1;
      },
    };
    const reopen = () =>
      new OwnerApprovalAuthority(
        store,
        async (actor) => actor.id === owner.id && actor.tenantId === tenantId,
        () => now,
        { nonExpiring: true, maxInputChars: 4_000_000 },
      );
    const first = new OwnerApprovalContinuations(reopen(), {});
    const saved = await first.capture(
      {
        id: owner.id,
        tenantId,
        permissions: [input.tool],
        allowedTools: [input.tool],
      },
      () =>
        first
          .adapter('legacy', 'continuation')
          .request({ ...input, context: { review: 'x'.repeat(140_000) } }),
    );
    expect(saved.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
    now += 30 * 24 * 60 * 60_000;
    let executions = 0;
    const reopened = new OwnerApprovalContinuations(reopen(), {
      legacy: async (record) => {
        expect(record.args).toEqual({ id: 'invoice-1' });
        expect(String(record.context.review)).toHaveLength(140_000);
        return { deleted: record.args.id, executions: ++executions };
      },
    });
    await expect(
      reopened.decide({ ...owner, tenantId: 'foreign' }, saved.id, true),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await reopened.decide(owner, saved.id, true)).toMatchObject({
      status: 'succeeded',
      result: { deleted: 'invoice-1', executions: 1 },
    });
    await expect(reopened.resume(owner, saved.id)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await reopened.outcome(owner, saved.id)).toMatchObject({
      status: 'succeeded',
      result: { executions: 1 },
    });
    expect(executions).toBe(1);
  });

  it.each([
    'continuation',
    'executor',
  ] as const)('a settled wait observes %s consumption through the recorded result', async (consumption) => {
    let release!: () => void;
    let started!: () => void;
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const c = new OwnerApprovalContinuations(authority, {
      test: async (record) => {
        if (consumption === 'executor')
          await authority.consume(tenantId, record.id);
        started();
        await finish;
        const result = { deleted: record.args.id };
        if (consumption === 'executor')
          await authority.complete(tenantId, record.id, true, result);
        return result;
      },
    });
    const hold = await c.capture(
      {
        id: owner.id,
        tenantId,
        permissions: [input.tool],
        allowedTools: [input.tool],
      },
      () => c.adapter('test', consumption).request(input),
    );
    const observer = await open();
    const abort = new AbortController();
    let settled = false;
    const observed = observer
      .wait(tenantId, hold.id, abort.signal, { settled: true })
      .then((record) => {
        settled = true;
        return record;
      });
    try {
      await authority.decide(owner, hold.id, true);
      expect((await observer.wait(tenantId, hold.id))?.status).toBe('approved');
      await new Promise((resolve) => setTimeout(resolve, 125));
      expect(settled).toBe(false);
      const resumed = c.resume(owner, hold.id);
      await executing;
      expect((await observer.get(tenantId, hold.id))?.status).toBe('executing');
      await new Promise((resolve) => setTimeout(resolve, 125));
      expect(settled).toBe(false);
      release();
      await resumed;
      expect(await observed).toMatchObject({
        status: 'succeeded',
        result: { deleted: 'invoice-1' },
      });
    } finally {
      release();
      abort.abort();
      await observed;
    }
  });

  it('keeps the canonical store bounded even when a host asks for indefinite compatibility', async () => {
    const store = await createOwnerApprovalStore(db, () => now);
    expect(
      () =>
        new OwnerApprovalAuthority(
          store,
          async () => true,
          () => now,
          { nonExpiring: true },
        ),
    ).toThrow('invalid_request');
    const saved = await authority.request(input);
    expect(saved.expiresAt).toBe(now + 60_000);
  });
});
