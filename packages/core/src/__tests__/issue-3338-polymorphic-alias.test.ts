/**
 * Stored references to a moved class's old qualified name (#3338), SQLite.
 *
 * `I3338MovedTarget` declares the name it had before a (simulated) package
 * move. Rows written under that old name — seeded here by rewriting the
 * stored `meta_type`, the way a pre-move deployment left them — must keep
 * resolving, new writes must store the current name, `smrt doctor` must be
 * able to count what is left, and the opt-in backfill must clean it up
 * idempotently without crossing tenants.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { crossPackageRef } from '../decorators/index';
import { getManifestCache } from '../manifest/store';
import { BackfillTracker } from '../migrations/backfill-tracker';
import {
  backfillLegacyQualifiedNames,
  collectLegacyQualifiedNameTargets,
  countLegacyQualifiedNameReferences,
} from '../migrations/qualified-name-aliases';
import { SmrtObject } from '../object';
import { SmrtPolymorphicAssociation } from '../polymorphic-association';
import { ObjectRegistry, smrt } from '../registry';
import {
  QUALIFIED_NAME_ALIAS_DEPRECATED,
  resetQualifiedNameAliasWarnings,
} from '../registry/qualified-name-aliases';

const OLD = '@legacy-3338/old-owner:I3338MovedTarget';

@smrt({
  tableName: 'i3338_moved_targets',
  previousQualifiedNames: ['@legacy-3338/old-owner:I3338MovedTarget'],
})
class I3338MovedTarget extends SmrtObject {
  name = '';
}

@smrt()
class I3338MovedTargetCollection extends SmrtCollection<I3338MovedTarget> {
  static readonly _itemClass = I3338MovedTarget;
}

/** Tenant-owned association table (implicit `tenantId` ownership). */
@smrt({
  tableName: 'i3338_links',
  conflictColumns: ['tenant_id', 'owner_id', 'meta_type', 'meta_id', 'role'],
})
class I3338Link extends SmrtPolymorphicAssociation {
  tenantId = '';
  ownerId = '';
}

@smrt()
class I3338LinkCollection extends SmrtCollection<I3338Link> {
  static readonly _itemClass = I3338Link;
}

/** Association table with no tenant column. */
@smrt({
  tableName: 'i3338_plain_links',
  conflictColumns: ['owner_key', 'meta_type', 'meta_id', 'role'],
})
class I3338PlainLink extends SmrtPolymorphicAssociation {
  ownerKey = '';
}

@smrt()
class I3338PlainLinkCollection extends SmrtCollection<I3338PlainLink> {
  static readonly _itemClass = I3338PlainLink;
}

/** Consumer source that still declares the reference by the old name. */
@smrt({ tableName: 'i3338_referrers' })
class I3338Referrer extends SmrtObject {
  @crossPackageRef('@legacy-3338/old-owner:I3338MovedTarget', {
    nullable: true,
  })
  movedId: string | null = null;
}

@smrt()
class I3338ReferrerCollection extends SmrtCollection<I3338Referrer> {
  static readonly _itemClass = I3338Referrer;
}

