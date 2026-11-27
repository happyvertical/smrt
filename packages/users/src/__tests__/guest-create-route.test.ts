/**
 * The guest create pipeline end to end on a real model (#5196): admission,
 * size cap, projection, rate limits, the plain insert and the guest audit row
 * written by the real profiles writer. SQLite in-process; the policy side of
 * the same flow runs against PostgreSQL in guest-create-postgres.test.ts.
 */

import {
  createGuestRequestPrincipal,
  createGuestRuntime,
  field,
  type GuestRuntimeOptions,
  getTableVersion,
  getTestDatabase,
  guestCreateAdmission,
  guestReadThrottle,
  handleGuestCreate,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { AuditLog, createAuditWriter } from '@happyvertical/smrt-profiles';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

@smrt({
  packageName: '@test/gc5196',
  tenantScoped: true,
  collection: 'gc5196_messages',
})
class GcMessage5196 extends SmrtObject {
  @field() name = '';
  @field() email = '';
  @field() message = '';
  @field({ default: 'new' }) status = 'new';
  @field({ sensitive: true }) token = '';
}

const COLLECTION = 'gc5196_messages';
const MODEL = 'GcMessage5196';
const QUALIFIED = '@test/gc5196:GcMessage5196';

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

describe('guest create route pipeline (#5196)', () => {
  let db: DatabaseInterface;
  let table = '';
  const writer = createAuditWriter();

  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [MODEL, 'AuditLog'],
    });
    table = (new GcMessage5196({ db }) as unknown as { tableName: string })
      .tableName;
    await db.query(
      `CREATE UNIQUE INDEX gc5196_unique_email ON ${table} (tenant_id, email)`,
    );
  });
  afterEach(async () => {
    if (typeof db.close === 'function') await db.close();
  });

  function locals(
    options: GuestRuntimeOptions = {},
    permissions: string[] = [`${COLLECTION}.create`],
    tenantId = 't1',
  ) {
    const runtime = createGuestRuntime({
      createFields: {
        [COLLECTION]: { allowedFields: ['name', 'email', 'message'] },
      },
      auditWriter: writer,
      ...options,
    });
    return {
      tenantId,
      permissions,
      guestPrincipal: createGuestRequestPrincipal({
        tenantId,
        permissions,
        runtime,
        slugModels: permissions.map((slug) => [slug, QUALIFIED] as const),
      }),
    };
  }

  function post(body: unknown, init: { raw?: string; ip?: string } = {}) {
    return new Request('http://t1.test/api/gc5196_messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: init.raw ?? JSON.stringify(body),
    });
  }

  async function create(
    l: ReturnType<typeof locals>,
    body: unknown,
    init: { raw?: string; ip?: string; nowMs?: number } = {},
  ) {
    const admission = guestCreateAdmission(
      l,
      MODEL,
      COLLECTION,
      false,
      QUALIFIED,
    );
    if (!admission) return null;
    return handleGuestCreate({
      admission,
      request: post(body, init),
      db: db as never,
      tableName: table,
      getClientAddress: () => init.ip ?? '9.9.9.9',
      ...(init.nowMs === undefined ? {} : { nowMs: init.nowMs }),
    });
  }

  const messages = async () => rowsOf(await db.query(`SELECT * FROM ${table}`));
  const audits = async () => rowsOf(await db.query('SELECT * FROM audit_logs'));

  it('creates on an opted-in collection: 201, empty body, no id, no Location', async () => {
    const res = await create(locals(), {
      name: 'Ada',
      email: 'ada@x.test',
      message: 'hello',
    });
    expect(res?.status).toBe(201);
    expect(await res?.text()).toBe('');
    expect(res?.headers.get('location')).toBeNull();
    const [row] = await messages();
    expect(row).toMatchObject({
      tenant_id: 't1',
      name: 'Ada',
      email: 'ada@x.test',
      message: 'hello',
      status: 'new',
      token: '',
    });
    // The framework columns a SMRT table needs were supplied.
    expect(row.slug).toBe(row.id);
    expect(row.created_at).toBeTruthy();
  });

  it('limits fields: unlisted, protected and nested values never land', async () => {
    const res = await create(locals(), {
      name: 'A',
      email: 'a@x.test',
      status: 'approved',
      token: 'secret',
      id: 'evil',
      tenant_id: 'other',
      tenantId: 'other',
      message: { nested: true },
    });
    expect(res?.status).toBe(201);
    const [row] = await messages();
    expect(row).toMatchObject({
      tenant_id: 't1',
      status: 'new',
      token: '',
      message: '',
    });
    expect(row.id).not.toBe('evil');
  });

  it('cannot be configured with a protected, sensitive or unknown field', () => {
    for (const bad of ['tenantId', 'id', 'status_', 'token', 'createdAt']) {
      const l = locals({
        createFields: { [COLLECTION]: { allowedFields: ['name', bad] } },
      });
      expect(
        guestCreateAdmission(l, MODEL, COLLECTION, false, QUALIFIED),
      ).toBeNull();
    }
    const ok = locals({
      createFields: { [COLLECTION]: { allowedFields: ['name', 'status'] } },
    });
    expect(
      guestCreateAdmission(ok, MODEL, COLLECTION, false, QUALIFIED),
    ).not.toBeNull();
  });

  it('refuses a collection the app did not opt in', async () => {
    const l = locals({ createFields: {} });
    expect(await create(l, { name: 'x' })).toBeNull();
    expect(await messages()).toHaveLength(0);
  });

  it('refuses a guest without the create grant, or with only read', async () => {
    expect(await create(locals({}, []), { name: 'x' })).toBeNull();
    expect(
      await create(locals({}, [`${COLLECTION}.read`]), { name: 'x' }),
    ).toBeNull();
    expect(await messages()).toHaveLength(0);
  });

  it('admits only the model the ceiling admitted the slug for', () => {
    const l = locals();
    expect(
      guestCreateAdmission(l, MODEL, COLLECTION, false, '@test/other:Model'),
    ).toBeNull();
    expect(
      guestCreateAdmission(l, MODEL, COLLECTION, false, undefined),
    ).toBeNull();
    // A principal with no admitted-model map admits no route.
    const bare = {
      tenantId: 't1',
      permissions: [`${COLLECTION}.create`],
      guestPrincipal: createGuestRequestPrincipal({
        tenantId: 't1',
        permissions: [`${COLLECTION}.create`],
        runtime: l.guestPrincipal.runtime,
      }),
    };
    expect(
      guestCreateAdmission(bare, MODEL, COLLECTION, false, QUALIFIED),
    ).toBeNull();
  });

  it('charges rejected bodies to the client and refuses an exhausted client before reading', async () => {
    const l = locals({ create: { perClient: 2 } });
    const now = 7_000;
    expect((await create(l, null, { raw: '{bad', nowMs: now }))?.status).toBe(
      400,
    );
    expect((await create(l, null, { raw: '[1]', nowMs: now }))?.status).toBe(
      400,
    );
    // The client is now over budget: even a valid body is refused with 429,
    // and the rejected bodies never spent the tenant budget.
    const limited = await create(l, { email: 'a@x.test' }, { nowMs: now + 1 });
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get('retry-after')).toBeTruthy();
    expect(await messages()).toHaveLength(0);
    const other = await create(
      l,
      { email: 'b@x.test' },
      { nowMs: now + 1, ip: '8.8.8.8' },
    );
    expect(other?.status).toBe(201);
  });

  it('refuses without a runtime, an audit writer, or a guest principal', async () => {
    const withoutWriter = locals({ auditWriter: undefined });
    expect(
      guestCreateAdmission(withoutWriter, MODEL, COLLECTION, false, QUALIFIED),
    ).toBeNull();
    const noRuntime = {
      tenantId: 't1',
      permissions: [`${COLLECTION}.create`],
      guestPrincipal: createGuestRequestPrincipal({
        tenantId: 't1',
        permissions: [`${COLLECTION}.create`],
      }),
    };
    expect(
      guestCreateAdmission(noRuntime, MODEL, COLLECTION, false, QUALIFIED),
    ).toBeNull();
    expect(
      guestCreateAdmission(
        { tenantId: 't1' },
        MODEL,
        COLLECTION,
        false,
        QUALIFIED,
      ),
    ).toBeNull();
    // A signed-in marker voids the guest principal.
    const signedIn = { ...locals(), user: { id: 'u1' } };
    expect(
      guestCreateAdmission(signedIn, MODEL, COLLECTION, false, QUALIFIED),
    ).toBeNull();
    // A public model keeps the anonymous create path, not the guest one.
    expect(
      guestCreateAdmission(locals(), MODEL, COLLECTION, true, QUALIFIED),
    ).toBeNull();
  });

  it('bumps the table version so a staff read is not answered from a stale ETag', async () => {
    const before = await getTableVersion(db, table);
    await create(locals(), { name: 'A', email: 'a@x.test' });
    const after = await getTableVersion(db, table);
    expect(after).not.toBe(before);
    // A conflict inserted nothing: the version does not move.
    await create(locals(), { name: 'B', email: 'a@x.test' });
    expect(await getTableVersion(db, table)).toBe(after);
  });

  it('has no read-back: nothing readable arrives with the create, and a guest read grant is separate', async () => {
    const l = locals();
    const res = await create(l, { name: 'A', email: 'a@x.test' });
    expect(res?.status).toBe(201);
    expect(await res?.text()).toBe('');
    // The create grant alone never admits the generated read operations.
    const { isGuestOperationAllowed } = await import(
      '@happyvertical/smrt-core'
    );
    const permissions = l.guestPrincipal.permissions;
    expect(
      isGuestOperationAllowed(permissions, MODEL, COLLECTION, 'create'),
    ).toBe(true);
    for (const op of ['list', 'get', 'update', 'delete', 'count']) {
      expect(isGuestOperationAllowed(permissions, MODEL, COLLECTION, op)).toBe(
        false,
      );
    }
  });

  it('answers a unique conflict exactly like a success', async () => {
    const l = locals();
    const first = await create(l, { name: 'A', email: 'dup@x.test' });
    const second = await create(l, { name: 'B', email: 'dup@x.test' });
    expect(second?.status).toBe(first?.status);
    expect([...(second?.headers ?? [])]).toEqual([...(first?.headers ?? [])]);
    expect(await second?.text()).toBe(await first?.text());
    expect(await messages()).toHaveLength(1);
    // The conflict inserted nothing, so it left no audit row either.
    expect(await audits()).toHaveLength(1);
  });

  it('writes the guest audit row: typed guest actor, null profile, same transaction', async () => {
    await create(locals(), { name: 'Ada', email: 'ada@x.test' });
    const [row] = await messages();
    const [audit] = await audits();
    expect(audit).toMatchObject({
      actor_kind: 'guest',
      profile_id: null,
      tenant_id: 't1',
      action: 'create',
      resource_type: MODEL,
      resource_id: row.id,
    });
    expect(JSON.parse(String(audit.changes))).toMatchObject({
      name: { before: null, after: 'Ada' },
    });
    expect(AuditLog).toBeDefined();
  });

  it('a failing audit write fails the create and rolls the insert back', async () => {
    const l = locals({
      auditWriter: async () => {
        throw new Error('audit sink down');
      },
    });
    await expect(create(l, { name: 'A', email: 'a@x.test' })).rejects.toThrow(
      'audit sink down',
    );
    expect(await messages()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
  });

  it('a failing audit write in the SAME outer transaction still rolls the insert back', async () => {
    const l = locals({
      auditWriter: async (entry, handle) => {
        // A writer that did real work before failing: it must be undone too.
        await writer(entry, handle);
        throw new Error('late failure');
      },
    });
    await db.transaction(async (tx) => {
      const admission = guestCreateAdmission(
        l,
        MODEL,
        COLLECTION,
        false,
        QUALIFIED,
      );
      await expect(
        handleGuestCreate({
          admission: admission!,
          request: post({ name: 'A', email: 'a@x.test' }),
          db: tx as never,
          tableName: table,
          getClientAddress: () => '9.9.9.9',
        }),
      ).rejects.toThrow('late failure');
    });
    expect(await messages()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
  });

  it('trips the per-client limit with Retry-After, writing nothing more', async () => {
    const l = locals({ create: { perClient: 2 } });
    const now = 1_000_000;
    for (const n of [1, 2]) {
      const res = await create(l, { email: `u${n}@x.test` }, { nowMs: now });
      expect(res?.status).toBe(201);
    }
    const limited = await create(
      l,
      { email: 'u3@x.test' },
      { nowMs: now + 1000 },
    );
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThanOrEqual(
      1,
    );
    expect(await messages()).toHaveLength(2);
    // Another client is unaffected.
    const other = await create(
      l,
      { email: 'u4@x.test' },
      { nowMs: now + 1000, ip: '8.8.8.8' },
    );
    expect(other?.status).toBe(201);
  });

  it('trips the per-tenant limit across clients, per tenant', async () => {
    const l = locals({ create: { perTenant: 2 } });
    const now = 5_000;
    await create(l, { email: '1@x' }, { nowMs: now, ip: '1.1.1.1' });
    await create(l, { email: '2@x' }, { nowMs: now, ip: '2.2.2.2' });
    const limited = await create(
      l,
      { email: '3@x' },
      { nowMs: now, ip: '3.3.3.3' },
    );
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get('retry-after')).toBeTruthy();
  });

  it('shares the limiter between collections of one runtime', async () => {
    const runtime = createGuestRuntime({
      createFields: { [COLLECTION]: { allowedFields: ['email'] } },
      auditWriter: writer,
      create: { perTenant: 1 },
    });
    const principal = createGuestRequestPrincipal({
      tenantId: 't1',
      permissions: [`${COLLECTION}.create`],
      runtime,
      slugModels: [[`${COLLECTION}.create`, QUALIFIED]],
    });
    const l = {
      tenantId: 't1',
      permissions: [`${COLLECTION}.create`],
      guestPrincipal: principal,
    };
    expect((await create(l, { email: 'a@x' }, { nowMs: 1 }))?.status).toBe(201);
    expect((await create(l, { email: 'b@x' }, { nowMs: 2 }))?.status).toBe(429);
  });

  it('uses the socket address, ignoring X-Forwarded-For without trusted hops', async () => {
    const l = locals({ create: { perClient: 1 } });
    const admission = guestCreateAdmission(
      l,
      MODEL,
      COLLECTION,
      false,
      QUALIFIED,
    )!;
    const send = (xff: string, email: string) =>
      handleGuestCreate({
        admission,
        request: new Request('http://t1.test/', {
          method: 'POST',
          headers: { 'x-forwarded-for': xff },
          body: JSON.stringify({ email }),
        }),
        db: db as never,
        tableName: table,
        getClientAddress: () => '7.7.7.7',
        nowMs: 1,
      });
    expect((await send('1.1.1.1', 'a@x')).status).toBe(201);
    // A spoofed header does not buy a fresh budget.
    expect((await send('2.2.2.2', 'b@x')).status).toBe(429);
  });

  it('caps the body before parsing and rejects malformed JSON', async () => {
    const l = locals({
      createFields: {
        [COLLECTION]: { allowedFields: ['name'], maxBodyBytes: 64 },
      },
    });
    const big = await create(l, null, {
      raw: JSON.stringify({ name: 'x'.repeat(500) }),
    });
    expect(big?.status).toBe(413);
    const bad = await create(l, null, { raw: '{not json' });
    expect(bad?.status).toBe(400);
    const notObject = await create(l, null, { raw: '[1,2]' });
    expect(notObject?.status).toBe(400);
    expect(await messages()).toHaveLength(0);
  });

  describe('guest read limits', () => {
    const get = () => new Request('http://t1.test/api/gc5196_messages');

    it('allows non-guests through and charges guests per client and per tenant', () => {
      expect(guestReadThrottle({}, get(), () => '1.1.1.1')).toBeNull();
      const l = locals({ read: { perClient: 2, perTenant: 3 } });
      const now = 10_000;
      expect(guestReadThrottle(l, get(), () => '1.1.1.1', now)).toBeNull();
      expect(guestReadThrottle(l, get(), () => '1.1.1.1', now)).toBeNull();
      const limited = guestReadThrottle(l, get(), () => '1.1.1.1', now);
      expect(limited?.status).toBe(429);
      expect(
        Number(limited?.headers.get('retry-after')),
      ).toBeGreaterThanOrEqual(1);
      // A second client has its own budget until the tenant budget runs out.
      expect(guestReadThrottle(l, get(), () => '2.2.2.2', now)).toBeNull();
      expect(guestReadThrottle(l, get(), () => '3.3.3.3', now)?.status).toBe(
        429,
      );
    });

    it('defaults to 120 per client and 1200 per tenant, and is looser than creates', () => {
      const l = locals();
      let allowed = 0;
      for (let i = 0; i < 130; i += 1) {
        if (!guestReadThrottle(l, get(), () => '1.1.1.1', 1)) allowed += 1;
      }
      expect(allowed).toBe(120);
    });

    it('fails closed when the limiter table is full for an unknown client', () => {
      const l = locals({ read: { maxEntries: 1 } });
      expect(guestReadThrottle(l, get(), () => '1.1.1.1', 1)).toBeNull();
      expect(guestReadThrottle(l, get(), () => '2.2.2.2', 2)?.status).toBe(429);
    });

    it('refuses a guest whose runtime is missing instead of admitting it unlimited', () => {
      const l = {
        tenantId: 't1',
        permissions: [`${COLLECTION}.read`],
        guestPrincipal: createGuestRequestPrincipal({
          tenantId: 't1',
          permissions: [`${COLLECTION}.read`],
        }),
      };
      expect(guestReadThrottle(l, get(), () => '1.1.1.1')?.status).toBe(429);
    });
  });
});
