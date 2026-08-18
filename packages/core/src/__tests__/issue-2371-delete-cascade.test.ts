/**
 * Referential integrity on delete (#2371).
 *
 * SMRT emits no DB-level `FOREIGN KEY` constraints, so before this change
 * `delete()` removed the object's own row and left everything that pointed at
 * it behind: junction rows, polymorphic association rows, `_smrt_embeddings`
 * (which kept ranking the deleted id in `semanticSearch`) and `_smrt_contexts`.
 * `@foreignKey(..., { onDelete })` was metadata nobody read.
 *
 * Everything here runs against real SQLite through the real model layer — the
 * point of the issue was that the framework never issued the statements, so a
 * mocked database would prove nothing.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCascadePlan, normalizeOnDelete } from '../cascade';
import { SmrtCollection } from '../collection';
import { CACHE_INVALIDATION_CHANNEL } from '../collection-cache';
import type {
  CompatiblePropertyDecorator,
  CompatiblePropertyDecoratorContext,
  LegacyPropertyDecoratorTarget,
} from '../decorators/compatibility';
import { registerCompatibleFieldDecorator } from '../decorators/compatibility';
import { crossPackageRef, field, foreignKey } from '../decorators/index';
import { EmbeddingStorage } from '../embeddings/storage';
import { ConfigurationError, DatabaseError } from '../errors';
import { SmrtObject } from '../object';
import { SmrtPolymorphicAssociation } from '../polymorphic-association';
import { ObjectRegistry, smrt } from '../registry';

/**
 * Minimal stand-in for `@tenantId()` (`@happyvertical/smrt-tenancy`), which
 * `packages/core` cannot import (tenancy depends on core, not the reverse).
 * Registers the exact shape `packages/tenancy/src/decorators.ts` registers —
 * `type: 'foreignKey'` at the given target plus the `__tenancy.isTenantIdField`
 * marker `FieldMeta` documents — so the CRITICAL review fixture below proves
 * `cascade.ts` reads that marker correctly, not a stand-in for the whole
 * tenancy package.
 */
function testTenantIdField(relatedClass: string) {
  return ((
    targetOrValue: LegacyPropertyDecoratorTarget | undefined,
    propertyKeyOrContext: CompatiblePropertyDecoratorContext<unknown, unknown>,
  ) => {
    registerCompatibleFieldDecorator(
      targetOrValue,
      propertyKeyOrContext,
      (className, propertyKey) => {
        ObjectRegistry.registerFieldDecorator(className, propertyKey, {
          type: 'foreignKey',
          related: relatedClass,
          sqlType: 'UUID',
          required: true,
          nullable: false,
          __tenancy: { isTenantIdField: true },
        });
      },
    );
  }) as CompatiblePropertyDecorator;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

@smrt({ tableName: 'cascade_2371_docs' })
class CascadeDoc extends SmrtObject {
  title = '';

  constructor(options: any = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
  }
}

@smrt()
class CascadeDocCollection extends SmrtCollection<CascadeDoc> {
  static readonly _itemClass = CascadeDoc;
}

/**
 * Junction row: `doc_id` is part of the natural key, so the row is *identified*
 * by the doc and must not outlive it. No `onDelete` is declared — this proves
 * the natural-key default, which is what cleans up every junction in the
 * monorepo without per-package annotation.
 */
@smrt({
  tableName: 'cascade_2371_doc_tags',
  conflictColumns: ['doc_id', 'tag'],
})
class CascadeDocTag extends SmrtObject {
  @foreignKey('CascadeDoc', { required: true })
  docId = '';

  @field({ required: true })
  tag = '';

  constructor(options: any = {}) {
    super(options);
    if (options.docId !== undefined) this.docId = options.docId;
    if (options.tag !== undefined) this.tag = options.tag;
  }
}

@smrt()
class CascadeDocTagCollection extends SmrtCollection<CascadeDocTag> {
  static readonly _itemClass = CascadeDocTag;
}

/**
 * Ordinary child keyed by `(slug, context)`: `doc_id` is NOT part of the
 * natural key and declares no `onDelete`, so it keeps the pre-#2371 behaviour
 * and is left alone. Deleting a customer must not silently delete its orders.
 */
@smrt({ tableName: 'cascade_2371_notes' })
class CascadeNote extends SmrtObject {
  @foreignKey('CascadeDoc')
  docId = '';

  constructor(options: any = {}) {
    super(options);
    if (options.docId !== undefined) this.docId = options.docId;
  }
}

@smrt()
class CascadeNoteCollection extends SmrtCollection<CascadeNote> {
  static readonly _itemClass = CascadeNote;
}

/** Explicit opt-in cascade on a child that is not part of any natural key. */
@smrt({ tableName: 'cascade_2371_sections' })
class CascadeSection extends SmrtObject {
  @foreignKey('CascadeDoc', { onDelete: 'CASCADE' })
  docId = '';

  constructor(options: any = {}) {
    super(options);
    if (options.docId !== undefined) this.docId = options.docId;
  }
}

@smrt()
class CascadeSectionCollection extends SmrtCollection<CascadeSection> {
  static readonly _itemClass = CascadeSection;
}

/** Grandchild — proves the cascade recurses rather than stopping one level in. */
@smrt({ tableName: 'cascade_2371_blocks' })
class CascadeBlock extends SmrtObject {
  @foreignKey('CascadeSection', { onDelete: 'CASCADE' })
  sectionId = '';

  constructor(options: any = {}) {
    super(options);
    if (options.sectionId !== undefined) this.sectionId = options.sectionId;
  }
}

@smrt()
class CascadeBlockCollection extends SmrtCollection<CascadeBlock> {
  static readonly _itemClass = CascadeBlock;
}

@smrt({ tableName: 'cascade_2371_bookmarks' })
class CascadeBookmark extends SmrtObject {
  @foreignKey('CascadeDoc', { onDelete: 'SET NULL', nullable: true })
  docId: string | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.docId !== undefined) this.docId = options.docId;
  }
}

