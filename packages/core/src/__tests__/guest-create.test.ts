/**
 * Guest creates (#5196, slice E): projection, limits and the plain insert.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AuditEntry, type AuditWriter, GUEST_AUDIT_ACTOR } from '../audit';
import { field, foreignKey } from '../decorators/index.js';
import {
  clientKeyFor,
  createGuestCreateLimiter,
  defineGuestCreate,
  executeGuestCreate,
  GuestCreateBodyError,
  projectGuestBody,
} from '../guest-create';
import { BoundedSlidingWindowRateLimiter } from '../http';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt({
  packageName: '@test/gcrel5196',
  tenantScoped: true,
  collection: 'gcrel5196_parents',
})
class GcRelParent5196 extends SmrtObject {
  @field() title = '';
}

@smrt({
  packageName: '@test/gcrel5196',
  tenantScoped: true,
  collection: 'gcrel5196_items',
})
class GcRelItem5196 extends SmrtObject {
  @field() title = '';
  @foreignKey('GcRelParent5196') parentId = '';
}

const TABLE = 'guest_contact_messages';
const AUDIT_TABLE = 'guest_audit_probe';

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

describe('guest create (#5196)', () => {
  let db: DatabaseInterface;
  const config = defineGuestCreate('GuestContactMessage', {
    allowedFields: ['name', 'email', 'message'],
    maxStringLength: 50,
  });

  let failAudit = false;
  const entries: AuditEntry[] = [];
  const writer: AuditWriter = async (entry, handle) => {
    if (failAudit) throw new Error('audit sink down');
    entries.push(entry);
    await handle.query(
      `INSERT INTO ${AUDIT_TABLE} (id, actor_kind, resource_id) VALUES (?, ?, ?)`,
      `a${entries.length}`,
      entry.callerKind ?? 'user',
      entry.resourceId,
    );
  };

  beforeEach(async () => {
    failAudit = false;
    entries.length = 0;
    db = (await getTestDatabase({ classes: [] })) as DatabaseInterface;
    await db.query(
      `CREATE TABLE ${AUDIT_TABLE} (id TEXT PRIMARY KEY, actor_kind TEXT, resource_id TEXT)`,
    );
    await db.query(
      `CREATE TABLE ${TABLE} (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT,
        email TEXT,
        message TEXT,
        secret TEXT,
        UNIQUE (tenant_id, email)
      )`,
    );
  });
  afterEach(async () => {
    await db.close?.();
  });

  const run = (over: Record<string, unknown> = {}) =>
    executeGuestCreate({
      db,
      table: TABLE,
      tenantId: 't1',
      body: { name: 'A', email: 'a@x.test', message: 'hi' },
      config,
      limiter: createGuestCreateLimiter(),
      clientKey: '1.2.3.4',
      audit: { writer, resourceType: 'GuestContactMessage' },
      ...over,
    });

  describe('defineGuestCreate', () => {
    it.each([
      'id',
      'tenantId',
      'tenant_id',
      'ownerId',
      'userId',
      'createdAt',
      'updated_at',
    ])('rejects protected field %s', (field) => {
      expect(() =>
        defineGuestCreate('Anything', { allowedFields: ['name', field] }),
      ).toThrow(/protected/);
    });

    it('rejects extra app-protected fields and empty lists', () => {
      expect(() =>
        defineGuestCreate(
          'Anything',
          { allowedFields: ['status'] },
          { protectedFields: ['status'] },
        ),
      ).toThrow(/protected/);
      expect(() =>
        defineGuestCreate('Anything', { allowedFields: [] }),
      ).toThrow(/non-empty/);
    });

    it('refuses an unregistered model instead of skipping the field checks', () => {
      expect(() =>
        defineGuestCreate(
          'contact_messages',
          { allowedFields: ['name'] },
          { className: 'NoSuchModel5196' },
        ),
      ).toThrow(/not registered/);
      // Without a class name the legacy name-only checks still apply.
      expect(() =>
        defineGuestCreate('contact_messages', { allowedFields: ['name'] }),
      ).not.toThrow();
    });

    it('rejects a relation field: a foreign key is checked without row-level security', () => {
      expect(() =>
        defineGuestCreate(
          'gcrel5196_items',
          { allowedFields: ['title', 'parentId'] },
          { className: 'GcRelItem5196' },
        ),
      ).toThrow(/relation/);
      expect(
        defineGuestCreate(
          'gcrel5196_items',
          { allowedFields: ['title'] },
          { className: 'GcRelItem5196' },
        ).allowedFields,
      ).toEqual(['title']);
    });

    it('freezes the resolved config', () => {
      expect(Object.isFrozen(config)).toBe(true);
      expect(config.allowedFields).toEqual(['name', 'email', 'message']);
    });
  });

  describe('projectGuestBody', () => {
    it('drops unknown, protected and nested values', () => {
      const out = projectGuestBody(
        {
          name: 'A',
          id: 'evil',
          tenant_id: 'other',
          tenantId: 'other',
          secret: 'x',
          message: { nested: true },
          email: 'e@x.test',
        },
        config,
      );
      expect(out).toEqual({ name: 'A', email: 'e@x.test' });
    });

    it('ignores inherited keys', () => {
      const body = Object.create({ name: 'inherited' });
      expect(projectGuestBody(body, config)).toEqual({});
    });

    it('enforces body and string caps', () => {
      expect(() => projectGuestBody({ name: 'x'.repeat(51) }, config)).toThrow(
        GuestCreateBodyError,
      );
      const tiny = defineGuestCreate('Tiny', {
        allowedFields: ['name'],
        maxBodyBytes: 20,
      });
      expect(() => projectGuestBody({ name: 'x'.repeat(30) }, tiny)).toThrow(
        /too large/,
      );
      expect(() => projectGuestBody([], config)).toThrow(/object/);
    });
  });

  describe('executeGuestCreate', () => {
    it('inserts only allowed fields with server id and tenant', async () => {
      const result = await run({
        body: {
          name: 'A',
          email: 'a@x.test',
          secret: 's',
          id: 'evil',
          tenant_id: 'other',
        },
      });
      expect(result).toEqual({ status: 'created', retryAfterSeconds: 0 });
      expect(Object.keys(result).sort()).toEqual([
        'retryAfterSeconds',
        'status',
      ]);
      const rows = rowsOf(await db.query(`SELECT * FROM ${TABLE}`));
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe('t1');
      expect(rows[0].id).not.toBe('evil');
      expect(rows[0].secret).toBeNull();
      expect(rows[0].name).toBe('A');
    });

    it('returns an identical result on a unique conflict', async () => {
      const limiter = createGuestCreateLimiter();
      const first = await run({ limiter });
      const second = await run({ limiter });
      expect(second).toEqual(first);
      expect(rowsOf(await db.query(`SELECT * FROM ${TABLE}`))).toHaveLength(1);
    });

    it('trips the per-client limit with retryAfter and writes nothing', async () => {
      const limiter = createGuestCreateLimiter({ perClient: 2 });
      const now = 1_000_000;
      for (const n of [1, 2]) {
        const r = await run({
          limiter,
          nowMs: now,
          body: { email: `u${n}@x.test` },
        });
        expect(r.status).toBe('created');
      }
      const limited = await run({
        limiter,
        nowMs: now + 1_000,
        body: { email: 'u3@x.test' },
      });
      expect(limited).toEqual({
        status: 'rate_limited',
        retryAfterSeconds: 59,
      });
      expect(rowsOf(await db.query(`SELECT * FROM ${TABLE}`))).toHaveLength(2);
      // Another client of the same tenant is unaffected.
      const other = await run({
        limiter,
        nowMs: now + 1_000,
        clientKey: '9.9.9.9',
        body: { email: 'u4@x.test' },
      });
      expect(other.status).toBe('created');
    });

    it('trips the per-tenant limit across clients', async () => {
      const limiter = createGuestCreateLimiter({ perTenant: 2 });
      const now = 5_000;
      await run({
        limiter,
        nowMs: now,
        clientKey: 'a',
        body: { email: '1@x' },
      });
      await run({
        limiter,
        nowMs: now,
        clientKey: 'b',
        body: { email: '2@x' },
      });
      const limited = await run({
        limiter,
        nowMs: now,
        clientKey: 'c',
        body: { email: '3@x' },
      });
      expect(limited.status).toBe('rate_limited');
      expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      // A different tenant has its own budget.
      const t2 = await run({
        limiter,
        nowMs: now,
        tenantId: 't2',
        clientKey: 'c',
      });
      expect(t2.status).toBe('created');
    });

    it('records before the write: a conflicting create still spends budget', async () => {
      const limiter = createGuestCreateLimiter({ perClient: 1 });
      await run({ limiter, nowMs: 1 });
      const again = await run({ limiter, nowMs: 2 });
      expect(again.status).toBe('rate_limited');
    });

    it('denies an unknown key when the limiter table is full', async () => {
      const limiter = createGuestCreateLimiter({ maxEntries: 1 });
      await run({ limiter, nowMs: 10 });
      const denied = await run({
        limiter,
        nowMs: 11,
        tenantId: 't9',
        clientKey: 'z',
        body: { email: 'q@x' },
      });
      expect(denied.status).toBe('rate_limited');
      expect(rowsOf(await db.query(`SELECT * FROM ${TABLE}`))).toHaveLength(1);
      expect(
        new BoundedSlidingWindowRateLimiter({
          maxEvents: 1,
          windowMs: 1000,
          maxEntries: 1,
          denyWhenFull: true,
        }),
      ).toBeDefined();
    });

    it('writes the guest audit row in the same savepoint as the insert', async () => {
      await run();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actorId: GUEST_AUDIT_ACTOR,
        callerKind: 'guest',
        action: 'create',
        resourceType: 'GuestContactMessage',
        tenantId: 't1',
      });
      const rows = rowsOf(await db.query(`SELECT * FROM ${TABLE}`));
      expect(entries[0].resourceId).toBe(rows[0].id);
      expect(rowsOf(await db.query(`SELECT * FROM ${AUDIT_TABLE}`))).toEqual([
        { id: 'a1', actor_kind: 'guest', resource_id: rows[0].id },
      ]);
    });

    it('rolls the insert back when the audit write fails', async () => {
      failAudit = true;
      await expect(run()).rejects.toThrow('audit sink down');
      expect(rowsOf(await db.query(`SELECT * FROM ${TABLE}`))).toHaveLength(0);
      expect(
        rowsOf(await db.query(`SELECT * FROM ${AUDIT_TABLE}`)),
      ).toHaveLength(0);
    });

    it('writes no audit row when a conflict inserted nothing', async () => {
      const limiter = createGuestCreateLimiter();
      await run({ limiter });
      await run({ limiter });
      expect(entries).toHaveLength(1);
    });

    it('refuses a database without nested transactions', async () => {
      const bare = { query: db.query.bind(db) };
      await expect(run({ db: bare })).rejects.toThrow(/nested transactions/);
    });

    it('answers a constraint failure on the submitted values exactly like success, writing nothing', async () => {
      await db.query(
        'CREATE TABLE gc_strict (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL CHECK (length(name) > 2))',
      );
      const strict = defineGuestCreate('gc_strict', {
        allowedFields: ['name'],
      });
      const send = (body: unknown) =>
        executeGuestCreate({
          db,
          table: 'gc_strict',
          tenantId: 't1',
          body,
          config: strict,
          limiter: createGuestCreateLimiter(),
          clientKey: '1.2.3.4',
          audit: { writer, resourceType: 'GcStrict' },
          changeFeed: false,
        });
      const ok = await send({ name: 'long enough' });
      // Violates the CHECK, and a missing NOT NULL column: same answer.
      expect(await send({ name: 'x' })).toEqual(ok);
      expect(await send({})).toEqual(ok);
      expect(rowsOf(await db.query('SELECT * FROM gc_strict'))).toHaveLength(1);
      // The rejected inserts left no audit row.
      expect(entries).toHaveLength(1);
    });

    it('still fails on a real server fault, not as a silent success', async () => {
      await expect(run({ table: 'no_such_table_5196' })).rejects.toBeDefined();
    });

    it('rejects unsafe identifiers', async () => {
      await expect(run({ table: 'x; DROP TABLE y' })).rejects.toThrow(
        /identifier/,
      );
    });
  });

  describe('clientKeyFor', () => {
    const req = (xff?: string) =>
      new Request('http://x.test/', {
        headers: xff ? { 'x-forwarded-for': xff } : {},
      });

    it('collapses IPv6 to /64 so one prefix shares a key', () => {
      const a = clientKeyFor(req('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), 1);
      const b = clientKeyFor(req('2001:DB8:1:2::1'), 1);
      const c = clientKeyFor(req('2001:db8:1:3::1'), 1);
      expect(a).toBe('2001:db8:1:2::/64');
      expect(b).toBe(a);
      expect(c).not.toBe(a);
    });

    it('leaves IPv4 alone and ignores XFF without trusted hops', () => {
      expect(clientKeyFor(req('6.6.6.6, 10.0.0.5'), 1)).toBe('10.0.0.5');
      expect(clientKeyFor(req('6.6.6.6'), 0, '10.1.1.1')).toBe('10.1.1.1');
    });

    it('maps IPv4-mapped IPv6 to IPv4', () => {
      expect(clientKeyFor(req(), 0, '::ffff:1.2.3.4')).toBe('1.2.3.4');
    });
  });
});