describe('issue #3338: stored references under a moved class’s old name (SQLite)', () => {
  let dbPath: string;
  let dbOptions: { db: { type: 'sqlite'; url: string } };
  let db: DatabaseInterface;
  let targets: I3338MovedTargetCollection;
  let links: I3338LinkCollection;
  let plainLinks: I3338PlainLinkCollection;
  let current: string;

  beforeEach(async () => {
    const url = `file:${join(
      tmpdir(),
      `smrt-3338-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    )}`;
    dbPath = url.replace('file:', '');
    dbOptions = { db: { type: 'sqlite', url } };
    targets = await I3338MovedTargetCollection.create(dbOptions);
    links = await I3338LinkCollection.create(dbOptions);
    plainLinks = await I3338PlainLinkCollection.create(dbOptions);
    db = (await getDatabase({ type: 'sqlite', url })) as DatabaseInterface;
    current = ObjectRegistry.getClassByConstructor(
      I3338MovedTarget as unknown as typeof SmrtObject,
    )?.qualifiedName as string;
    resetQualifiedNameAliasWarnings();
    ObjectRegistry.clearDiagnostics();
  });

  afterEach(async () => {
    await db?.close?.();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  async function makeTarget(name: string): Promise<I3338MovedTarget> {
    const target = await targets.create({ name } as never);
    await target.save();
    return target;
  }

  /** A link row as a pre-move deployment stored it: under the OLD name. */
  async function legacyLink(
    target: I3338MovedTarget,
    options: { tenantId?: string; ownerId?: string; role?: string } = {},
  ): Promise<I3338Link> {
    const link = await links.create({
      tenantId: options.tenantId ?? 'tenant-a',
      ownerId: options.ownerId ?? 'owner-1',
      metaType: current,
      metaId: target.id,
      role: options.role ?? 'hero',
    } as never);
    await link.save();
    await db.query(
      'UPDATE i3338_links SET meta_type = ? WHERE id = ?',
      OLD,
      link.id,
    );
    return link;
  }

  async function storedMetaTypes(table: string): Promise<string[]> {
    const result = await db.query(
      `SELECT meta_type FROM ${table} ORDER BY meta_type`,
    );
    return (result.rows as Array<{ meta_type: string }>).map(
      (row) => row.meta_type,
    );
  }

  it('the current name differs from the declared old name', () => {
    expect(current).toBeTruthy();
    expect(current).not.toBe(OLD);
    expect(ObjectRegistry.getQualifiedNameAliases().get(OLD)).toBe(current);
  });

  it('hydrates an association stored under the old metaType, warning once', async () => {
    const target = await makeTarget('legacy-target');
    const seeded = await legacyLink(target);

    const reloaded = (await links.get({ id: seeded.id })) as I3338Link;
    expect(reloaded.metaType).toBe(OLD);
    const hydrated = await reloaded.hydrate<I3338MovedTarget>();
    expect(hydrated).toBeInstanceOf(I3338MovedTarget);
    expect(hydrated?.id).toBe(target.id);
    expect(hydrated?.name).toBe('legacy-target');
    await reloaded.hydrate();

    const warnings = ObjectRegistry.getDiagnostics().filter(
      (diagnostic) => diagnostic.code === QUALIFIED_NAME_ALIAS_DEPRECATED,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].context).toEqual({
      alias: OLD,
      current,
      source: 'SmrtPolymorphicAssociation.hydrate',
    });
  });

  it('stores the current name when the target class is only known from its manifest (lazy)', async () => {
    const lazyPkg = '@test-3338/poly-lazy-owner';
    const lazyCurrent = `${lazyPkg}:LazyPolyTarget`;
    const lazyOld = '@test-3338/poly-lazy-old:LazyPolyTarget';
    getManifestCache().set(lazyPkg, {
      version: '1.0.0',
      timestamp: 0,
      packageName: lazyPkg,
      objects: {
        [lazyCurrent]: {
          name: 'lazypolytarget',
          className: 'LazyPolyTarget',
          qualifiedName: lazyCurrent,
          collection: 'lazypolytargets',
          filePath: 'poly-lazy-owner/src/lazy-poly-target.ts',
          packageName: lazyPkg,
          fields: {},
          methods: {},
          decoratorConfig: {
            tableName: 'lazy_poly_targets_3338',
            previousQualifiedNames: [lazyOld],
          },
        } as never,
      },
    });
    try {
      expect(
        ObjectRegistry.getClassByQualifiedName(lazyCurrent),
      ).toBeUndefined();
      const link = await links.create({
        tenantId: 'tenant-a',
        ownerId: 'lazy',
        metaType: lazyOld,
        metaId: 'target-1',
      } as never);
      await link.save();
      expect(link.metaType).toBe(lazyCurrent);
      expect(await storedMetaTypes('i3338_links')).toEqual([lazyCurrent]);

      // A genuinely unknown qualified name is stored as given.
      const unknown = await links.create({
        tenantId: 'tenant-a',
        ownerId: 'unknown',
        metaType: '@test-3338/nowhere:Ghost',
        metaId: 'ghost-1',
      } as never);
      await unknown.save();
      expect(unknown.metaType).toBe('@test-3338/nowhere:Ghost');
    } finally {
      getManifestCache().delete(lazyPkg);
    }
  });

  it('stores the current name on new writes and on re-saving a legacy row', async () => {
    const target = await makeTarget('write-target');
    const fresh = await links.create({
      tenantId: 'tenant-a',
      ownerId: 'owner-new',
      metaType: OLD,
      metaId: target.id,
    } as never);
    await fresh.save();
    expect(fresh.metaType).toBe(current);

    const seeded = await legacyLink(target, { ownerId: 'owner-legacy' });
    const reloaded = (await links.get({ id: seeded.id })) as I3338Link;
    expect(reloaded.metaType).toBe(OLD);
    reloaded.sortOrder = 2;
    await reloaded.save();

    expect(await storedMetaTypes('i3338_links')).toEqual([current, current]);
  });

  it('loads a @crossPackageRef declared by the old name', async () => {
    const target = await makeTarget('referenced');
    const referrers = await I3338ReferrerCollection.create(dbOptions);
    const referrer = await referrers.create({ movedId: target.id } as never);
    await referrer.save();

    expect(
      ObjectRegistry.resolveRelationshipTarget(
        ObjectRegistry.getClassByConstructor(
          I3338Referrer as unknown as typeof SmrtObject,
        )?.qualifiedName as string,
        'movedId',
      ),
    ).toBe(current);
    const related = await referrer.loadRelated('movedId');
    expect(related).toBeInstanceOf(I3338MovedTarget);
    expect((related as I3338MovedTarget).id).toBe(target.id);
  });

  it('deleting the target removes association rows stored under either name', async () => {
    const target = await makeTarget('doomed');
    await legacyLink(target, { ownerId: 'legacy' });
    const fresh = await links.create({
      tenantId: 'tenant-a',
      ownerId: 'fresh',
      metaType: current,
      metaId: target.id,
    } as never);
    await fresh.save();
    expect(await storedMetaTypes('i3338_links')).toHaveLength(2);

    await target.delete();

    expect(await storedMetaTypes('i3338_links')).toEqual([]);
  });

  it('counts stored legacy references for doctor', async () => {
    const target = await makeTarget('counted');
    await legacyLink(target, { ownerId: 'a1' });
    await legacyLink(target, { ownerId: 'a2' });
    const plain = await plainLinks.create({
      ownerKey: 'k1',
      metaType: current,
      metaId: target.id,
    } as never);
    await plain.save();
    await db.query('UPDATE i3338_plain_links SET meta_type = ?', OLD);

    const targetsByTable = collectLegacyQualifiedNameTargets().filter((entry) =>
      entry.table.startsWith('i3338_'),
    );
    expect(
      targetsByTable.map((entry) => [entry.table, entry.column, entry.kind]),
    ).toEqual([
      ['i3338_links', 'meta_type', 'polymorphic'],
      ['i3338_plain_links', 'meta_type', 'polymorphic'],
    ]);
    expect(targetsByTable[0].tenantColumn).toBe('tenant_id');
    expect(targetsByTable[1].tenantColumn).toBeUndefined();

    const report = await countLegacyQualifiedNameReferences(db);
    const own = report.references.filter((reference) =>
      reference.table.startsWith('i3338_'),
    );
    expect(own).toEqual([
      {
        table: 'i3338_links',
        column: 'meta_type',
        kind: 'polymorphic',
        alias: OLD,
        current,
        count: 2,
      },
      {
        table: 'i3338_plain_links',
        column: 'meta_type',
        kind: 'polymorphic',
        alias: OLD,
        current,
        count: 1,
      },
    ]);
    expect(report.aliases).toContainEqual({ alias: OLD, current });
  });

  it('backfills idempotently, tracked in _smrt_backfills, one tenant at a time', async () => {
    const target = await makeTarget('backfilled');
    await legacyLink(target, { tenantId: 'tenant-a', ownerId: 'a' });
    await legacyLink(target, { tenantId: 'tenant-b', ownerId: 'b' });
    const plain = await plainLinks.create({
      ownerKey: 'k',
      metaType: current,
      metaId: target.id,
    } as never);
    await plain.save();
    await db.query('UPDATE i3338_plain_links SET meta_type = ?', OLD);

    const dry = await backfillLegacyQualifiedNames(db, { dryRun: true });
    expect(dry.ran).toBe(false);
    expect(dry.before.total).toBeGreaterThanOrEqual(3);
    expect(await storedMetaTypes('i3338_links')).toEqual([OLD, OLD]);

    // Tenant-scoped: only tenant-a's rows, never the untenanted table.
    const scoped = await backfillLegacyQualifiedNames(db, {
      tenantId: 'tenant-a',
    });
    expect(scoped.ran).toBe(true);
    expect(scoped.recorded).toBe(true);
    expect(scoped.backfillName).toMatch(/:tenant:tenant-a$/u);
    expect(scoped.before.untenantedTables).toContain('i3338_plain_links');
    const rows = (
      await db.query(
        'SELECT tenant_id, meta_type FROM i3338_links ORDER BY tenant_id',
      )
    ).rows;
    expect(rows).toEqual([
      { tenant_id: 'tenant-a', meta_type: current },
      { tenant_id: 'tenant-b', meta_type: OLD },
    ]);
    expect(await storedMetaTypes('i3338_plain_links')).toEqual([OLD]);

    const scopedAgain = await backfillLegacyQualifiedNames(db, {
      tenantId: 'tenant-a',
    });
    expect(scopedAgain.ran).toBe(false);

    // Global run: everything left, then recorded, then a no-op.
    const global = await backfillLegacyQualifiedNames(db);
    expect(global.ran).toBe(true);
    expect(global.recorded).toBe(true);
    expect(global.skippedDuplicates).toEqual([]);
    expect(await storedMetaTypes('i3338_links')).toEqual([current, current]);
    expect(await storedMetaTypes('i3338_plain_links')).toEqual([current]);
    expect((await countLegacyQualifiedNameReferences(db)).total).toBe(0);

    const again = await backfillLegacyQualifiedNames(db);
    expect(again.ran).toBe(false);
    const markers = (await new BackfillTracker({ db }).listApplied()).map(
      (record) => record.name,
    );
    expect(markers).toContain(global.backfillName);
    expect(markers).toContain(scoped.backfillName);

    // Forced re-run on clean data rewrites nothing.
    const forced = await backfillLegacyQualifiedNames(db, { force: true });
    expect(forced.ran).toBe(true);
    expect(forced.rewritten).toEqual([]);
  });

  it('skips a legacy row whose rewrite would duplicate a current-name row', async () => {
    const target = await makeTarget('duplicated');
    await legacyLink(target, { ownerId: 'same', role: 'hero' });
    const duplicate = await links.create({
      tenantId: 'tenant-a',
      ownerId: 'same',
      metaType: current,
      metaId: target.id,
      role: 'hero',
    } as never);
    await duplicate.save();
    await legacyLink(target, { ownerId: 'unique', role: 'hero' });

    const result = await backfillLegacyQualifiedNames(db);
    expect(result.ran).toBe(true);
    expect(result.recorded).toBe(false);
    expect(
      result.skippedDuplicates.filter((entry) => entry.table === 'i3338_links'),
    ).toEqual([
      {
        table: 'i3338_links',
        column: 'meta_type',
        kind: 'polymorphic',
        alias: OLD,
        current,
        count: 1,
      },
    ]);
    expect(
      result.rewritten.filter((entry) => entry.table === 'i3338_links'),
    ).toEqual([expect.objectContaining({ count: 1 })]);
    expect(await storedMetaTypes('i3338_links')).toEqual([
      current,
      current,
      OLD,
    ]);
  });
});