@smrt()
class CascadeBookmarkCollection extends SmrtCollection<CascadeBookmark> {
  static readonly _itemClass = CascadeBookmark;
}

/** Guarded parent: nothing may delete it while a lock row still points at it. */
@smrt({ tableName: 'cascade_2371_vaults' })
class CascadeVault extends SmrtObject {
  label = '';

  constructor(options: any = {}) {
    super(options);
    if (options.label !== undefined) this.label = options.label;
  }
}

@smrt()
class CascadeVaultCollection extends SmrtCollection<CascadeVault> {
  static readonly _itemClass = CascadeVault;
}

@smrt({ tableName: 'cascade_2371_vault_locks' })
class CascadeVaultLock extends SmrtObject {
  @foreignKey('CascadeVault', { onDelete: 'RESTRICT' })
  vaultId = '';

  constructor(options: any = {}) {
    super(options);
    if (options.vaultId !== undefined) this.vaultId = options.vaultId;
  }
}

@smrt()
class CascadeVaultLockCollection extends SmrtCollection<CascadeVaultLock> {
  static readonly _itemClass = CascadeVaultLock;
}

/** Junction rows on the vault, to prove RESTRICT aborts the whole transaction. */
@smrt({
  tableName: 'cascade_2371_vault_tags',
  conflictColumns: ['vault_id', 'tag'],
})
class CascadeVaultTag extends SmrtObject {
  @foreignKey('CascadeVault', { required: true })
  vaultId = '';

  @field({ required: true })
  tag = '';

  constructor(options: any = {}) {
    super(options);
    if (options.vaultId !== undefined) this.vaultId = options.vaultId;
    if (options.tag !== undefined) this.tag = options.tag;
  }
}

@smrt()
class CascadeVaultTagCollection extends SmrtCollection<CascadeVaultTag> {
  static readonly _itemClass = CascadeVaultTag;
}

/**
 * A parent whose only referencing class declares an impossible action:
 * `SET NULL` on a `required` column. Isolated on its own parent so the rest of
 * the suite can still build plans.
 */
@smrt({ tableName: 'cascade_2371_strict' })
class CascadeStrict extends SmrtObject {
  label = '';
}

@smrt()
class CascadeStrictCollection extends SmrtCollection<CascadeStrict> {
  static readonly _itemClass = CascadeStrict;
}

@smrt({ tableName: 'cascade_2371_strict_children' })
class CascadeStrictChild extends SmrtObject {
  @foreignKey('CascadeStrict', { required: true, onDelete: 'SET NULL' })
  strictId = '';
}

@smrt()
class CascadeStrictChildCollection extends SmrtCollection<CascadeStrictChild> {
  static readonly _itemClass = CascadeStrictChild;
}

@smrt({
  tableName: 'cascade_2371_attachments',
  conflictColumns: ['owner_key', 'meta_type', 'meta_id', 'role'],
})
class CascadeAttachment extends SmrtPolymorphicAssociation {
  @field({ required: true })
  ownerKey = '';

  constructor(options: any = {}) {
    super(options);
    if (options.ownerKey !== undefined) this.ownerKey = options.ownerKey;
  }
}

@smrt()
class CascadeAttachmentCollection extends SmrtCollection<CascadeAttachment> {
  static readonly _itemClass = CascadeAttachment;
}

