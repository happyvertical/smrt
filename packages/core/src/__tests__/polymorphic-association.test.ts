/**
 * Tests for SmrtPolymorphicAssociation base class.
 *
 * Covers:
 * - Inherited polymorphic columns (metaType / metaId / role / sortOrder)
 *   persist and reload on a concrete `@smrt()` subclass that adds its own
 *   owner field.
 * - `hydrate()` resolves `metaType` via the registry and loads `metaId`,
 *   returning the concrete target row.
 * - `hydrate()` returns `null` for a missing target row, an unregistered
 *   `metaType`, and unset `metaType` / `metaId`.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { SmrtPolymorphicAssociation } from '../polymorphic-association';
import { ObjectRegistry, smrt } from '../registry';

@smrt({ tableName: 'poly_assoc_test_targets' })
class PolyTarget extends SmrtObject {
  name = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

@smrt()
class PolyTargetCollection extends SmrtCollection<PolyTarget> {
  static readonly _itemClass = PolyTarget;
}

@smrt({
  tableName: 'poly_assoc_test_links',
  conflictColumns: ['owner_id', 'meta_type', 'meta_id', 'role'],
})
class PolyLink extends SmrtPolymorphicAssociation {
  ownerId = '';

  constructor(options: any = {}) {
    super(options);
    if (options.ownerId !== undefined) this.ownerId = options.ownerId;
  }
}

@smrt()
class PolyLinkCollection extends SmrtCollection<PolyLink> {
  static readonly _itemClass = PolyLink;
}

// STI hierarchy used to verify hydrate() rehydrates the concrete subclass.
@smrt({ tableName: 'poly_assoc_test_docs', tableStrategy: 'sti' })
class PolyDoc extends SmrtObject {
  title = '';

  constructor(options: any = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
  }
}

@smrt()
class PolyArticle extends PolyDoc {
  byline = '';

  constructor(options: any = {}) {
    super(options);
    if (options.byline !== undefined) this.byline = options.byline;
  }
}

@smrt()
class PolyDocCollection extends SmrtCollection<PolyDoc> {
  static readonly _itemClass = PolyDoc;
}

function tmpDbUrl(name: string): string {
  return `file:${join(
    tmpdir(),
    `smrt-poly-assoc-test-${name}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.db`,
  )}`;
}

describe('SmrtPolymorphicAssociation', () => {
  let dbPath: string;
  let dbUrl: string;
  let targets: PolyTargetCollection;
  let links: PolyLinkCollection;
  let dbOptions: { db: { type: 'sqlite'; url: string } };
  /** Canonical metaType for PolyTarget (qualified name when available). */
  let targetMetaType: string;
  /** Canonical metaType for the STI child PolyArticle. */
  let articleMetaType: string;

  beforeEach(async () => {
    dbUrl = tmpDbUrl('basic');
    dbPath = dbUrl.replace('file:', '');
    dbOptions = { db: { type: 'sqlite' as const, url: dbUrl } };
    targets = await PolyTargetCollection.create(dbOptions);
    links = await PolyLinkCollection.create(dbOptions);
    targetMetaType =
      ObjectRegistry.getClass('PolyTarget')?.qualifiedName ?? 'PolyTarget';
    articleMetaType =
      ObjectRegistry.getClass('PolyArticle')?.qualifiedName ?? 'PolyArticle';
  });

  afterEach(() => {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  describe('inherited polymorphic columns', () => {
    it('persists and reloads metaType / metaId / role / sortOrder', async () => {
      const target = await targets.create({ name: 'hero-image' });
      await target.save();

      const link = await links.create({
        ownerId: 'owner-1',
        metaType: targetMetaType,
        metaId: target.id,
        role: 'hero',
        sortOrder: 3,
      });
      await link.save();

      const reloaded = await links.get({ id: link.id });
      expect(reloaded).not.toBeNull();
      expect(reloaded?.ownerId).toBe('owner-1');
      expect(reloaded?.metaType).toBe(targetMetaType);
      expect(reloaded?.metaId).toBe(target.id);
      expect(reloaded?.role).toBe('hero');
      expect(reloaded?.sortOrder).toBe(3);
    });

    it('defaults role to "default" and sortOrder to 0', async () => {
      const link = await links.create({
        ownerId: 'owner-2',
        metaType: targetMetaType,
        metaId: 'some-id',
      });
      expect(link.role).toBe('default');
      expect(link.sortOrder).toBe(0);
    });

    it('supports WHERE queries against inherited columns', async () => {
      const target = await targets.create({ name: 't' });
      await target.save();
      const link = await links.create({
        ownerId: 'owner-3',
        metaType: targetMetaType,
        metaId: target.id,
        role: 'thumbnail',
      });
      await link.save();

      const found = (await links.list({
        where: {
          metaType: targetMetaType,
          metaId: target.id,
          role: 'thumbnail',
        },
      })) as PolyLink[];
      expect(found.map((l) => l.id)).toContain(link.id);
    });
  });

  describe('hydrate()', () => {
    it('resolves metaType and loads the concrete target row', async () => {
      const target = await targets.create({ name: 'resolved-target' });
      await target.save();

      const link = await links.create({
        ownerId: 'owner-4',
        metaType: targetMetaType,
        metaId: target.id,
        role: 'hero',
      });
      await link.save();

      const hydrated = await link.hydrate<PolyTarget>();
      expect(hydrated).not.toBeNull();
      expect(hydrated).toBeInstanceOf(PolyTarget);
      expect(hydrated?.id).toBe(target.id);
      expect(hydrated?.name).toBe('resolved-target');
    });

    it('rehydrates an STI target as its concrete subclass', async () => {
      const article = new PolyArticle({
        ...dbOptions,
        title: 'STI Title',
        byline: 'by line',
      });
      await article.initialize();
      await article.save();

      const link = await links.create({
        ownerId: 'owner-sti',
        metaType: articleMetaType,
        metaId: article.id,
        role: 'hero',
      });
      await link.save();

      const hydrated = await link.hydrate<PolyArticle>();
      expect(hydrated).toBeInstanceOf(PolyArticle);
      expect(hydrated?.title).toBe('STI Title');
      expect(hydrated?.byline).toBe('by line');
    });

    it('returns null when the target row no longer exists', async () => {
      const link = await links.create({
        ownerId: 'owner-5',
        metaType: targetMetaType,
        metaId: 'missing-id',
      });
      expect(await link.hydrate()).toBeNull();
    });

    it('returns null when metaType is not registered', async () => {
      const link = await links.create({
        ownerId: 'owner-6',
        metaType: '@nonexistent/pkg:NotAClass',
        metaId: 'whatever',
      });
      expect(await link.hydrate()).toBeNull();
    });

    it('returns null when metaType or metaId is unset', async () => {
      // metaType / metaId are required columns, so build a valid row and
      // blank the fields in memory to exercise hydrate()'s guard.
      const target = await targets.create({ name: 'guard-target' });
      await target.save();
      const link = await links.create({
        ownerId: 'owner-7',
        metaType: targetMetaType,
        metaId: target.id,
      });
      await link.save();

      link.metaType = '';
      expect(await link.hydrate()).toBeNull();

      link.metaType = targetMetaType;
      link.metaId = '';
      expect(await link.hydrate()).toBeNull();
    });
  });
});
