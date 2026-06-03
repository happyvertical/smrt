/**
 * Tests for SmrtJunction base class.
 *
 * Covers:
 * 1. byLeft / byRight / attach / detach happy path
 * 2. Key-override defense: caller-supplied opts cannot retarget the fixed
 *    junction key fields (regression test for round-4 codex finding)
 */

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators/index';
import { SmrtJunction } from '../junction';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

@smrt({
  tableName: 'junction_test_links',
  conflictColumns: ['owner_id', 'asset_id', 'relationship'],
  api: { include: ['list', 'get', 'create', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
class JunctionTestLink extends SmrtObject {
  @field({ required: true })
  ownerId = '';

  @field({ required: true })
  assetId = '';

  @field({ required: true })
  relationship = 'attachment';

  @field()
  sortOrder = 0;

  constructor(options: any = {}) {
    super(options);
    if (options.ownerId) this.ownerId = options.ownerId;
    if (options.assetId) this.assetId = options.assetId;
    if (options.relationship !== undefined)
      this.relationship = options.relationship;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
  }
}

// Decorator has empty config — only present so the scanner detects the
// class (FRAMEWORK_BASE_CLASSES doesn't include SmrtJunction). Passing
// api/mcp/cli here would flow through to the item class via
// ObjectRegistry.register(itemClass, {...config}) and clobber the
// model's own decorator config.
@smrt()
class JunctionTestLinkCollection extends SmrtJunction<JunctionTestLink> {
  static readonly _itemClass = JunctionTestLink;
  protected leftField = 'ownerId';
  protected rightField = 'assetId';
}

function tmpDbUrl(name: string): string {
  return `file:${join(tmpdir(), `smrt-junction-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)}`;
}

describe('SmrtJunction', () => {
  let dbPath: string;
  let dbUrl: string;
  let links: JunctionTestLinkCollection;

  beforeEach(async () => {
    dbUrl = tmpDbUrl('basic');
    dbPath = dbUrl.replace('file:', '');
    links = await JunctionTestLinkCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  describe('byLeft / byRight', () => {
    it('finds rows by left and right fields', async () => {
      await links.attach('owner-1', 'asset-a');
      await links.attach('owner-1', 'asset-b');
      await links.attach('owner-2', 'asset-a');

      const byOwner = await links.byLeft('owner-1');
      expect(byOwner).toHaveLength(2);

      const byAsset = await links.byRight('asset-a');
      expect(byAsset).toHaveLength(2);
    });

    it('narrows with opts filter', async () => {
      await links.attach('owner-1', 'asset-a', { relationship: 'thumbnail' });
      await links.attach('owner-1', 'asset-b', { relationship: 'attachment' });

      const thumbs = await links.byLeft('owner-1', {
        relationship: 'thumbnail',
      });
      expect(thumbs).toHaveLength(1);
      expect(thumbs[0]?.assetId).toBe('asset-a');
    });
  });

  describe('key-override defense', () => {
    it('byLeft: opts cannot override the fixed leftField', async () => {
      await links.attach('owner-1', 'asset-a');
      await links.attach('owner-2', 'asset-b');

      // Caller forwards a poisoned filter that includes the left-key field.
      // The explicit argument MUST win — otherwise an attacker controlling
      // opts can retarget the read.
      const result = await links.byLeft('owner-1', {
        ownerId: 'owner-2',
      } as any);

      expect(result).toHaveLength(1);
      expect(result[0]?.ownerId).toBe('owner-1');
    });

    it('byRight: opts cannot override the fixed rightField', async () => {
      await links.attach('owner-1', 'asset-a');
      await links.attach('owner-1', 'asset-b');

      const result = await links.byRight('asset-a', {
        assetId: 'asset-b',
      } as any);

      expect(result).toHaveLength(1);
      expect(result[0]?.assetId).toBe('asset-a');
    });

    it('attach: opts cannot override leftField or rightField in the row data', async () => {
      // Poisoned opts try to steer the row to a different owner+asset.
      await links.attach('owner-1', 'asset-a', {
        ownerId: 'attacker-owner',
        assetId: 'attacker-asset',
      } as any);

      const created = await links.byLeft('owner-1');
      expect(created).toHaveLength(1);
      expect(created[0]?.ownerId).toBe('owner-1');
      expect(created[0]?.assetId).toBe('asset-a');

      const attackerRows = await links.byLeft('attacker-owner');
      expect(attackerRows).toHaveLength(0);
    });

    it('detach: opts cannot override leftField or rightField in the WHERE', async () => {
      await links.attach('owner-1', 'asset-a');
      await links.attach('owner-2', 'asset-b');

      // Poisoned opts ask to detach owner-2/asset-b, but explicit args
      // say owner-1/asset-a. The explicit args must win.
      await links.detach('owner-1', 'asset-a', {
        ownerId: 'owner-2',
        assetId: 'asset-b',
      } as any);

      const owner1 = await links.byLeft('owner-1');
      const owner2 = await links.byLeft('owner-2');
      expect(owner1).toHaveLength(0);
      expect(owner2).toHaveLength(1);
    });
  });

  describe('runtime registration guard', () => {
    it('throws a helpful error when a SmrtJunction subclass has no registered item class', async () => {
      // Define a class that extends SmrtJunction but whose item class
      // ('UnregisteredItem') is never registered with ObjectRegistry —
      // simulating the bug where the scanner failed to pick it up.
      class UnregisteredItem extends SmrtObject {
        ownerId = '';
        assetId = '';
      }

      class StrayJunctionCollection extends SmrtJunction<any> {
        // Cast to any to satisfy the abstract type while keeping the class
        // unregistered in the registry on purpose.
        static readonly _itemClass = UnregisteredItem as any;
        protected leftField = 'ownerId';
        protected rightField = 'assetId';
      }

      await expect(
        StrayJunctionCollection.create({
          db: { type: 'sqlite', url: tmpDbUrl('guard') },
        }),
      ).rejects.toThrow(/has no registered item class/);
    });
  });

  describe('item class config preservation', () => {
    it('collection decorator with empty config does not clobber item class api/mcp/cli', async () => {
      // The test class above declares api/mcp/cli on the MODEL
      // (JunctionTestLink). The collection's @smrt() is intentionally empty
      // so it doesn't override these on the item class's registration.
      // Regression test for round-7 codex finding: passing
      // { api: false, mcp: false, cli: false } on the collection would
      // overwrite the model's own config via
      // ObjectRegistry.register(itemClass, {...config}).
      const registered = ObjectRegistry.getClass('JunctionTestLink');
      expect(registered).toBeTruthy();
      const cfg = registered?.config;
      expect(cfg?.api).toEqual({
        include: ['list', 'get', 'create', 'delete'],
      });
      expect(cfg?.mcp).toEqual({ include: ['list', 'get'] });
      expect(cfg?.cli).toBe(true);
    });
  });

  describe('setLinks', () => {
    it('replaces the full right-side set for a leftId (within opts scope)', async () => {
      await links.attach('owner-1', 'asset-old-1', {
        relationship: 'attachment',
      });
      await links.attach('owner-1', 'asset-old-2', {
        relationship: 'attachment',
      });

      await links.setLinks('owner-1', ['asset-new-1', 'asset-new-2'], {
        relationship: 'attachment',
      });

      const current = await links.byLeft('owner-1');
      expect(current.map((l) => l.assetId).sort()).toEqual([
        'asset-new-1',
        'asset-new-2',
      ]);
    });

    it('setLinks: stripping rightField from opts — stale rows for other rightIds are deleted', async () => {
      await links.attach('owner-1', 'asset-stale-1');
      await links.attach('owner-1', 'asset-stale-2');

      // Poisoned opts include the rightField. Under the old code the
      // delete-snapshot would only target rows with assetId === 'asset-stale-1',
      // leaving asset-stale-2 in the table after the "replace" — breaking
      // the "replace the full set" contract.
      await links.setLinks('owner-1', ['asset-new'], {
        assetId: 'asset-stale-1',
      } as any);

      const current = await links.byLeft('owner-1');
      expect(current).toHaveLength(1);
      expect(current[0]?.assetId).toBe('asset-new');
    });

    it('setLinks: respects the discriminator scope in opts', async () => {
      // Pre-existing rows in two relationships.
      await links.attach('owner-1', 'asset-a', { relationship: 'thumbnail' });
      await links.attach('owner-1', 'asset-b', { relationship: 'attachment' });

      // Replace only the 'thumbnail' relationship.
      await links.setLinks('owner-1', ['asset-c'], {
        relationship: 'thumbnail',
      });

      const all = await links.byLeft('owner-1');
      expect(all.map((l) => `${l.assetId}:${l.relationship}`).sort()).toEqual([
        'asset-b:attachment',
        'asset-c:thumbnail',
      ]);
    });
  });
});