/**
 * Two classes, same simple name, different packages — a regression fixture
 * for the review finding that `delete()` must resolve the cascade plan
 * through `getResolvedQualifiedName()`, not the ambiguous
 * `this.constructor.name`. `AmbiguousDocA` registers first and
 * `AmbiguousDocB` second: `ObjectRegistry`'s ambiguous-name fallback resolves
 * a bare `'AmbiguousDoc'` lookup to the *first* match (A), so a regression to
 * `constructor.name` would silently plan B's delete against A's (empty)
 * reference set and leave the tag below orphaned — not a coincidental pass.
 */
const AmbiguousDocA = smrt({
  packageName: '@ambiguous-a/pkg-2371',
  tableName: 'cascade_2371_ambiguous_doc_a',
})(
  class AmbiguousDoc extends SmrtObject {
    title = '';

    constructor(options: any = {}) {
      super(options);
      if (options.title !== undefined) this.title = options.title;
    }
  },
);

const AmbiguousDocB = smrt({
  packageName: '@ambiguous-b/pkg-2371',
  tableName: 'cascade_2371_ambiguous_doc_b',
})(
  class AmbiguousDoc extends SmrtObject {
    title = '';

    constructor(options: any = {}) {
      super(options);
      if (options.title !== undefined) this.title = options.title;
    }
  },
);

@smrt()
class AmbiguousDocACollection extends SmrtCollection<
  InstanceType<typeof AmbiguousDocA>
> {
  static readonly _itemClass = AmbiguousDocA;
}

@smrt()
class AmbiguousDocBCollection extends SmrtCollection<
  InstanceType<typeof AmbiguousDocB>
> {
  static readonly _itemClass = AmbiguousDocB;
}

/** Junction row naming B specifically, via its fully-qualified name. */
@smrt({
  tableName: 'cascade_2371_ambiguous_doc_tags',
  conflictColumns: ['doc_id', 'tag'],
})
class AmbiguousDocTag extends SmrtObject {
  @crossPackageRef('@ambiguous-b/pkg-2371:AmbiguousDoc', { required: true })
  docId = '';

  @field({ required: true })
  tag = '';

  constructor(options: any = {}) {
    super(options);
    if (options.docId !== undefined) this.docId = options.docId;
    if (options.tag !== undefined) this.tag = options.tag;
  }
}

@smrt()
class AmbiguousDocTagCollection extends SmrtCollection<AmbiguousDocTag> {
  static readonly _itemClass = AmbiguousDocTag;
}

/**
 * Review fixture: a parent with no cache config, and a junction class that
 * opts into cross-process cache invalidation. Cascading the parent's delete
 * into the junction table must broadcast using the *junction's* own
 * `@smrt({ cache })` config, not the parent's (which has none) — see the
 * "cascade cache broadcast" describe block below.
 */
@smrt({ tableName: 'cascade_2371_cache_parents' })
class CascadeCacheParent extends SmrtObject {
  title = '';

  constructor(options: any = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
  }
}

@smrt()
class CascadeCacheParentCollection extends SmrtCollection<CascadeCacheParent> {
  static readonly _itemClass = CascadeCacheParent;
}

@smrt({
  tableName: 'cascade_2371_cache_tags',
  conflictColumns: ['parent_id', 'tag'],
  cache: { ttl: 60_000, crossProcess: true },
})
class CascadeCacheTag extends SmrtObject {
  @foreignKey('CascadeCacheParent', { required: true })
  parentId = '';

  @field({ required: true })
  tag = '';

  constructor(options: any = {}) {
    super(options);
    if (options.parentId !== undefined) this.parentId = options.parentId;
    if (options.tag !== undefined) this.tag = options.tag;
  }
}

@smrt()
class CascadeCacheTagCollection extends SmrtCollection<CascadeCacheTag> {
  static readonly _itemClass = CascadeCacheTag;
}

/**
 * CRITICAL review fixture: deleting a tenant-like parent must NOT cascade
 * through a tenant-scoped child that declares no explicit `conflictColumns`.
 * `smrt-tenancy` (#2360) leads such a class's *default* natural key with the
 * tenant column, which would otherwise put it in `conflictColumns` and trip
 * the natural-key-implies-CASCADE default — turning a `Tenant.delete()` into
 * a recursive wipe of every tenant-scoped table in the schema. `tenantId`
 * below is registered exactly like `@tenantId()` does (see
 * `testTenantIdField` above), without declaring `conflictColumns`, so its
 * default natural key is tenant-led per #2360 and would land `tenant_id` in
 * `conflictColumns` if that rule were not excluded for tenant fields.
 */
