/**
 * Tests for SmrtJunction base class.
 *
 * Covers:
 * 1. byLeft / byRight / attach / detach happy path
 * 2. Key-override defense: caller-supplied opts cannot retarget the fixed
 *    junction key fields (regression test for round-4 codex finding)
 */

import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChangesSince, registerChangeFeedWriter } from '../change-feed';
import { field } from '../decorators/index';
import { GlobalInterceptors } from '../interceptors';
import { SmrtJunction } from '../junction';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

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

  describe('compatible bulk lifecycle', () => {
    it('replaces rows in bounded statements with IDs, positions, and per-row feed entries', async () => {
      registerChangeFeedWriter();
      const counts: number[] = [];
      for (const size of [2, 35]) {
        const owner = `batch-${size}`;
        const oldIds = Array.from({ length: size }, (_, i) => `old-${i}`);
        const newIds = Array.from({ length: size }, (_, i) => `new-${i}`);
        await links.setLinks(owner, oldIds);
        const before = await links.byLeft(owner);
        expect(before).toHaveLength(size);
        expect(before.every((item) => item.supportsJunctionBatch())).toBe(true);
        const cursor = (
          await getChangesSince(links.db, { since: 0, limit: 1000 })
        ).cursor;
        // Instrument the real SQLite executor, including transaction executors,
        // so system cleanup and feed SQL cannot hide behind adapter methods.
        const driver = links.db.client as any;
        let statementCount = 0;
        const executeOriginal = driver.execute.bind(driver);
        const execute = vi
          .spyOn(driver, 'execute')
          .mockImplementation((...args: any[]) => {
            statementCount++;
            return executeOriginal(...args);
          });
        const transactionOriginal = driver.transaction.bind(driver);
        const transaction = vi
          .spyOn(driver, 'transaction')
          .mockImplementation(async (...args: any[]) => {
            const tx = await transactionOriginal(...args);
            const executeTx = tx.execute.bind(tx);
            tx.execute = (...queryArgs: any[]) => {
              statementCount++;
              return executeTx(...queryArgs);
            };
            return tx;
          });
        const query = vi.spyOn(links.db, 'query');
        const upsert = vi.spyOn(links.db, 'upsert');
        await links.setLinks(owner, newIds);
        counts.push(statementCount);
        expect(statementCount).toBeGreaterThan(0);
        execute.mockRestore();
        transaction.mockRestore();
        expect(upsert).not.toHaveBeenCalled();
        expect(
          query.mock.calls.filter(([sql]) =>
            String(sql).startsWith('INSERT INTO "junction_test_links"'),
          ),
        ).toHaveLength(1);
        query.mockRestore();
        upsert.mockRestore();
        const after = await links.byLeft(owner);
        expect(after.map((item) => item.assetId)).toEqual(newIds);
        expect(after.map((item) => item.sortOrder)).toEqual(
          newIds.map((_, i) => i),
        );
        expect(
          after.every(
            (item) =>
              item.id && item.slug && item.created_at && item.updated_at,
          ),
        ).toBe(true);
        const changes = (
          await getChangesSince(links.db, { since: cursor, limit: 1000 })
        ).changes;
        expect(
          changes
            .filter((entry) => entry.table === 'junction_test_links')
            .map((entry) => entry.operation),
        ).toEqual([
          ...oldIds.map(() => 'delete'),
          ...newIds.map(() => 'create'),
        ]);
      }
      expect(counts[1]).toBe(counts[0]);
    });

    it('keeps natural-key upsert behavior for a link created after the snapshot', async () => {
      const queryOriginal = links.db.query.bind(links.db);
      let competitorId: string | null = null;
      const query = vi
        .spyOn(links.db, 'query')
        .mockImplementation(async (sql, ...args) => {
          if (
            !competitorId &&
            sql.startsWith('INSERT INTO "junction_test_links"')
          ) {
            competitorId = (await links.attach('owner-race', 'a')).id;
          }
          return queryOriginal(sql, ...args);
        });
      await links.setLinks('owner-race', ['a', 'b']);
      query.mockRestore();
      const rows = await links.byLeft('owner-race');
      expect(rows.map((row) => row.assetId)).toEqual(['a', 'b']);
      expect(rows[0].id).not.toBe(competitorId);
    });

    it('retries a transient batch failure without duplicating feed entries', async () => {
      const queryOriginal = links.db.query.bind(links.db);
      let attempts = 0;
      const query = vi
        .spyOn(links.db, 'query')
        .mockImplementation(async (sql, ...args) => {
          if (
            sql.startsWith('INSERT INTO "junction_test_links"') &&
            ++attempts === 1
          ) {
            throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
          }
          return queryOriginal(sql, ...args);
        });
      await links.setLinks('owner-retry', ['a', 'b']);
      query.mockRestore();
      expect(attempts).toBe(2);
      const rows = await links.byLeft('owner-retry');
      const ids = new Set(rows.map((row) => row.id));
      const changes = (
        await getChangesSince(links.db, { since: 0, limit: 1000 })
      ).changes.filter((change) => ids.has(change.rowId));
      expect(changes).toHaveLength(2);
    });

    it('invalidates cached reads and removes only the deleted rows’ owned memory', async () => {
      await links.setLinks('owner-cache', ['a', 'b']);
      const before = await links.list({
        where: { ownerId: 'owner-cache' },
        cache: { ttl: 60_000 },
      });
      const id = before[0].id!;
      for (const [memoryId, ownerClass] of [
        ['own', 'JunctionTestLink'],
        ['peer', 'OtherClass'],
      ]) {
        await links.db.insert('_smrt_contexts', {
          id: memoryId,
          owner_class: ownerClass,
          owner_id: id,
          scope: 'test',
          key: 'test',
        });
      }
      await links.setLinks('owner-cache', ['c']);
      expect(
        (
          await links.list({
            where: { ownerId: 'owner-cache' },
            cache: { ttl: 60_000 },
          })
        ).map((row) => row.assetId),
      ).toEqual(['c']);
      expect(await links.db.get('_smrt_contexts', { id: 'own' })).toBeNull();
      expect(
        await links.db.get('_smrt_contexts', { id: 'peer' }),
      ).not.toBeNull();
    });

    it('retains the JSON adapter persistence lifecycle', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'junction-json-'));
      const db = await getTestDatabase({
        type: 'json',
        url: directory,
        classes: ['JunctionTestLink'],
      });
      try {
        const jsonLinks = await JunctionTestLinkCollection.create({ db });
        const upsert = vi.spyOn(db, 'upsert');
        await jsonLinks.setLinks('owner-json', ['a', 'b']);
        expect(upsert).toHaveBeenCalledTimes(2);
        upsert.mockRestore();
        expect(await jsonLinks.byLeft('owner-json')).toHaveLength(2);
      } finally {
        await db.close?.();
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('falls back above the documented single-batch bound', async () => {
      const upsert = vi.spyOn(links.db, 'upsert');
      await links.setLinks(
        'owner-large',
        Array.from({ length: 101 }, (_, i) => `asset-${i}`),
      );
      expect(upsert).toHaveBeenCalledTimes(101);
      upsert.mockRestore();
      expect(await links.byLeft('owner-large')).toHaveLength(101);
    });

    it('retains virtual attach behavior and duplicate-input last-write semantics', async () => {
      const original = links.attach.bind(links);
      const attach = vi.spyOn(links, 'attach').mockImplementation(original);
      await links.setLinks('owner-custom', ['a', 'a', 'b']);
      expect(attach).toHaveBeenCalledTimes(3);
      const rows = await links.byLeft('owner-custom');
      expect(rows.map((item) => [item.assetId, item.sortOrder])).toEqual([
        ['a', 1],
        ['b', 2],
      ]);
      attach.mockRestore();
    });

    it('retains the sequential lifecycle for unmarked mutation interceptors', async () => {
      const calls: string[] = [];
      const interceptor = {
        beforeSave: (item: SmrtObject) => {
          calls.push(`before:${(item as JunctionTestLink).assetId}`);
        },
        afterSave: (item: SmrtObject) => {
          calls.push(`after:${(item as JunctionTestLink).assetId}`);
        },
      };
      GlobalInterceptors.register(interceptor);
      try {
        await links.setLinks('owner-hooks', ['a', 'b']);
        expect(calls).toEqual(['before:a', 'after:a', 'before:b', 'after:b']);
      } finally {
        GlobalInterceptors.unregister(interceptor);
      }
    });

    it('retains IDs only until replacement and batches detach tombstones', async () => {
      registerChangeFeedWriter();
      await links.setLinks('owner-repeat', ['a', 'b']);
      const before = await links.byLeft('owner-repeat');
      await links.setLinks('owner-repeat', ['a', 'b']);
      const after = await links.byLeft('owner-repeat');
      expect(
        after.every((item) => !before.some((old) => old.id === item.id)),
      ).toBe(true);
      await links.detach('owner-repeat', 'a');
      expect(
        (await links.byLeft('owner-repeat')).map((item) => item.assetId),
      ).toEqual(['b']);
    });
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

    it('threads limit and offset through byLeft without treating them as filters', async () => {
      await links.attach('owner-1', 'asset-0', { sortOrder: 0 });
      await links.attach('owner-1', 'asset-1', { sortOrder: 1 });
      await links.attach('owner-1', 'asset-2', { sortOrder: 2 });

      const page = await links.byLeft('owner-1', { limit: 1, offset: 1 });

      expect(page).toHaveLength(1);
      expect(page[0]?.assetId).toBe('asset-1');
    });

    it('threads limit and offset through byRight without treating them as filters', async () => {
      await links.attach('owner-0', 'asset-a', { sortOrder: 0 });
      await links.attach('owner-1', 'asset-a', { sortOrder: 1 });
      await links.attach('owner-2', 'asset-a', { sortOrder: 2 });

      const page = await links.byRight('asset-a', { limit: 1, offset: 1 });

      expect(page).toHaveLength(1);
      expect(page[0]?.ownerId).toBe('owner-1');
    });

    it('preserves collection query-bound validation through junction reads', async () => {
      await expect(
        links.byLeft('owner-1', { limit: -1 }),
      ).rejects.toMatchObject({
        status: 400,
      });
      await expect(
        links.byRight('asset-a', { offset: Number.NaN }),
      ).rejects.toMatchObject({
        status: 400,
      });
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
