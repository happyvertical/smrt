/**
 * AssetAssociation tenant-scoping regression tests (S5 #1396).
 *
 * AssetAssociation exposes generated `api`/`mcp` `create` routes. Before this
 * fix it was NOT `@TenantScoped`, so the #1540 generated-route tenant-context
 * filter (which only constrains models that ARE tenant-scoped) didn't cover
 * it — a caller could forge a polymorphic link between an asset and an
 * arbitrary object across tenant boundaries. These tests assert the model now
 * carries a persisted, nullable `tenantId`.
 *
 * Real in-memory SQLite per SMRT testing conventions (no DB mocking).
 */
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssetAssociation } from '../asset-association';
import { AssetAssociationCollection } from '../asset-associations';

describe('AssetAssociation tenant scoping', () => {
  let db: DatabaseInterface;
  let collection: AssetAssociationCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    collection = await AssetAssociationCollection.create({ db });
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('persists a tenantId and round-trips it on reload', async () => {
    const created = (await collection.create({
      assetId: 'asset-1',
      metaType: '@happyvertical/smrt-content:Article',
      metaId: 'article-1',
      role: 'attachment',
      tenantId: 'tenant-a',
    })) as AssetAssociation;

    expect(created.tenantId).toBe('tenant-a');

    const reloaded = (await collection.get({
      id: created.id!,
    })) as AssetAssociation | null;
    expect(reloaded).not.toBeNull();
    expect(reloaded?.tenantId).toBe('tenant-a');
  });

  it('allows a null (global) tenantId', async () => {
    const created = (await collection.create({
      assetId: 'asset-2',
      metaType: '@happyvertical/smrt-content:Article',
      metaId: 'article-2',
      role: 'attachment',
    })) as AssetAssociation;

    expect(created.tenantId).toBeNull();

    const reloaded = (await collection.get({
      id: created.id!,
    })) as AssetAssociation | null;
    expect(reloaded?.tenantId ?? null).toBeNull();
  });

  it('keeps associations from different tenants distinct', async () => {
    const a = (await collection.create({
      assetId: 'asset-3',
      metaType: '@happyvertical/smrt-content:Article',
      metaId: 'shared',
      role: 'attachment',
      tenantId: 'tenant-a',
    })) as AssetAssociation;
    const b = (await collection.create({
      assetId: 'asset-4',
      metaType: '@happyvertical/smrt-content:Article',
      metaId: 'shared',
      role: 'attachment',
      tenantId: 'tenant-b',
    })) as AssetAssociation;

    expect(a.tenantId).toBe('tenant-a');
    expect(b.tenantId).toBe('tenant-b');
    expect(a.id).not.toBe(b.id);
  });
});