@smrt({ tableName: 'cascade_2371_tenants' })
class CascadeTenant extends SmrtObject {
  name = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

@smrt()
class CascadeTenantCollection extends SmrtCollection<CascadeTenant> {
  static readonly _itemClass = CascadeTenant;
}

@smrt({ tableName: 'cascade_2371_tenant_docs', tenantScoped: true })
class CascadeTenantDoc extends SmrtObject {
  @testTenantIdField('CascadeTenant')
  tenantId = '';

  title = '';

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.title !== undefined) this.title = options.title;
  }
}

@smrt()
class CascadeTenantDocCollection extends SmrtCollection<CascadeTenantDoc> {
  static readonly _itemClass = CascadeTenantDoc;
}

/**
 * Review fixture: registered process-wide (so it appears in every delete's
 * `plan.polymorphic`), but its collection is *never* created by any test in
 * this file — its table therefore never exists in any of this suite's
 * per-test SQLite files. This reproduces the CI failure caught after the
 * qualified-name fix landed: `packages/profiles`'s
 * `OidcProfileEmailReservation.delete()` tried to clean up
 * `packages/assets`'s polymorphic association table, which the
 * `packages/users` test process had registered (both packages loaded in the
 * same worker) but never migrated into that specific test database — the
 * cascade planner is registry-derived and package-agnostic, so it always
 * plans against every polymorphic class the *process* knows about, not just
 * ones this delete's own database happens to have tables for. Every test in
 * this file exercises the fix incidentally (any `.delete()` call hits this
 * table), and the tests below assert it directly against RESTRICT/SET
 * NULL/CASCADE references too.
 */
@smrt({
  tableName: 'cascade_2371_unmigrated_assoc',
  conflictColumns: ['owner_key', 'meta_type', 'meta_id', 'role'],
})
class CascadeUnmigratedAssociation extends SmrtPolymorphicAssociation {
  @field({ required: true })
  ownerKey = '';
}

/**
 * Ordinary (non-polymorphic) reference whose table is likewise never
 * created — proves the same tolerance for RESTRICT / SET NULL / CASCADE
 * against a referencing table, not just the polymorphic path CI caught.
 */
@smrt({ tableName: 'cascade_2371_unmigrated_children' })
class CascadeUnmigratedChild extends SmrtObject {
  @foreignKey('CascadeDoc', { onDelete: 'CASCADE' })
  docId = '';
}

@smrt()
class CascadeUnmigratedAssociationCollection extends SmrtCollection<CascadeUnmigratedAssociation> {
  static readonly _itemClass = CascadeUnmigratedAssociation;
}

