/**
 * Tenant isolation over the sync-apply batch endpoint (#1759).
 *
 * Every sync item flows through `collection.get()` / `save()` / `delete()`,
 * so the tenancy interceptor guards it exactly like plain CRUD: rows outside
 * the caller's tenant are invisible, saves are stamped with the context
 * tenant, and cross-tenant id collisions can never overwrite a foreign row.
 * These tests live here because core cannot depend on tenancy (the
 * interceptor is registered by `enableTenancy()`).
 *
 * Real in-memory SQLite; the real tenant interceptor; no mocking.
 */

import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
  type SyncApplyBatchResponse,
} from '@happyvertical/smrt-core';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';

const VICTIM_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const FRESH_UUID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

// `public: true` isolates tenant behavior from the fail-closed auth gate,
// which is covered in core's sync-apply spec.
@smrt({ api: { public: true } })
@TenantScoped({ mode: 'optional' })
class SyncTenantDoc extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

class SyncTenantDocCollection extends SmrtCollection<SyncTenantDoc> {
  static readonly _itemClass = SyncTenantDoc;
}

function syncRequest(items: unknown[]): Request {
  return new Request('http://local/api/v1/sync/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items }),
  });
}

describe('Sync-apply tenant isolation (#1759)', () => {
  let docs: SyncTenantDocCollection;
  let handler: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    ObjectRegistry.registerCollection('SyncTenantDoc', SyncTenantDocCollection);
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['SyncTenantDoc'],
    });
    docs = await SyncTenantDocCollection.create({ db });

    enableTenancy();

    // Seed tenant-a's row through the normal stack (interceptor stamps it).
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      await docs.create({
        id: VICTIM_UUID,
        title: 'tenant-a-original',
      });
    });

    const api = new APIGenerator({ basePath: '/api/v1' });
    api.registerCollection('synctenantdocs', docs);
    handler = api.generateHandler();
  });

  afterAll(async () => {
    disableTenancy();
    await docs.db?.close?.();
  });

  async function applyAs(
    tenant: string,
    items: unknown[],
  ): Promise<SyncApplyBatchResponse> {
    return withTenant({ tenantId: tenant }, async () => {
      const res = await handler(syncRequest(items));
      expect(res.status).toBe(200);
      return (await res.json()) as SyncApplyBatchResponse;
    });
  }

  async function victimRow(): Promise<SyncTenantDoc | null> {
    return withTenant({ tenantId: 'tenant-a' }, () => docs.get(VICTIM_UUID));
  }

  it('rejects an update targeting another tenant\'s row without failing the batch', async () => {
    const { results } = await applyAs('tenant-b', [
      {
        itemId: 'cross-update',
        object: 'synctenantdocs',
        op: 'update',
        id: VICTIM_UUID,
        payload: { title: 'hijacked' },
      },
      {
        itemId: 'own-create',
        object: 'synctenantdocs',
        op: 'create',
        id: FRESH_UUID,
        payload: { title: 'tenant-b-own' },
      },
    ]);

    // The foreign row is simply not visible to tenant-b.
    expect(results[0]).toMatchObject({
      itemId: 'cross-update',
      status: 'rejected',
      reason: 'not_found',
    });
    // One rejection does not fail the batch.
    expect(results[1].status).toBe('applied');

    const victim = await victimRow();
    expect(victim?.title).toBe('tenant-a-original');
    expect(victim?.tenantId).toBe('tenant-a');
  });

  it('rejects a create colliding with another tenant\'s row id and never overwrites it', async () => {
    const { results } = await applyAs('tenant-b', [
      {
        itemId: 'cross-create',
        object: 'synctenantdocs',
        op: 'create',
        id: VICTIM_UUID,
        payload: { title: 'takeover-attempt' },
      },
    ]);

    expect(results[0]).toMatchObject({
      itemId: 'cross-create',
      status: 'rejected',
      reason: 'id_conflict',
    });

    const victim = await victimRow();
    expect(victim?.title).toBe('tenant-a-original');
    expect(victim?.tenantId).toBe('tenant-a');
  });

  it('treats a delete of an invisible foreign row as a no-op, leaving it intact', async () => {
    const { results } = await applyAs('tenant-b', [
      {
        itemId: 'cross-delete',
        object: 'synctenantdocs',
        op: 'delete',
        id: VICTIM_UUID,
      },
    ]);

    // Not visible ⇒ idempotent no-op from tenant-b's perspective…
    expect(results[0].status).toBe('applied');
    // …and the foreign row is untouched.
    expect((await victimRow())?.title).toBe('tenant-a-original');
  });

  it('stamps sync creates with the context tenant and strips forged payload tenantIds', async () => {
    const freshId = 'cccccccc-3333-4333-8333-cccccccccccc';
    const { results } = await applyAs('tenant-b', [
      {
        itemId: 'stamped-create',
        object: 'synctenantdocs',
        op: 'create',
        id: freshId,
        payload: { title: 'stamped', tenantId: 'tenant-a' },
      },
    ]);
    expect(results[0].status).toBe('applied');

    const created = await withTenant({ tenantId: 'tenant-b' }, () =>
      docs.get(freshId),
    );
    expect(created?.tenantId).toBe('tenant-b');
    // Invisible to other tenants.
    expect(
      await withTenant({ tenantId: 'tenant-a' }, () => docs.get(freshId)),
    ).toBeNull();
  });

  it('applies same-tenant updates through the sync path', async () => {
    const { results } = await applyAs('tenant-a', [
      {
        itemId: 'own-update',
        object: 'synctenantdocs',
        op: 'update',
        id: VICTIM_UUID,
        payload: { title: 'tenant-a-updated' },
      },
    ]);
    expect(results[0].status).toBe('applied');
    expect((await victimRow())?.title).toBe('tenant-a-updated');
  });
});
