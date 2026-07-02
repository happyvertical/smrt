/**
 * Integration tests for the idempotent sync-apply batch endpoint (#1759) on
 * the runtime REST generator, over a real in-memory SQLite database (never
 * mocked, per repo testing rules).
 *
 * Covers the acceptance criteria of the shared web/mobile write contract:
 * - Replaying an identical batch N times yields identical database state and
 *   identical per-item results.
 * - Per-item authorization rejection without failing the batch.
 * - Malformed client UUIDs are rejected per-item.
 * - Stale updated-at writes are resolved server-authoritatively (skipped) and
 *   reported as `conflict`.
 * - Plain CRUD create still strips client-supplied `id` (the #1540
 *   mass-assignment guard is untouched); only the validated envelope `id`
 *   carries a client id, and only on the sync path.
 *
 * Tenant isolation over the same endpoint is covered in
 * packages/tenancy/src/__tests__/sync-apply-tenant-isolation.spec.ts (core
 * cannot depend on tenancy).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import type { SyncApplyBatchResponse } from '../sync/apply';
import { getTestDatabase } from '../testing/database';
import { APIGenerator } from './rest';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const UUID_D = '44444444-4444-4444-8444-444444444444';
const UUID_E = '55555555-5555-4555-8555-555555555555';
const UUID_F = '66666666-6666-4666-8666-666666666666';
const UUID_G = '77777777-7777-4777-8777-777777777777';
const UUID_GONE = '99999999-9999-4999-8999-999999999999';

// `public: true` isolates contract behavior from the fail-closed auth gate,
// which has its own tests below (mirrors issue-1540-rest-writable.spec.ts).
@smrt({ api: { public: true } })
class SyncApplyNote extends SmrtObject {
  @field({ type: 'text' })
  title: string = '';

  @field({ type: 'integer' })
  priority: number = 0;

  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;

  @field({ type: 'text', readonly: true })
  internalCode: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
    if (options.priority !== undefined) this.priority = options.priority;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.internalCode !== undefined)
      this.internalCode = options.internalCode;
  }
}

class SyncApplyNoteCollection extends SmrtCollection<SyncApplyNote> {
  static readonly _itemClass = SyncApplyNote;
}

// No `public` flag → mutations require auth (fail-closed, #1540).
@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
class SyncApplyVault extends SmrtObject {
  @field({ type: 'text' })
  title: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
  }
}

class SyncApplyVaultCollection extends SmrtCollection<SyncApplyVault> {
  static readonly _itemClass = SyncApplyVault;
}

// `update`/`delete` excluded from the API → sync must gate them identically.
@smrt({ api: { include: ['list', 'get', 'create'], public: true } })
class SyncApplyLimited extends SmrtObject {
  @field({ type: 'text' })
  title: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
  }
}

class SyncApplyLimitedCollection extends SmrtCollection<SyncApplyLimited> {
  static readonly _itemClass = SyncApplyLimited;
}

function syncRequest(items: unknown[]): Request {
  return new Request('http://local/api/v1/sync/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items }),
  });
}

describe('Sync-apply batch endpoint (#1759)', () => {
  ObjectRegistry.registerCollection('SyncApplyNote', SyncApplyNoteCollection);
  ObjectRegistry.registerCollection('SyncApplyVault', SyncApplyVaultCollection);
  ObjectRegistry.registerCollection(
    'SyncApplyLimited',
    SyncApplyLimitedCollection,
  );

  let notes: SyncApplyNoteCollection;
  let vaults: SyncApplyVaultCollection;
  let limited: SyncApplyLimitedCollection;
  let handler: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['SyncApplyNote', 'SyncApplyVault', 'SyncApplyLimited'],
    });
    notes = await SyncApplyNoteCollection.create({ db });
    vaults = await SyncApplyVaultCollection.create({ db });
    limited = await SyncApplyLimitedCollection.create({ db });

    const api = new APIGenerator({ basePath: '/api/v1' });
    api.registerCollection('syncapplynotes', notes);
    api.registerCollection('syncapplyvaults', vaults);
    api.registerCollection('syncapplylimiteds', limited);
    handler = api.generateHandler();
  });

  afterAll(async () => {
    await notes.db?.close?.();
  });

  async function apply(items: unknown[]): Promise<SyncApplyBatchResponse> {
    const res = await handler(syncRequest(items));
    expect(res.status).toBe(200);
    return (await res.json()) as SyncApplyBatchResponse;
  }

  /** Full observable table state (public JSON, includes timestamps). */
  async function noteState(): Promise<unknown> {
    const rows = await notes.list({ orderBy: 'id' });
    return JSON.parse(
      JSON.stringify(rows.map((row) => row.toPublicJSON())),
    );
  }

  describe('batch envelope', () => {
    it('rejects a body without an items array (batch-level 400)', async () => {
      const res = await handler(
        new Request('http://local/api/v1/sync/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nope: true }),
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_batch');
    });

    it('rejects invalid JSON (batch-level 400)', async () => {
      const res = await handler(
        new Request('http://local/api/v1/sync/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'not-json{',
        }),
      );
      expect(res.status).toBe(400);
    });

    it('only accepts POST on the sync route', async () => {
      const res = await handler(new Request('http://local/api/v1/sync/apply'));
      expect(res.status).toBe(405);
    });
  });

  describe('idempotent replay', () => {
    it('replaying an identical batch 3x yields identical state and identical per-item results', async () => {
      // Seed a pre-existing row the batch updates (the common outbox shape:
      // one coalesced mutation per row).
      const seed = await apply([
        {
          itemId: 'seed-1',
          object: 'syncapplynotes',
          op: 'create',
          id: UUID_A,
          payload: { title: 'replay-pre', priority: 1 },
        },
      ]);
      expect(seed.results[0].status).toBe('applied');

      const batch = [
        {
          itemId: 'it-1',
          object: 'syncapplynotes',
          op: 'create',
          id: UUID_B,
          payload: { title: 'replay-created', priority: 2 },
        },
        {
          itemId: 'it-2',
          object: 'syncapplynotes',
          op: 'update',
          id: UUID_A,
          payload: { priority: 9 },
        },
        {
          itemId: 'it-3',
          object: 'syncapplynotes',
          op: 'delete',
          id: UUID_GONE,
        },
      ];

      const run1 = await apply(batch);
      const state1 = await noteState();

      const run2 = await apply(batch);
      const state2 = await noteState();

      const run3 = await apply(batch);
      const state3 = await noteState();

      expect(run1.results.map((r) => r.status)).toEqual([
        'applied',
        'applied',
        'applied',
      ]);
      // Identical per-item results — including server timestamps — on replay.
      expect(run2).toEqual(run1);
      expect(run3).toEqual(run1);
      // Identical database state (byte-identical rows, no updated_at churn).
      expect(state2).toEqual(state1);
      expect(state3).toEqual(state1);

      const updated = await notes.get(UUID_A);
      expect(updated?.priority).toBe(9);
    });

    it('converges (not churns) when a batch creates and deletes the same row', async () => {
      // The degenerate non-coalesced shape: a create whose row a later item
      // in the SAME batch deletes. Replays transiently re-create the row, so
      // the create result carries a fresh server timestamp — statuses and the
      // final database state remain identical (documented in the contract).
      const batch = [
        {
          itemId: 'eph-1',
          object: 'syncapplynotes',
          op: 'create',
          id: UUID_C,
          payload: { title: 'replay-ephemeral' },
        },
        {
          itemId: 'eph-2',
          object: 'syncapplynotes',
          op: 'delete',
          id: UUID_C,
        },
      ];

      const run1 = await apply(batch);
      const state1 = await noteState();
      const run2 = await apply(batch);
      const state2 = await noteState();

      expect(run1.results.map((r) => r.status)).toEqual([
        'applied',
        'applied',
      ]);
      expect(run2.results.map((r) => r.status)).toEqual([
        'applied',
        'applied',
      ]);
      expect(state2).toEqual(state1);
      expect(await notes.get(UUID_C)).toBeNull();
    });

    it('reports deletes of never-existing rows as applied, consistently', async () => {
      const batch = [
        {
          itemId: 'del-1',
          object: 'syncapplynotes',
          op: 'delete',
          id: '88888888-8888-4888-8888-888888888888',
        },
      ];
      const run1 = await apply(batch);
      const run2 = await apply(batch);
      expect(run1.results[0].status).toBe('applied');
      expect(run2).toEqual(run1);
    });
  });

  describe('client UUID validation', () => {
    it('rejects malformed row UUIDs per-item and continues the batch', async () => {
      const { results } = await apply([
        {
          itemId: 'bad-uuid',
          object: 'syncapplynotes',
          op: 'create',
          id: 'not-a-uuid',
          payload: { title: 'never-lands' },
        },
        {
          itemId: 'good-uuid',
          object: 'syncapplynotes',
          op: 'create',
          id: UUID_D,
          payload: { title: 'lands-after-bad-uuid' },
        },
      ]);

      expect(results[0]).toMatchObject({
        itemId: 'bad-uuid',
        status: 'rejected',
        reason: 'invalid_id',
      });
      expect(results[1].status).toBe('applied');
      expect(await notes.get(UUID_D)).not.toBeNull();
      const missing = await notes.list({
        where: { title: 'never-lands' },
      });
      expect(missing).toHaveLength(0);
    });

    it('rejects structurally malformed items without failing the batch', async () => {
      const { results } = await apply([
        'garbage',
        { itemId: 'no-op-field', object: 'syncapplynotes', id: UUID_E },
        {
          itemId: 'ok-after-garbage',
          object: 'syncapplynotes',
          op: 'create',
          id: UUID_E,
          payload: { title: 'lands-after-garbage' },
        },
      ]);
      expect(results[0]).toMatchObject({
        itemId: null,
        status: 'rejected',
        reason: 'invalid_item',
      });
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: 'invalid_item',
      });
      expect(results[2].status).toBe('applied');
    });
  });

  describe('envelope id vs payload (mass-assignment guard intact)', () => {
    it('takes the row id from the envelope and strips payload id/tenantId/readonly fields', async () => {
      const { results } = await apply([
        {
          itemId: 'guard-1',
          object: 'syncapplynotes',
          op: 'create',
          id: UUID_F,
          payload: {
            title: 'guarded-create',
            id: UUID_GONE,
            tenantId: 'attacker-tenant',
            internalCode: 'forged',
            _meta_type: 'forged',
          },
        },
      ]);
      expect(results[0].status).toBe('applied');
      expect(results[0].id).toBe(UUID_F);

      const row = await notes.get(UUID_F);
      expect(row).not.toBeNull();
      expect(row?.id).toBe(UUID_F);
      expect(row?.tenantId).toBeNull();
      expect(row?.internalCode).toBe('');
      expect(await notes.get(UUID_GONE)).toBeNull();
    });
  });

  describe('conflict policy: server-authoritative LWW with updated-at guard', () => {
    it('skips a stale write, reports conflict with the server updatedAt, and is replay-stable', async () => {
      const seed = await apply([
        {
          itemId: 'lww-seed',
          object: 'syncapplynotes',
          op: 'create',
          id: UUID_G,
          payload: { title: 'lww-original', priority: 1 },
        },
      ]);
      const baseUpdatedAt = seed.results[0].updatedAt;
      expect(baseUpdatedAt).toBeTruthy();

      // A newer server-side write lands after the client captured its base.
      await new Promise((resolve) => setTimeout(resolve, 15));
      const serverRow = await notes.get(UUID_G);
      if (!serverRow) throw new Error('seed row missing');
      serverRow.title = 'lww-server-newer';
      await serverRow.save();
      const serverUpdatedAt = (serverRow.updated_at as Date).toISOString();

      const staleBatch = [
        {
          itemId: 'lww-stale',
          object: 'syncapplynotes',
          op: 'update',
          id: UUID_G,
          payload: { title: 'lww-client-stale' },
          baseUpdatedAt,
        },
      ];

      const run1 = await apply(staleBatch);
      expect(run1.results[0]).toMatchObject({
        itemId: 'lww-stale',
        status: 'conflict',
        reason: 'stale_write',
        updatedAt: serverUpdatedAt,
      });

      // The losing write is skipped — the newer server state survives.
      const afterConflict = await notes.get(UUID_G);
      expect(afterConflict?.title).toBe('lww-server-newer');

      // Replaying the losing item is stable: same conflict, unchanged state.
      const run2 = await apply(staleBatch);
      expect(run2).toEqual(run1);
      expect((await notes.get(UUID_G))?.title).toBe('lww-server-newer');
    });

    it('applies a write whose base matches the current server updated_at', async () => {
      const row = await notes.get(UUID_G);
      if (!row) throw new Error('row missing');
      const freshBase = (row.updated_at as Date).toISOString();

      const { results } = await apply([
        {
          itemId: 'lww-fresh',
          object: 'syncapplynotes',
          op: 'update',
          id: UUID_G,
          payload: { title: 'lww-rebased' },
          baseUpdatedAt: freshBase,
        },
      ]);
      expect(results[0].status).toBe('applied');
      expect((await notes.get(UUID_G))?.title).toBe('lww-rebased');
    });

    it('guards deletes with the same stale check', async () => {
      const row = await notes.get(UUID_G);
      if (!row) throw new Error('row missing');
      const staleBase = new Date(
        (row.updated_at as Date).getTime() - 60_000,
      ).toISOString();

      const { results } = await apply([
        {
          itemId: 'lww-stale-delete',
          object: 'syncapplynotes',
          op: 'delete',
          id: UUID_G,
          baseUpdatedAt: staleBase,
        },
      ]);
      expect(results[0]).toMatchObject({
        status: 'conflict',
        reason: 'stale_write',
      });
      expect(await notes.get(UUID_G)).not.toBeNull();
    });

    it('reports create_conflict when a create replays onto a diverged row', async () => {
      // The row now carries newer content than the original create payload
      // (LWW: the server state wins; the create is not re-applied).
      const { results } = await apply([
        {
          itemId: 'lww-diverged-create',
          object: 'syncapplynotes',
          op: 'create',
          id: UUID_G,
          payload: { title: 'lww-original', priority: 1 },
        },
      ]);
      expect(results[0]).toMatchObject({
        status: 'conflict',
        reason: 'create_conflict',
      });
      expect((await notes.get(UUID_G))?.title).toBe('lww-rebased');
    });
  });

  describe('per-item gating and authorization', () => {
    it('rejects unknown objects and disabled ops per-item without failing the batch', async () => {
      const { results } = await apply([
        {
          itemId: 'unknown-object',
          object: 'nosuchobjects',
          op: 'create',
          id: UUID_D,
          payload: { title: 'x' },
        },
        {
          itemId: 'disabled-op',
          object: 'syncapplylimiteds',
          op: 'update',
          id: UUID_D,
          payload: { title: 'x' },
        },
        {
          itemId: 'allowed-op',
          object: 'syncapplylimiteds',
          op: 'create',
          id: UUID_E,
          payload: { title: 'limited-create-ok' },
        },
      ]);
      expect(results[0]).toMatchObject({
        status: 'rejected',
        reason: 'unknown_object',
      });
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: 'op_not_allowed',
      });
      expect(results[2].status).toBe('applied');
      expect(await limited.get(UUID_E)).not.toBeNull();
    });

    it('fail-closed without auth middleware: non-public objects reject, public ones apply', async () => {
      const { results } = await apply([
        {
          itemId: 'vault-anon',
          object: 'syncapplyvaults',
          op: 'create',
          id: UUID_D,
          payload: { title: 'vault-anon' },
        },
        {
          itemId: 'note-anon',
          object: 'syncapplynotes',
          op: 'update',
          id: UUID_F,
          payload: { priority: 4 },
        },
      ]);
      expect(results[0]).toMatchObject({
        status: 'rejected',
        reason: 'auth_required',
      });
      expect(results[1].status).toBe('applied');
      expect(await vaults.get(UUID_D)).toBeNull();
    });

    it('runs the configured auth middleware per item; one rejection does not fail the batch', async () => {
      const seenActions: Array<[string, string]> = [];
      const guarded = new APIGenerator({
        basePath: '/api/v1',
        authMiddleware: (objectName, action) => async (req) => {
          seenActions.push([objectName, action]);
          // Registered collections resolve to qualified names
          // (e.g. '@happyvertical/smrt-core:SyncApplyVault'), exactly as the
          // plain CRUD path hands them to the middleware.
          if (objectName.includes('SyncApplyVault')) {
            return new Response(JSON.stringify({ error: 'unauthorized' }), {
              status: 401,
            });
          }
          return req;
        },
      });
      guarded.registerCollection('syncapplynotes', notes);
      guarded.registerCollection('syncapplyvaults', vaults);
      const guardedHandler = guarded.generateHandler();

      const res = await guardedHandler(
        syncRequest([
          {
            itemId: 'vault-blocked',
            object: 'syncapplyvaults',
            op: 'create',
            id: UUID_E,
            payload: { title: 'vault-blocked' },
          },
          {
            itemId: 'note-allowed',
            object: 'syncapplynotes',
            op: 'update',
            id: UUID_F,
            payload: { priority: 6 },
          },
        ]),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as SyncApplyBatchResponse;

      expect(body.results[0]).toMatchObject({
        itemId: 'vault-blocked',
        status: 'rejected',
        reason: 'auth_required',
      });
      expect(body.results[1].status).toBe('applied');
      expect(await vaults.get(UUID_E)).toBeNull();
      expect((await notes.get(UUID_F))?.priority).toBe(6);
      // Sync ops surface to the middleware with mutating verb semantics.
      expect(seenActions).toHaveLength(2);
      expect(seenActions[0][0]).toContain('SyncApplyVault');
      expect(seenActions[0][1]).toBe('post');
      expect(seenActions[1][0]).toContain('SyncApplyNote');
      expect(seenActions[1][1]).toBe('put');
    });

    it('maps non-401 middleware rejections to forbidden', async () => {
      const guarded = new APIGenerator({
        basePath: '/api/v1',
        authMiddleware: () => async () =>
          new Response(JSON.stringify({ error: 'nope' }), { status: 403 }),
      });
      guarded.registerCollection('syncapplynotes', notes);
      const guardedHandler = guarded.generateHandler();

      const res = await guardedHandler(
        syncRequest([
          {
            itemId: 'forbidden-1',
            object: 'syncapplynotes',
            op: 'create',
            id: UUID_E,
            payload: { title: 'forbidden-create' },
          },
        ]),
      );
      const body = (await res.json()) as SyncApplyBatchResponse;
      expect(body.results[0]).toMatchObject({
        status: 'rejected',
        reason: 'forbidden',
      });
    });
  });

  describe('update/delete edge semantics', () => {
    it('rejects updates to rows that do not exist', async () => {
      const { results } = await apply([
        {
          itemId: 'missing-update',
          object: 'syncapplynotes',
          op: 'update',
          id: '12121212-1212-4121-8121-121212121212',
          payload: { title: 'ghost' },
        },
      ]);
      expect(results[0]).toMatchObject({
        status: 'rejected',
        reason: 'not_found',
      });
    });
  });

  describe('REGRESSION: plain CRUD mass-assignment guard is untouched (#1540)', () => {
    it('still strips a client-supplied id on plain CRUD create', async () => {
      const clientId = 'abababab-abab-4bab-8bab-abababababab';
      const res = await handler(
        new Request('http://local/api/v1/syncapplynotes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: 'crud-strips-id',
            id: clientId,
            tenantId: 'attacker-tenant',
          }),
        }),
      );
      expect(res.status).toBe(201);
      const created = await res.json();

      // The client-supplied id was ignored; the server generated its own.
      expect(created.id).not.toBe(clientId);
      expect(await notes.get(clientId)).toBeNull();

      const rows = await notes.list({ where: { title: 'crud-strips-id' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).not.toBe(clientId);
      expect(rows[0].tenantId).toBeNull();
    });
  });
});