@smrt()
class CascadeUnmigratedChildCollection extends SmrtCollection<CascadeUnmigratedChild> {
  static readonly _itemClass = CascadeUnmigratedChild;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function tmpDbUrl(name: string): string {
  return `file:${join(
    tmpdir(),
    `smrt-2371-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  )}`;
}

describe('delete() referential integrity (#2371)', () => {
  let dbPath: string;
  let dbUrl: string;
  let docs: CascadeDocCollection;
  let db: DatabaseInterface;

  beforeEach(async () => {
    dbUrl = tmpDbUrl('cascade');
    dbPath = dbUrl.replace('file:', '');
    docs = await CascadeDocCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });
    db = (docs as unknown as { _db: DatabaseInterface })._db;
  });

  afterEach(() => {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  /** Every collection in a case must share one handle, or each gets its own file. */
  async function collectionOn<T extends SmrtCollection<any>>(ctor: {
    create(options: any): Promise<T>;
  }): Promise<T> {
    return ctor.create({ db });
  }

  async function makeDoc(title: string): Promise<CascadeDoc> {
    const doc = await docs.create({ title } as any);
    await doc.save();
    return doc;
  }

  describe('junction rows', () => {
    it('removes the junction rows identified by the deleted object', async () => {
      const tags = await collectionOn(CascadeDocTagCollection);
      const doc = await makeDoc('kept-alive');
      const other = await makeDoc('survivor');

      for (const tag of ['alpha', 'beta']) {
        await (await tags.create({ docId: doc.id, tag } as any)).save();
      }
      await (
        await tags.create({ docId: other.id, tag: 'alpha' } as any)
      ).save();

      expect(await db.count('cascade_2371_doc_tags')).toBe(3);

      await doc.delete();

      const remaining = await db.list('cascade_2371_doc_tags', {});
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.doc_id).toBe(other.id);
    });

    it('is derived from the natural key, not from a declared onDelete', () => {
      const plan = buildCascadePlan(ObjectRegistry, 'CascadeDoc');
      const junction = plan.references.find(
        (reference) => reference.className === 'CascadeDocTag',
      );

      expect(junction).toMatchObject({
        column: 'doc_id',
        action: 'CASCADE',
        declared: false,
      });
    });
  });

  describe('onDelete actions', () => {
    it('CASCADE removes children and their own children', async () => {
      const sections = await collectionOn(CascadeSectionCollection);
      const blocks = await collectionOn(CascadeBlockCollection);
      const doc = await makeDoc('nested');

      const section = await sections.create({ docId: doc.id } as any);
      await section.save();
      const block = await blocks.create({ sectionId: section.id } as any);
      await block.save();

      await doc.delete();

      expect(await db.count('cascade_2371_sections')).toBe(0);
      expect(await db.count('cascade_2371_blocks')).toBe(0);
    });

    it('SET NULL clears the column and keeps the row', async () => {
      const bookmarks = await collectionOn(CascadeBookmarkCollection);
      const doc = await makeDoc('bookmarked');

      const bookmark = await bookmarks.create({ docId: doc.id } as any);
      await bookmark.save();

      await doc.delete();

      const rows = await db.list('cascade_2371_bookmarks', {});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.doc_id).toBeNull();
    });

    it('RESTRICT refuses the delete and leaves the object in place', async () => {
      const vaults = await collectionOn(CascadeVaultCollection);
      const locks = await collectionOn(CascadeVaultLockCollection);
      const vault = await vaults.create({ label: 'guarded' } as any);
      await vault.save();
      const lock = await locks.create({ vaultId: vault.id } as any);
      await lock.save();

      await expect(vault.delete()).rejects.toThrow(DatabaseError);
      await expect(vault.delete()).rejects.toThrow(/RESTRICT/);

      expect(await db.count('cascade_2371_vaults', { id: vault.id })).toBe(1);
    });

    it('rolls back the whole cascade when a RESTRICT aborts it', async () => {
      const vaults = await collectionOn(CascadeVaultCollection);
      const locks = await collectionOn(CascadeVaultLockCollection);
      const vaultTags = await collectionOn(CascadeVaultTagCollection);

      const vault = await vaults.create({ label: 'guarded' } as any);
      await vault.save();
      await (
        await vaultTags.create({ vaultId: vault.id, tag: 'alpha' } as any)
      ).save();
      await (await locks.create({ vaultId: vault.id } as any)).save();

      await expect(vault.delete()).rejects.toThrow(DatabaseError);

      // The junction rows would have been deleted before the RESTRICT check
      // if the statements were not transactional.
      expect(await db.count('cascade_2371_vault_tags')).toBe(1);
      expect(await db.count('cascade_2371_vaults')).toBe(1);
    });

    it('leaves an undeclared, non-key reference untouched', async () => {
      const notes = await collectionOn(CascadeNoteCollection);
      const doc = await makeDoc('noted');

      const note = await notes.create({ docId: doc.id } as any);
      await note.save();

      await doc.delete();

      const rows = await db.list('cascade_2371_notes', {});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.doc_id).toBe(doc.id);
    });
  });

  describe('polymorphic associations', () => {
    it('removes association rows pointing at the deleted object', async () => {
      const attachments = await collectionOn(CascadeAttachmentCollection);
      const doc = await makeDoc('attached');
      const other = await makeDoc('untouched');

      await (
        await attachments.create({
          ownerKey: 'owner-1',
          metaType: 'CascadeDoc',
          metaId: doc.id,
          role: 'hero',
        } as any)
      ).save();
      await (
        await attachments.create({
          ownerKey: 'owner-1',
          metaType: 'CascadeDoc',
          metaId: other.id,
          role: 'hero',
        } as any)
      ).save();

      await doc.delete();

      const rows = await db.list('cascade_2371_attachments', {});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.meta_id).toBe(other.id);
    });

    it('does not touch rows whose metaType names another class', async () => {
      const attachments = await collectionOn(CascadeAttachmentCollection);
      const doc = await makeDoc('attached');

      await (
        await attachments.create({
          ownerKey: 'owner-1',
          metaType: 'SomeOtherClass',
          metaId: doc.id,
          role: 'hero',
        } as any)
      ).save();

      await doc.delete();

      expect(await db.count('cascade_2371_attachments')).toBe(1);
    });
  });

  describe('framework side tables', () => {
    it('forgets the object memory it owned', async () => {
      const doc = await makeDoc('remembers');
      await doc.remember({ scope: 'test', key: 'k', value: 'v' });

      expect(
        await db.count('_smrt_contexts', { owner_id: doc.id }),
      ).toBeGreaterThan(0);

      await doc.delete();

      expect(await db.count('_smrt_contexts', { owner_id: doc.id })).toBe(0);
    });

    it('keeps collection-scoped memory, which no object owns', async () => {
      const doc = await makeDoc('remembers');
      await docs.remember({ scope: 'test', key: 'shared', value: 'v' });

      await doc.delete();

      expect(
        await db.count('_smrt_contexts', { owner_id: '__collection__' }),
      ).toBe(1);
    });

    it('drops the embeddings that kept ranking the deleted id', async () => {
      const doc = await makeDoc('embedded');
      const other = await makeDoc('still-here');

      // Written through the framework's own storage API, so the row shape is
      // whatever `generateEmbeddings()` actually persists.
      for (const target of [doc, other]) {
        await EmbeddingStorage.upsert(db, {
          objectClass: 'CascadeDoc',
          objectId: target.id as string,
          fieldName: 'title',
          contentHash: 'hash',
          embedding: [0.1, 0.2],
          model: 'test-model',
          dimensions: 2,
        });
      }

      await doc.delete();

      const rows = await db.list('_smrt_embeddings', {});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.object_id).toBe(other.id);
    });
  });

  describe('unchanged behaviour', () => {
    it('still deletes the object row and marks it unpersisted', async () => {
      const doc = await makeDoc('plain');

      await doc.delete();

      expect(await db.count('cascade_2371_docs', { id: doc.id })).toBe(0);
      expect(await docs.get({ id: doc.id })).toBeNull();
    });
  });

  describe('ambiguous simple class names (review fix: qualified-name resolution)', () => {
    it('cascades a cross-package reference to B, not the same-named A registered first', async () => {
      const docsB = await collectionOn(AmbiguousDocBCollection);
      const tags = await collectionOn(AmbiguousDocTagCollection);

      const docB = await docsB.create({ title: 'ambiguous-b' } as any);
      await docB.save();

      const tag = await tags.create({ docId: docB.id, tag: 'alpha' } as any);
      await tag.save();

      expect(await db.count('cascade_2371_ambiguous_doc_tags')).toBe(1);

      await docB.delete();

      const remaining = await db.list('cascade_2371_ambiguous_doc_tags', {});
      expect(remaining).toHaveLength(0);
    });

    it("resolves the target class through the instance's registration, not its bare constructor name", () => {
      const docB = new (
        AmbiguousDocB as unknown as {
          new (options?: any): SmrtObject;
        }
      )({});
      const qualifiedName = (
        docB as unknown as { getResolvedQualifiedName(): string }
      ).getResolvedQualifiedName();

      expect(docB.constructor.name).toBe('AmbiguousDoc');
      expect(qualifiedName).toBe('@ambiguous-b/pkg-2371:AmbiguousDoc');

      // Building the plan from the ambiguous bare name resolves to A (first
      // registered) and misses B's own reference entirely.
      const ambiguousPlan = buildCascadePlan(ObjectRegistry, 'AmbiguousDoc');
      const viaAmbiguousName = ambiguousPlan.references.find(
        (reference) => reference.className === 'AmbiguousDocTag',
      );
      expect(viaAmbiguousName).toBeUndefined();

      // Building it from the qualified name finds it.
      const qualifiedPlan = buildCascadePlan(
        ObjectRegistry,
        '@ambiguous-b/pkg-2371:AmbiguousDoc',
      );
      const viaQualifiedName = qualifiedPlan.references.find(
        (reference) => reference.className === 'AmbiguousDocTag',
      );
      expect(viaQualifiedName).toMatchObject({
        column: 'doc_id',
        action: 'CASCADE',
      });
    });
  });
});

describe('tenant column exclusion (CRITICAL review fix)', () => {
  let dbPath: string;
  let dbUrl: string;
  let db: DatabaseInterface;

  beforeEach(async () => {
    dbUrl = tmpDbUrl('tenant-cascade');
    dbPath = dbUrl.replace('file:', '');
    const tenants = await CascadeTenantCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });
    db = (tenants as unknown as { _db: DatabaseInterface })._db;
  });

  afterEach(() => {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('never defaults a tenantId reference to CASCADE, even though it is part of the default conflictColumns', () => {
    // Sanity-check the premise: the tenant column really is in the class's
    // default natural key (#2360) — this is what made the pre-fix code
    // treat it as CASCADE-eligible.
    expect(ObjectRegistry.getConflictColumns('CascadeTenantDoc')).toEqual(
      expect.arrayContaining(['tenant_id']),
    );

    const plan = buildCascadePlan(ObjectRegistry, 'CascadeTenant');
    const tenantDocReference = plan.references.find(
      (reference) => reference.className === 'CascadeTenantDoc',
    );
    expect(tenantDocReference).toBeUndefined();
  });

  it('deleting the tenant leaves every tenant-scoped row in place — no recursive wipe', async () => {
    const tenants = await CascadeTenantCollection.create({ db });
    const docs = await CascadeTenantDocCollection.create({ db });

    const tenant = await tenants.create({ name: 'Acme' } as any);
    await tenant.save();
    await (
      await docs.create({ tenantId: tenant.id, title: 'private doc' } as any)
    ).save();

    expect(await db.count('cascade_2371_tenant_docs')).toBe(1);

    await tenant.delete();

    // The tenant row is gone; every row it scoped is NOT — the opposite of
    // what the natural-key-implies-CASCADE default would otherwise do.
    expect(await db.count('cascade_2371_tenants', { id: tenant.id })).toBe(0);
    expect(await db.count('cascade_2371_tenant_docs')).toBe(1);
    const remaining = await db.list('cascade_2371_tenant_docs', {});
    expect(remaining[0]?.tenant_id).toBe(tenant.id);
  });
});

/**
 * Review fixture (CI-caught regression): the cascade plan is built from the
 * process-wide registry, which can carry a class from any imported package —
 * including one whose table this specific database was never migrated to
 * include. This broke `packages/profiles`'s `OidcProfileEmailReservation.
 * delete()` in CI: the process also had `packages/assets`'s polymorphic
 * association class registered, and that table did not exist in
 * `packages/users`'s isolated test database, so the whole delete (including
 * the object's own row, since it shares the transaction) threw and aborted.
 * Each test here creates the referencing table normally, then drops it, to
 * deterministically reproduce "registered but not migrated" regardless of
 * how a given harness happens to sync schema.
 */
describe('missing referencing table tolerance (CI-caught review fix)', () => {
  let dbPath: string;
  let dbUrl: string;
  let db: DatabaseInterface;
  let docs: CascadeDocCollection;

  beforeEach(async () => {
    dbUrl = tmpDbUrl('missing-table');
    dbPath = dbUrl.replace('file:', '');
    docs = await CascadeDocCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });
    db = (docs as unknown as { _db: DatabaseInterface })._db;
  });

  afterEach(() => {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('does not fail the delete when a registered polymorphic association table does not exist', async () => {
    // Materialize the table via its own collection, then drop it — the
    // class stays registered (so it stays in plan.polymorphic), only the
    // table is gone.
    await CascadeUnmigratedAssociationCollection.create({ db });
    await db.query('DROP TABLE cascade_2371_unmigrated_assoc');

    const doc = await docs.create({ title: 'owner' } as any);
    await doc.save();

    await expect(doc.delete()).resolves.toBeUndefined();
    expect(await docs.get({ id: doc.id })).toBeNull();
  });

  it('does not fail a CASCADE reference whose table does not exist', async () => {
    await CascadeUnmigratedChildCollection.create({ db });
    await db.query('DROP TABLE cascade_2371_unmigrated_children');

    const doc = await docs.create({ title: 'cascade-owner' } as any);
    await doc.save();

    await expect(doc.delete()).resolves.toBeUndefined();
  });

  it('treats a missing RESTRICT-referencing table as zero references, not a failure', async () => {
    // Reuse the existing RESTRICT fixture (CascadeVault / CascadeVaultLock)
    // against this suite's own db: materialize the lock table, then drop it
    // entirely — a RESTRICT check against a nonexistent table must resolve
    // to "no rows," not throw and block a valid delete.
    const vaults = await CascadeVaultCollection.create({ db });
    await CascadeVaultLockCollection.create({ db });
    await db.query('DROP TABLE cascade_2371_vault_locks');

    const vault = await vaults.create({ label: 'no-lock-table' } as any);
    await vault.save();

    await expect(vault.delete()).resolves.toBeUndefined();
  });
});

describe('cascade plan (#2371)', () => {
  it('normalizes declared onDelete values', () => {
    expect(normalizeOnDelete('cascade')).toBe('CASCADE');
    expect(normalizeOnDelete('set_null')).toBe('SET NULL');
    expect(normalizeOnDelete(' Restrict ')).toBe('RESTRICT');
    expect(normalizeOnDelete('no action')).toBe('NO ACTION');
    expect(normalizeOnDelete('nonsense')).toBeUndefined();
    expect(normalizeOnDelete(undefined)).toBeUndefined();
  });

  it('drops references that resolve to NO ACTION', () => {
    const plan = buildCascadePlan(ObjectRegistry, 'CascadeDoc');
    expect(
      plan.references.some(
        (reference) => reference.className === 'CascadeNote',
      ),
    ).toBe(false);
  });

  it('records the declared actions it will apply', () => {
    const plan = buildCascadePlan(ObjectRegistry, 'CascadeDoc');
    const byClass = Object.fromEntries(
      plan.references.map((reference) => [
        reference.className,
        reference.action,
      ]),
    );

    expect(byClass.CascadeSection).toBe('CASCADE');
    expect(byClass.CascadeBookmark).toBe('SET NULL');
  });

  it('finds the polymorphic association tables that can point anywhere', () => {
    const plan = buildCascadePlan(ObjectRegistry, 'CascadeDoc');
    expect(
      plan.polymorphic.map((association) => association.tableName),
    ).toContain('cascade_2371_attachments');
  });

  it('refuses SET NULL on a required field instead of failing in the engine', () => {
    // The engine's own error would name a NOT NULL column, not the decorator
    // that asked for the impossible thing.
    expect(() => buildCascadePlan(ObjectRegistry, 'CascadeStrict')).toThrow(
      ConfigurationError,
    );
    expect(() => buildCascadePlan(ObjectRegistry, 'CascadeStrict')).toThrow(
      /SET NULL/,
    );
  });
});

/**
 * Cross-process cache broadcast on a cascade-affected table (review fix).
 *
 * `shouldBroadcastCacheInvalidation()` used to check only the *deleted*
 * object's own `@smrt({ cache })` config (rules 2/3) for a table that
 * matches `this.tableName`, and fell back to "was there a per-call
 * crossProcess read in this process" (rule 1) for every other table —
 * including a table the cascade just cleaned up on a *different* class's
 * behalf. A class that opts into `crossProcess` caching never got its
 * invalidation broadcast when its rows were removed as a side effect of a
 * parent's delete, so peer replicas could keep serving the deleted junction
 * rows until TTL. `runCascadeDelete()` now returns which qualified class
 * owns each affected table so `delete()` can check *that* class's config.
 */
describe('cascade cache broadcast (review fix: owning-class config)', () => {
  let dbPath: string;
  let dbUrl: string;
  let db: DatabaseInterface;

  beforeEach(async () => {
    dbUrl = tmpDbUrl('cache-cascade');
    dbPath = dbUrl.replace('file:', '');
    const parents = await CascadeCacheParentCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });
    db = (parents as unknown as { _db: DatabaseInterface })._db;
  });

  afterEach(() => {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  /** Minimal stub of the sql package's NotificationCapabilities: notify only. */
  function stubNotifications(): Array<{ channel: string; payload: any }> {
    const broadcasts: Array<{ channel: string; payload: any }> = [];
    (db as any).notifications = {
      async notify(channel: string, payload: any) {
        broadcasts.push({ channel, payload });
        return 1;
      },
      listen() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<never>(() => {}),
              return: () =>
                Promise.resolve({ value: undefined, done: true as const }),
            };
          },
        };
      },
    };
    return broadcasts;
  }

  const cacheBroadcastsOf = (
    broadcasts: Array<{ channel: string; payload: any }>,
  ) => broadcasts.filter((b) => b.channel === CACHE_INVALIDATION_CHANNEL);

  it("broadcasts a cascade-deleted junction table using the junction class's own crossProcess config", async () => {
    const broadcasts = stubNotifications();
    const parents = await CascadeCacheParentCollection.create({ db });
    const tags = await CascadeCacheTagCollection.create({ db });

    const parent = await parents.create({ title: 'root' } as any);
    await parent.save();
    await (
      await tags.create({ parentId: parent.id, tag: 'alpha' } as any)
    ).save();

    // The parent's own class has no cache config, so any broadcast for the
    // junction table can only come from that table's own class config.
    await parent.delete();

    const cacheBroadcasts = cacheBroadcastsOf(broadcasts);
    const junctionBroadcast = cacheBroadcasts.find(
      (b) => b.payload.table === 'cascade_2371_cache_tags',
    );
    expect(junctionBroadcast).toBeDefined();
  });

  it('still broadcasts the deleted object’s own table when it opts into crossProcess', async () => {
    // Sanity check: the fix must not have broken the direct (non-cascade)
    // rule 2/3 path this same function serves.
    const broadcasts = stubNotifications();
    const tags = await CascadeCacheTagCollection.create({ db });
    const parents = await CascadeCacheParentCollection.create({ db });
    const parent = await parents.create({ title: 'root' } as any);
    await parent.save();
    const tag = await tags.create({ parentId: parent.id, tag: 'solo' } as any);
    await tag.save();

    await tag.delete();

    const cacheBroadcasts = cacheBroadcastsOf(broadcasts);
    expect(
      cacheBroadcasts.some(
        (b) => b.payload.table === 'cascade_2371_cache_tags',
      ),
    ).toBe(true);
  });
});
