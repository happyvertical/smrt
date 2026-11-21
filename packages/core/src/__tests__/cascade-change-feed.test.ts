/**
 * Rows a delete cascade removes or nulls reach the change feed (#5444).
 *
 * A parent `delete()` that cascades through a natural-key junction, an
 * `onDelete: 'CASCADE'` reference or an `onDelete: 'SET NULL'` reference
 * records a `delete` entry for every removed row and an `update` entry for
 * every nulled row, each under that row's own owner, in the cascade's
 * transaction. Dependent tables' versions therefore advance, so a conditional
 * GET holding a pre-delete ETag gets a fresh 200.
 *
 * Runs on SQLite by default and on PGlite under `pnpm test:pglite`.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cascadeReferencesTo } from '../cascade';
import {
  type ChangeFeedEntry,
  getChangesSince,
  getTableVersion,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  type ChangeSignal,
  resetChangeSignals,
  subscribeToChangeSignals,
} from '../change-signals';
import {
  canonicalReadRepresentation,
  computeTableVersionEtag,
  versionConditionalResponse,
} from '../generators/conditional-get';
import { foreignKey } from '../index';
import { SmrtObject } from '../object';
import { SmrtPolymorphicAssociation } from '../polymorphic-association';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

const pglite = process.env.SMRT_TEST_PGLITE === '1';

const ORG_A = '0a0a0a0a-1111-4111-8111-0a0a0a0a0a0a';
const ORG_B = '0b0b0b0b-2222-4222-8222-0b0b0b0b0b0b';

const DOCS = 'cascade_feed_docs';
const TAGS = 'cascade_feed_doc_tags';
const SECTIONS = 'cascade_feed_sections';
const BOOKMARKS = 'cascade_feed_bookmarks';
const NOTES = 'cascade_feed_global_notes';
const SECRETS = 'cascade_feed_secrets';
const PINS = 'cascade_feed_section_pins';
const OWNED = 'cascade_feed_owned_links';
const LINKS = 'cascade_feed_links';
const REMARKS = 'cascade_feed_link_remarks';
const ITEMS = 'cascade_feed_section_items';
const ATTACHMENTS = 'cascade_feed_attachments';
const LEGACY_PARTS = 'cascade_feed_legacy_parts';
const LEGACY_REFS = 'cascade_feed_legacy_refs';
const NODES = 'cascade_feed_nodes';
const EXTRAS = '_smrt_cascade_feed_extras';
const SELF_OWNED = 'cascade_feed_self_owned';
const TEXT_NODES = 'cascade_feed_text_nodes';

@smrt({
  tableName: 'cascade_feed_docs',
  tenantScoped: { field: 'organizationId' },
})
class CascadeFeedDoc extends SmrtObject {
  title: string = '';
  organizationId: string = '';
}

/** Junction: the natural key holds the parent column, so it cascades. */
@smrt({
  tableName: 'cascade_feed_doc_tags',
  tenantScoped: { field: 'organizationId' },
  conflictColumns: ['doc_id', 'topic'],
})
class CascadeFeedDocTag extends SmrtObject {
  @foreignKey('CascadeFeedDoc', { required: true })
  docId: string = '';
  topic: string = '';
  organizationId: string = '';
}

@smrt({
  tableName: 'cascade_feed_sections',
  tenantScoped: { field: 'organizationId' },
})
class CascadeFeedSection extends SmrtObject {
  @foreignKey('CascadeFeedDoc', { onDelete: 'CASCADE' })
  docId: string = '';
  organizationId: string = '';
}

/** Grandchild that refuses its section's removal while it exists. */
@smrt({
  tableName: 'cascade_feed_section_pins',
  tenantScoped: { field: 'organizationId' },
})
class CascadeFeedSectionPin extends SmrtObject {
  @foreignKey('CascadeFeedSection', { onDelete: 'RESTRICT' })
  sectionId: string = '';
  organizationId: string = '';
}

@smrt({
  tableName: 'cascade_feed_bookmarks',
  tenantScoped: { field: 'organizationId' },
})
class CascadeFeedBookmark extends SmrtObject {
  @foreignKey('CascadeFeedDoc', { onDelete: 'SET NULL', nullable: true })
  docId: string | null = null;
  /** A second SET NULL reference to the same parent: still one entry. */
  @foreignKey('CascadeFeedDoc', { onDelete: 'SET NULL', nullable: true })
  pinnedDocId: string | null = null;
  organizationId: string = '';
}

/** Grandchild removed with its section. */
@smrt({
  tableName: 'cascade_feed_section_items',
  tenantScoped: { field: 'organizationId' },
})
class CascadeFeedSectionItem extends SmrtObject {
  @foreignKey('CascadeFeedSection', { onDelete: 'CASCADE' })
  sectionId: string = '';
  organizationId: string = '';
}

/** STI base with no owner; its subtype is owned (runtime registration). */
@smrt({ tableName: 'cascade_feed_attachments', tableStrategy: 'sti' })
class CascadeFeedAttachment extends SmrtObject {
  @foreignKey('CascadeFeedDoc', { onDelete: 'CASCADE' })
  docId: string = '';
}

/** An unowned subtype sharing the attachments table. */
@smrt()
class CascadeFeedPlainAttachment extends CascadeFeedAttachment {
  label: string = '';
}

@smrt()
class CascadeFeedOwnedAttachment extends CascadeFeedAttachment {
  workspaceId: string = '';
}

/**
 * A row owned through a reference to its own child; the database (not the
 * cascade) applies that reference's SET NULL (see the FK-cycle test).
 */
@smrt({ tableName: 'cascade_feed_cycle_owners' })
class CascadeFeedCycleOwner extends SmrtObject {
  @foreignKey('CascadeFeedCycleChild', {
    onDelete: 'SET NULL',
    nullable: true,
    constraint: false,
  })
  workspaceId: string | null = null;
}

@smrt({ tableName: 'cascade_feed_cycle_children' })
class CascadeFeedCycleChild extends SmrtObject {
  @foreignKey('CascadeFeedCycleOwner', { onDelete: 'CASCADE' })
  ownerId: string = '';
}

/** A row whose ownership column references its own table (SET NULL). */
@smrt({ tableName: 'cascade_feed_self_owned' })
class CascadeFeedSelfOwned extends SmrtObject {
  @foreignKey('CascadeFeedSelfOwned', { onDelete: 'SET NULL', nullable: true })
  workspaceId: string | null = null;
}

/** Text-keyed self-referencing rows: ids are compared exactly. */
@smrt({ tableName: 'cascade_feed_text_nodes', idType: 'text' })
class CascadeFeedTextNode extends SmrtObject {
  @foreignKey('CascadeFeedTextNode', { onDelete: 'CASCADE', nullable: true })
  parentNodeId: string | null = null;
}

/** Children whose owner column a later schema lost (see the missing-column test). */
@smrt({ tableName: 'cascade_feed_legacy_parts' })
class CascadeFeedLegacyPart extends SmrtObject {
  @foreignKey('CascadeFeedDoc', { onDelete: 'CASCADE' })
  docId: string = '';
  workspaceId: string = '';
}

@smrt({ tableName: 'cascade_feed_legacy_refs' })
class CascadeFeedLegacyRef extends SmrtObject {
  @foreignKey('CascadeFeedDoc', { onDelete: 'SET NULL', nullable: true })
  docId: string | null = null;
  workspaceId: string = '';
}

/** Self-referencing rows. */
@smrt({
  tableName: 'cascade_feed_nodes',
  tenantScoped: { field: 'organizationId' },
})
class CascadeFeedNode extends SmrtObject {
  @foreignKey('CascadeFeedNode', { onDelete: 'CASCADE', nullable: true })
  parentNodeId: string | null = null;
  organizationId: string = '';
}

/** A domain model whose table carries the framework prefix. */
@smrt({ tableName: '_smrt_cascade_feed_extras' })
class CascadeFeedExtra extends SmrtObject {
  @foreignKey('CascadeFeedDoc', { onDelete: 'CASCADE' })
  docId: string = '';
}

/** A global (unowned) child. */
@smrt({ tableName: 'cascade_feed_global_notes' })
class CascadeFeedGlobalNote extends SmrtObject {
  @foreignKey('CascadeFeedDoc', { onDelete: 'CASCADE' })
  docId: string = '';
  body: string = '';
}

/** A credential-bearing child: never recorded. */
@smrt({ tableName: 'cascade_feed_secrets', sensitive: true })
class CascadeFeedSecret extends SmrtObject {
  @foreignKey('CascadeFeedDoc', { onDelete: 'CASCADE' })
  docId: string = '';
}

/**
 * A reference column that a runtime ownership registration also names as the
 * row's owner (see the SET NULL ownership test).
 */
@smrt({ tableName: 'cascade_feed_owned_links' })
class CascadeFeedOwnedLink extends SmrtObject {
  // Declared first, so its SET NULL runs before the second reference's.
  @foreignKey('CascadeFeedDoc', { onDelete: 'SET NULL', nullable: true })
  workspaceId: string | null = null;
  @foreignKey('CascadeFeedDoc', { onDelete: 'SET NULL', nullable: true })
  docId: string | null = null;
  caption: string = '';
}

/** A junction eligible for the grouped (batch) removal path. */
@smrt({
  tableName: 'cascade_feed_links',
  tenantScoped: { field: 'organizationId' },
})
class CascadeFeedLink extends SmrtObject {
  organizationId: string = '';
  ownerKey: string = '';
  assetKey: string = '';
}

/** A polymorphic association row pointing at a link: cascades with it. */
@smrt({
  tableName: 'cascade_feed_link_remarks',
  tenantScoped: { field: 'organizationId' },
  conflictColumns: ['organization_id', 'meta_type', 'meta_id', 'role'],
})
class CascadeFeedLinkRemark extends SmrtPolymorphicAssociation {
  organizationId: string = '';
}

async function make<T extends SmrtObject>(
  Ctor: new (options: { db: DatabaseInterface }) => T,
  db: DatabaseInterface,
  values: Record<string, unknown>,
): Promise<T> {
  const instance = await new Ctor({ db }).initialize();
  Object.assign(instance, values);
  await instance.save();
  return instance as T;
}

async function feed(db: DatabaseInterface): Promise<ChangeFeedEntry[]> {
  return (await getChangesSince(db, { since: 0, limit: 5_000 })).changes;
}

function summarize(entries: ChangeFeedEntry[]) {
  return entries
    .map((entry) => [entry.table, entry.operation, entry.rowId, entry.tenantId])
    .sort((a, b) => String(a).localeCompare(String(b)));
}

async function count(db: DatabaseInterface, table: string): Promise<number> {
  const result = await db.query(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(result.rows[0]?.n);
}

describe(`delete cascades record change-feed entries (${pglite ? 'pglite' : 'sqlite'})`, () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    db = await getTestDatabase({
      type: pglite ? 'pglite' : 'sqlite',
      url: ':memory:',
      classes: [
        'CascadeFeedDoc',
        'CascadeFeedDocTag',
        'CascadeFeedSection',
        'CascadeFeedSectionPin',
        'CascadeFeedBookmark',
        'CascadeFeedGlobalNote',
        'CascadeFeedSecret',
        'CascadeFeedOwnedLink',
        'CascadeFeedLink',
        'CascadeFeedLinkRemark',
        'CascadeFeedSectionItem',
        'CascadeFeedAttachment',
        'CascadeFeedOwnedAttachment',
        'CascadeFeedPlainAttachment',
        'CascadeFeedSelfOwned',
        'CascadeFeedTextNode',
        'CascadeFeedCycleOwner',
        'CascadeFeedCycleChild',
        'CascadeFeedLegacyPart',
        'CascadeFeedLegacyRef',
        'CascadeFeedNode',
        'CascadeFeedExtra',
      ],
    });
  });

  afterEach(async () => {
    resetChangeSignals();
    await db.close?.();
  });

  async function seed(organizationId = ORG_A) {
    const doc = await make(CascadeFeedDoc, db, {
      title: 'd',
      organizationId,
    });
    const tag = await make(CascadeFeedDocTag, db, {
      docId: doc.id,
      topic: 't',
      organizationId,
    });
    const section = await make(CascadeFeedSection, db, {
      docId: doc.id,
      organizationId,
    });
    const item = await make(CascadeFeedSectionItem, db, {
      sectionId: section.id,
      organizationId,
    });
    const bookmark = await make(CascadeFeedBookmark, db, {
      docId: doc.id,
      pinnedDocId: doc.id,
      organizationId,
    });
    const note = await make(CascadeFeedGlobalNote, db, {
      docId: doc.id,
      body: 'n',
    });
    return { doc, tag, section, item, bookmark, note };
  }

  /** Register `columns` as runtime ownership columns of `ctor` until `undo()`. */
  function ownedBy(
    ctor: abstract new (...args: never[]) => SmrtObject,
    columns: string[],
  ) {
    const qualified =
      ObjectRegistry.getClassByConstructor(ctor as never)?.qualifiedName ??
      ctor.name;
    return ObjectRegistry.registerOwnershipColumnSource((name) =>
      name === qualified ? columns : undefined,
    );
  }

  it('records a delete per removed row and an update per nulled row, under each row owner', async () => {
    const { doc, tag, section, item, bookmark, note } = await seed();
    const before = (await feed(db)).length;

    await doc.delete();

    expect(await count(db, TAGS)).toBe(0);
    expect(await count(db, SECTIONS)).toBe(0);
    expect(await count(db, ITEMS)).toBe(0);
    expect(await count(db, NOTES)).toBe(0);
    const stored = await db.query(
      `SELECT doc_id, pinned_doc_id FROM ${BOOKMARKS}`,
    );
    expect(stored.rows[0]?.doc_id).toBeNull();
    expect(stored.rows[0]?.pinned_doc_id).toBeNull();

    // One entry per row, even for the bookmark both SET NULL references hit.
    const added = (await feed(db)).slice(before);
    expect(summarize(added)).toEqual(
      summarize([
        { table: DOCS, operation: 'delete', rowId: doc.id, tenantId: ORG_A },
        { table: TAGS, operation: 'delete', rowId: tag.id, tenantId: ORG_A },
        {
          table: SECTIONS,
          operation: 'delete',
          rowId: section.id,
          tenantId: ORG_A,
        },
        { table: ITEMS, operation: 'delete', rowId: item.id, tenantId: ORG_A },
        {
          table: BOOKMARKS,
          operation: 'update',
          rowId: bookmark.id,
          tenantId: ORG_A,
        },
        { table: NOTES, operation: 'delete', rowId: note.id, tenantId: null },
      ] as ChangeFeedEntry[]),
    );
  });

  it('advances dependent table versions so a conditional GET is not answered 304', async () => {
    const { doc } = await seed();
    const tables = [TAGS, SECTIONS, BOOKMARKS, NOTES];
    const versionsBefore = await Promise.all(
      tables.map((table) => getTableVersion(db, table)),
    );
    const url = `http://local/api/cascade-feed-doc-tags?docId=${doc.id}`;
    const representation = canonicalReadRepresentation(new Request(url));
    const etagBefore = computeTableVersionEtag(
      versionsBefore[0],
      representation,
    );

    await doc.delete();

    const versionsAfter = await Promise.all(
      tables.map((table) => getTableVersion(db, table)),
    );
    tables.forEach((_, index) => {
      expect(versionsAfter[index]).toBeGreaterThan(versionsBefore[index]);
    });
    const response = await versionConditionalResponse(
      new Request(url, { headers: { 'if-none-match': etagBefore } }),
      computeTableVersionEtag(versionsAfter[0], representation),
      'private, no-cache',
      async () => [],
    );
    expect(response.status).toBe(200);
  });

  it('attributes a child owned by another tenant to that tenant', async () => {
    const doc = await make(CascadeFeedDoc, db, {
      title: 'd',
      organizationId: ORG_A,
    });
    const foreign = await make(CascadeFeedSection, db, {
      docId: doc.id,
      organizationId: ORG_B,
    });
    const before = (await feed(db)).length;

    await doc.delete();

    const entry = (await feed(db))
      .slice(before)
      .find((change) => change.rowId === foreign.id);
    expect(entry).toMatchObject({
      table: SECTIONS,
      operation: 'delete',
      tenantId: ORG_B,
    });
    const tenantA = await getChangesSince(db, { since: 0, tenantId: ORG_A });
    expect(tenantA.changes.some((change) => change.rowId === foreign.id)).toBe(
      false,
    );
    const tenantB = await getChangesSince(db, { since: 0, tenantId: ORG_B });
    expect(tenantB.changes.some((change) => change.rowId === foreign.id)).toBe(
      true,
    );
  });

  it('leaves a delete that cascades nothing with only its own entry', async () => {
    const { doc: other } = await seed();
    const lone = await make(CascadeFeedDoc, db, {
      title: 'lone',
      organizationId: ORG_A,
    });
    const versionsBefore = await Promise.all(
      [TAGS, SECTIONS, BOOKMARKS, NOTES].map((table) =>
        getTableVersion(db, table),
      ),
    );
    const before = (await feed(db)).length;

    await lone.delete();

    const added = (await feed(db)).slice(before);
    expect(summarize(added)).toEqual(
      summarize([
        {
          table: DOCS,
          operation: 'delete',
          rowId: lone.id,
          tenantId: ORG_A,
        },
      ] as ChangeFeedEntry[]),
    );
    const versionsAfter = await Promise.all(
      [TAGS, SECTIONS, BOOKMARKS, NOTES].map((table) =>
        getTableVersion(db, table),
      ),
    );
    expect(versionsAfter).toEqual(versionsBefore);
    // The other document's dependents are untouched.
    expect(await count(db, TAGS)).toBe(1);
    expect(other.id).toBeTruthy();
  });

  it('records nothing when the transaction holding the cascade rolls back', async () => {
    const { doc } = await seed();
    const before = await feed(db);
    const signals: ChangeSignal[] = [];
    subscribeToChangeSignals(db, (signal) => signals.push(signal));

    await expect(
      doc.withTransaction(async (bound) => {
        await bound.delete();
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');

    expect(await feed(db)).toEqual(before);
    expect(await count(db, TAGS)).toBe(1);
    expect(await count(db, SECTIONS)).toBe(1);
    expect(signals).toEqual([]);
  });

  it('records nothing when a deeper level refuses the cascade', async () => {
    const { doc, section } = await seed();
    await make(CascadeFeedSectionPin, db, {
      sectionId: section.id,
      organizationId: ORG_A,
    });
    const before = await feed(db);

    await expect(doc.delete()).rejects.toThrow(/RESTRICT/);

    expect(await feed(db)).toEqual(before);
    expect(await count(db, TAGS)).toBe(1);
    const stored = await db.query(`SELECT doc_id FROM ${BOOKMARKS}`);
    expect(stored.rows[0]?.doc_id).toBe(doc.id);
  });

  it('records the cascade of a grouped removal through the batch path', async () => {
    const metaType =
      ObjectRegistry.getClassByConstructor(CascadeFeedLink)?.qualifiedName ??
      'CascadeFeedLink';
    const link = async (organizationId: string, assetKey: string) => {
      const row = await make(CascadeFeedLink, db, {
        organizationId,
        ownerKey: 'left',
        assetKey,
      });
      const remark = await make(CascadeFeedLinkRemark, db, {
        organizationId,
        metaType,
        metaId: row.id,
        role: 'remark',
      });
      return { row, remark };
    };
    const first = await link(ORG_A, 'asset-1');
    const second = await link(ORG_B, 'asset-2');
    const before = (await feed(db)).length;

    expect(await SmrtObject.tryJunctionBatch([first.row, second.row], [])).toBe(
      true,
    );

    expect(await count(db, REMARKS)).toBe(0);
    const added = (await feed(db)).slice(before);
    expect(summarize(added)).toEqual(
      summarize([
        {
          table: LINKS,
          operation: 'delete',
          rowId: first.row.id,
          tenantId: ORG_A,
        },
        {
          table: LINKS,
          operation: 'delete',
          rowId: second.row.id,
          tenantId: ORG_B,
        },
        {
          table: REMARKS,
          operation: 'delete',
          rowId: first.remark.id,
          tenantId: ORG_A,
        },
        {
          table: REMARKS,
          operation: 'delete',
          rowId: second.remark.id,
          tenantId: ORG_B,
        },
      ] as ChangeFeedEntry[]),
    );
  });

  it('completes the delete when the cascade entries cannot be appended', async () => {
    const { doc } = await seed();
    await db.query('DROP TABLE _smrt_changes');

    await doc.delete();

    expect(await count(db, DOCS)).toBe(0);
    expect(await count(db, TAGS)).toBe(0);
    expect(await count(db, SECTIONS)).toBe(0);
    const stored = await db.query(`SELECT doc_id FROM ${BOOKMARKS}`);
    expect(stored.rows[0]?.doc_id).toBeNull();
  });

  it('never records a credential-bearing child', async () => {
    const doc = await make(CascadeFeedDoc, db, {
      title: 'd',
      organizationId: ORG_A,
    });
    await make(CascadeFeedSecret, db, { docId: doc.id });

    await doc.delete();

    expect(await count(db, SECRETS)).toBe(0);
    expect((await feed(db)).some((entry) => entry.table === SECRETS)).toBe(
      false,
    );
  });

  it('records nothing for a row whose ownership column the cascade nulls, even when a later reference updates it again', async () => {
    // The row's owner is the referenced id; once nulled, a statement no longer
    // returns the owner it had, so neither update may become a global entry.
    const unregister = ownedBy(CascadeFeedOwnedLink, ['workspace_id']);
    try {
      const doc = await make(CascadeFeedDoc, db, {
        title: 'd',
        organizationId: ORG_A,
      });
      const link = await make(CascadeFeedOwnedLink, db, {
        workspaceId: doc.id,
        docId: doc.id,
        caption: 'l',
      });
      const before = (await feed(db)).length;

      await doc.delete();

      const stored = await db.query(
        `SELECT workspace_id, doc_id FROM ${OWNED}`,
      );
      expect(stored.rows[0]?.workspace_id).toBeNull();
      expect(stored.rows[0]?.doc_id).toBeNull();
      const added = (await feed(db)).slice(before);
      expect(added.some((entry) => entry.rowId === link.id)).toBe(false);
      expect(added.some((entry) => entry.rowId === doc.id)).toBe(true);
    } finally {
      unregister();
    }
  });

  it('records a positive multi-level cascade and a domain table with the framework prefix', async () => {
    const { doc, item } = await seed();
    const extra = await make(CascadeFeedExtra, db, { docId: doc.id });
    const before = (await feed(db)).length;

    await doc.delete();

    const added = (await feed(db)).slice(before);
    expect(added).toContainEqual(
      expect.objectContaining({
        table: ITEMS,
        operation: 'delete',
        rowId: item.id,
        tenantId: ORG_A,
      }),
    );
    expect(added).toContainEqual(
      expect.objectContaining({
        table: EXTRAS,
        operation: 'delete',
        rowId: extra.id,
        tenantId: null,
      }),
    );
  });

  it('resolves each STI row against its own class', async () => {
    const unregister = ownedBy(CascadeFeedOwnedAttachment, ['workspace_id']);
    try {
      const doc = await make(CascadeFeedDoc, db, {
        title: 'd',
        organizationId: ORG_A,
      });
      const plain = await make(CascadeFeedAttachment, db, { docId: doc.id });
      const owned = await make(CascadeFeedOwnedAttachment, db, {
        docId: doc.id,
        workspaceId: ORG_B,
      });
      const before = (await feed(db)).length;

      await doc.delete();

      expect(await count(db, ATTACHMENTS)).toBe(0);
      const added = (await feed(db)).slice(before);
      const tenantOf = (id: unknown) =>
        added.find((entry) => entry.rowId === id)?.tenantId;
      expect(tenantOf(plain.id)).toBeNull();
      expect(tenantOf(owned.id)).toBe(ORG_B);
      const tenantA = await getChangesSince(db, { since: 0, tenantId: ORG_A });
      expect(tenantA.changes.some((change) => change.rowId === owned.id)).toBe(
        false,
      );
    } finally {
      unregister();
    }
  });

  it('records nothing for a row whose registered owner field is not persisted', async () => {
    // `region_key` is an ownership column no field persists: the cascade has
    // no instance to read it from, so the row is unresolved, not global.
    const unregister = ownedBy(CascadeFeedGlobalNote, ['region_key']);
    try {
      const { doc, note } = await seed();
      const before = (await feed(db)).length;

      await doc.delete();

      expect(await count(db, NOTES)).toBe(0);
      const added = (await feed(db)).slice(before);
      expect(added.some((entry) => entry.rowId === note.id)).toBe(false);
      // (The save path records the create from the instance; only the
      // cascade's tombstone is in question here.)
      const tenantB = await getChangesSince(db, { since: 0, tenantId: ORG_B });
      expect(
        tenantB.changes.some(
          (change) => change.rowId === note.id && change.operation === 'delete',
        ),
      ).toBe(false);
    } finally {
      unregister();
    }
  });

  it('runs the cascade unchanged when a referencing table lacks an owner column', async () => {
    const doc = await make(CascadeFeedDoc, db, {
      title: 'd',
      organizationId: ORG_A,
    });
    const part = await make(CascadeFeedLegacyPart, db, {
      docId: doc.id,
      workspaceId: ORG_A,
    });
    const ref = await make(CascadeFeedLegacyRef, db, {
      docId: doc.id,
      workspaceId: ORG_A,
    });
    await db.query(`ALTER TABLE ${LEGACY_PARTS} DROP COLUMN workspace_id`);
    await db.query(`ALTER TABLE ${LEGACY_REFS} DROP COLUMN workspace_id`);
    const unregisterParts = ownedBy(CascadeFeedLegacyPart, ['workspace_id']);
    const unregisterRefs = ownedBy(CascadeFeedLegacyRef, ['workspace_id']);
    try {
      const before = (await feed(db)).length;

      await doc.delete();

      expect(await count(db, DOCS)).toBe(0);
      expect(await count(db, LEGACY_PARTS)).toBe(0);
      const stored = await db.query(`SELECT doc_id FROM ${LEGACY_REFS}`);
      expect(stored.rows[0]?.doc_id).toBeNull();
      const added = (await feed(db)).slice(before);
      expect(added.some((entry) => entry.rowId === part.id)).toBe(false);
      expect(added.some((entry) => entry.rowId === ref.id)).toBe(false);
      expect(added.some((entry) => entry.rowId === doc.id)).toBe(true);
    } finally {
      unregisterParts();
      unregisterRefs();
    }
  });

  it('records a self-referencing row once, under its stored owner', async () => {
    const root = await make(CascadeFeedNode, db, { organizationId: ORG_A });
    root.parentNodeId = root.id ?? null;
    await root.save();
    const child = await make(CascadeFeedNode, db, {
      parentNodeId: root.id,
      organizationId: ORG_A,
    });
    const before = (await feed(db)).length;
    // An owner that drifted in memory must not decide the tombstone.
    root.organizationId = ORG_B;

    await root.delete();

    expect(await count(db, NODES)).toBe(0);
    const added = (await feed(db)).slice(before);
    expect(summarize(added)).toEqual(
      summarize([
        {
          table: NODES,
          operation: 'delete',
          rowId: root.id,
          tenantId: ORG_A,
        },
        {
          table: NODES,
          operation: 'delete',
          rowId: child.id,
          tenantId: ORG_A,
        },
      ] as ChangeFeedEntry[]),
    );
  });

  it('records every row of a cascade larger than one append batch', async () => {
    const doc = await make(CascadeFeedDoc, db, {
      title: 'd',
      organizationId: ORG_A,
    });
    const note = await make(CascadeFeedGlobalNote, db, {
      docId: doc.id,
      body: 'n',
    });
    // Clone the saved row so the bulk insert carries every column it needs.
    const template = (await db.query(`SELECT * FROM ${NOTES}`)).rows[0];
    const ids: string[] = [note.id as string];
    for (let index = 0; index < 1_004; index++) {
      const id = crypto.randomUUID();
      ids.push(id);
      await db.insert(NOTES, { ...template, id, slug: `note-${index}` });
    }
    const before = (await feed(db)).length;

    await doc.delete();

    expect(await count(db, NOTES)).toBe(0);
    const recorded = (await feed(db))
      .slice(before)
      .filter((entry) => entry.table === NOTES);
    expect(recorded).toHaveLength(ids.length);
    expect(new Set(recorded.map((entry) => entry.rowId))).toEqual(new Set(ids));
  });

  it('records a multi-parent SET NULL through cascadeReferencesTo', async () => {
    const first = await seed(ORG_A);
    const second = await seed(ORG_B);
    const qualified =
      ObjectRegistry.getClassByConstructor(CascadeFeedDoc)?.qualifiedName ??
      'CascadeFeedDoc';
    const before = (await feed(db)).length;

    await cascadeReferencesTo(db, ObjectRegistry, {
      className: qualified,
      tableName: DOCS,
      ids: [first.doc.id as string, second.doc.id as string],
    });

    const updates = (await feed(db))
      .slice(before)
      .filter((entry) => entry.table === BOOKMARKS);
    expect(summarize(updates)).toEqual(
      summarize([
        {
          table: BOOKMARKS,
          operation: 'update',
          rowId: first.bookmark.id,
          tenantId: ORG_A,
        },
        {
          table: BOOKMARKS,
          operation: 'update',
          rowId: second.bookmark.id,
          tenantId: ORG_B,
        },
      ] as ChangeFeedEntry[]),
    );
  });

  it.skipIf(!pglite)(
    'skips the entries when the drain helper is unavailable and still commits the delete',
    async () => {
      const { doc, tag } = await seed();
      await db.query('DROP FUNCTION _smrt_drain_changes(integer, text[])');

      await doc.delete();

      expect(await count(db, DOCS)).toBe(0);
      expect(await count(db, TAGS)).toBe(0);
      const rows = await db.query(
        `SELECT COUNT(*) AS n FROM _smrt_changes_pending WHERE row_id = $1`,
        tag.id,
      );
      expect(Number(rows.rows[0]?.n)).toBe(0);
    },
  );

  it.skipIf(!pglite)(
    'never calls a feed helper without its exception boundary, and keeps a concurrent write on the same transaction',
    async () => {
      const { doc } = await seed();
      const other = await make(CascadeFeedDoc, db, {
        title: 'other',
        organizationId: ORG_A,
      });
      // A helper body that raises outside any exception handler of its own
      // (not the framework's canonical body).
      await db.query('DROP FUNCTION _smrt_append_changes(jsonb)');
      await db.query(
        `CREATE FUNCTION _smrt_append_changes(input jsonb)
           RETURNS TABLE (entry_index integer, allocated_seq bigint, error_code text, error_message text)
           LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'feed unavailable'; END $$`,
      );

      // The caller's own write runs on the same transaction handle while the
      // cascade records its entries; nothing may roll it back.
      await doc.withTransaction(async (bound) => {
        await Promise.all([
          bound.delete(),
          bound.db.query(
            `UPDATE ${DOCS} SET title = 'changed' WHERE id = $1`,
            other.id,
          ),
        ]);
      });

      expect(await count(db, SECTIONS)).toBe(0);
      const rows = await db.query(
        `SELECT id, title FROM ${DOCS} WHERE id IN ($1, $2)`,
        doc.id,
        other.id,
      );
      expect(rows.rows).toEqual([{ id: other.id, title: 'changed' }]);
    },
  );

  it('keeps a self-referencing ownership column of the deleted row for its own tombstone', async () => {
    const unregister = ownedBy(CascadeFeedSelfOwned, ['workspace_id']);
    try {
      const row = await make(CascadeFeedSelfOwned, db, {});
      row.workspaceId = row.id ?? null;
      await row.save();
      const before = (await feed(db)).length;

      await row.delete();

      expect(await count(db, SELF_OWNED)).toBe(0);
      const tombstones = (await feed(db))
        .slice(before)
        .filter((entry) => entry.rowId === row.id);
      expect(tombstones).toEqual([
        expect.objectContaining({ operation: 'delete', tenantId: row.id }),
      ]);
      const elsewhere = await getChangesSince(db, {
        since: 0,
        tenantId: ORG_B,
      });
      expect(
        elsewhere.changes.some(
          (change) => change.rowId === row.id && change.operation === 'delete',
        ),
      ).toBe(false);
    } finally {
      unregister();
    }
  });

  it('leaves a self-pointing association row to its own delete, under its stored owner', async () => {
    const metaType =
      ObjectRegistry.getClassByConstructor(CascadeFeedLinkRemark)
        ?.qualifiedName ?? 'CascadeFeedLinkRemark';
    const remark = await make(CascadeFeedLinkRemark, db, {
      organizationId: ORG_A,
      metaType,
      metaId: '00000000-0000-4000-8000-000000000000',
      role: 'self',
    });
    remark.metaId = remark.id as string;
    await remark.save();
    const before = (await feed(db)).length;
    // An owner that drifted in memory must not decide the tombstone.
    remark.organizationId = ORG_B;

    await remark.delete();

    expect(await count(db, REMARKS)).toBe(0);
    const tombstones = (await feed(db))
      .slice(before)
      .filter((entry) => entry.rowId === remark.id);
    expect(tombstones).toEqual([
      expect.objectContaining({ operation: 'delete', tenantId: ORG_A }),
    ]);
    const tenantB = await getChangesSince(db, { since: 0, tenantId: ORG_B });
    expect(
      tenantB.changes.some(
        (change) => change.rowId === remark.id && change.operation === 'delete',
      ),
    ).toBe(false);
  });

  it('keeps distinct text ids distinct, including ids spelled like the deleted row', async () => {
    const rootId = 'ABCDEF01-2345-4678-9ABC-DEF012345678';
    const lower = rootId.toLowerCase();
    const bare = rootId.replaceAll('-', '');
    const root = await make(CascadeFeedTextNode, db, {
      id: rootId,
      slug: 'root',
    });
    await make(CascadeFeedTextNode, db, {
      id: lower,
      slug: 'lower',
      parentNodeId: rootId,
    });
    await make(CascadeFeedTextNode, db, {
      id: bare,
      slug: 'bare',
      parentNodeId: rootId,
    });
    const stored = await db.query(`SELECT id FROM ${TEXT_NODES} ORDER BY id`);
    expect(stored.rows.map((row) => row.id).sort()).toEqual(
      [rootId, lower, bare].sort(),
    );
    const before = (await feed(db)).length;

    await root.delete();

    expect(await count(db, TEXT_NODES)).toBe(0);
    const tombstones = (await feed(db))
      .slice(before)
      .filter((entry) => entry.table === TEXT_NODES);
    expect(tombstones.map((entry) => entry.rowId).sort()).toEqual(
      [rootId, lower, bare].sort(),
    );
  });

  it('records nothing for an STI row whose legacy discriminator names two classes', async () => {
    const unregister = ownedBy(CascadeFeedOwnedAttachment, ['workspace_id']);
    try {
      const plainName =
        ObjectRegistry.getClassByConstructor(CascadeFeedPlainAttachment)
          ?.qualifiedName ?? 'CascadeFeedPlainAttachment';
      const ownedName =
        ObjectRegistry.getClassByConstructor(CascadeFeedOwnedAttachment)
          ?.qualifiedName ?? 'CascadeFeedOwnedAttachment';
      const twin = 'CascadeFeedTwinAttachment';
      // Two subtypes (as from two packages) sharing one simple name, and rows
      // written with that legacy simple discriminator.
      const registry = new Proxy(ObjectRegistry, {
        get(target, property) {
          if (property === 'getClass') {
            return (name: string) => {
              const registered = target.getClass(name);
              return registered &&
                (registered.qualifiedName === plainName ||
                  registered.qualifiedName === ownedName)
                ? { ...registered, name: twin }
                : registered;
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as typeof ObjectRegistry;
      const doc = await make(CascadeFeedDoc, db, {
        title: 'd',
        organizationId: ORG_A,
      });
      const owned = await make(CascadeFeedOwnedAttachment, db, {
        docId: doc.id,
        workspaceId: ORG_B,
      });
      await db.query(
        `UPDATE ${ATTACHMENTS} SET _meta_type = '${twin}' WHERE id = '${owned.id}'`,
      );
      const before = (await feed(db)).length;

      await cascadeReferencesTo(db, registry, {
        className:
          ObjectRegistry.getClassByConstructor(CascadeFeedDoc)?.qualifiedName ??
          'CascadeFeedDoc',
        tableName: DOCS,
        ids: [doc.id as string],
      });

      expect(await count(db, ATTACHMENTS)).toBe(0);
      const added = (await feed(db)).slice(before);
      expect(added.some((entry) => entry.rowId === owned.id)).toBe(false);
    } finally {
      unregister();
    }
  });

  it('records nothing for an STI row whose case-variant discriminator names two subtypes', async () => {
    const unregister = ownedBy(CascadeFeedOwnedAttachment, ['workspace_id']);
    try {
      const plainName =
        ObjectRegistry.getClassByConstructor(CascadeFeedPlainAttachment)
          ?.qualifiedName ?? 'CascadeFeedPlainAttachment';
      const ownedName =
        ObjectRegistry.getClassByConstructor(CascadeFeedOwnedAttachment)
          ?.qualifiedName ?? 'CascadeFeedOwnedAttachment';
      const baseName =
        ObjectRegistry.getClassByConstructor(CascadeFeedAttachment)
          ?.qualifiedName ?? 'CascadeFeedAttachment';
      // Two subtypes from two packages whose simple names differ only by
      // case (one registry cannot hold both within one package), and a row
      // written with a legacy, lower-cased simple discriminator. The
      // registry's own name lookup folds case and answers with the first
      // match, as the real one does for an ambiguous simple name.
      const aliases = new Map([
        [plainName, '@pkg-a/fixtures:CascadeFeedTwin'],
        [ownedName, '@pkg-b/fixtures:CASCADEFEEDTWIN'],
      ]);
      const byAlias = new Map(
        [...aliases].map(([real, alias]) => [alias, real]),
      );
      const registry = new Proxy(ObjectRegistry, {
        get(target, property) {
          if (property === 'getDescendants') {
            return (name: string) =>
              name === baseName
                ? [...aliases.values()]
                : target.getDescendants(name);
          }
          if (property === 'getClass') {
            return (name: string) => {
              const real =
                byAlias.get(name) ??
                (name.toLowerCase() === 'cascadefeedtwin'
                  ? plainName
                  : undefined);
              if (!real) return target.getClass(name);
              const registered = target.getClass(real);
              const alias = aliases.get(real) as string;
              return registered
                ? {
                    ...registered,
                    qualifiedName: alias,
                    name: alias.slice(alias.lastIndexOf(':') + 1),
                  }
                : undefined;
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as typeof ObjectRegistry;
      const doc = await make(CascadeFeedDoc, db, {
        title: 'd',
        organizationId: ORG_A,
      });
      const owned = await make(CascadeFeedOwnedAttachment, db, {
        docId: doc.id,
        workspaceId: ORG_B,
      });
      await db.query(
        `UPDATE ${ATTACHMENTS} SET _meta_type = 'cascadefeedtwin' WHERE id = '${owned.id}'`,
      );
      const before = (await feed(db)).length;

      await cascadeReferencesTo(db, registry, {
        className:
          ObjectRegistry.getClassByConstructor(CascadeFeedDoc)?.qualifiedName ??
          'CascadeFeedDoc',
        tableName: DOCS,
        ids: [doc.id as string],
      });

      // The row is removed as before — but attributed to neither candidate.
      expect(await count(db, ATTACHMENTS)).toBe(0);
      const added = (await feed(db)).slice(before);
      expect(added.some((entry) => entry.rowId === owned.id)).toBe(false);
    } finally {
      unregister();
    }
  });

  it.skipIf(!pglite)(
    'records no tombstone under an owner a database action rewrote during the cascade',
    async () => {
      const unregister = ownedBy(CascadeFeedCycleOwner, ['workspace_id']);
      try {
        const owner = await make(CascadeFeedCycleOwner, db, {});
        const child = await make(CascadeFeedCycleChild, db, {
          ownerId: owner.id,
        });
        owner.workspaceId = child.id ?? null;
        await owner.save();
        // The database, not the cascade, applies this reference: deleting
        // the child clears the owner's ownership column before the owner's
        // own DELETE returns it.
        await db.query(
          `ALTER TABLE cascade_feed_cycle_owners
             ADD FOREIGN KEY (workspace_id)
             REFERENCES cascade_feed_cycle_children (id) ON DELETE SET NULL`,
        );
        const before = (await feed(db)).length;

        await owner.delete();

        expect(await count(db, 'cascade_feed_cycle_owners')).toBe(0);
        const added = (await feed(db)).slice(before);
        expect(
          added.some(
            (entry) => entry.rowId === owner.id && entry.tenantId === null,
          ),
        ).toBe(false);
        const elsewhere = await getChangesSince(db, {
          since: 0,
          tenantId: ORG_B,
        });
        expect(
          elsewhere.changes.some(
            (change) =>
              change.rowId === owner.id && change.operation === 'delete',
          ),
        ).toBe(false);
      } finally {
        unregister();
      }
    },
  );

  it.skipIf(pglite)(
    'excludes a target batch larger than the engine’s bound-parameter limit',
    async () => {
      const root = await make(CascadeFeedTextNode, db, {
        id: 'b-0',
        slug: 'b-0',
      });
      const columns = (
        await db.query(`SELECT name FROM pragma_table_info('${TEXT_NODES}')`)
      ).rows.map((row) => String(row.name));
      const value = (column: string) =>
        column === 'id' || column === 'slug'
          ? `'b-' || n.i`
          : column === 'parent_node_id'
            ? `'b-' || (n.i - 1)`
            : `t."${column}"`;
      const total = 33_000;
      await db.query(
        `INSERT INTO ${TEXT_NODES} (${columns.map((column) => `"${column}"`).join(', ')})
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${total})
         SELECT ${columns.map(value).join(', ')}
           FROM n, ${TEXT_NODES} AS t WHERE t.id = '${root.id}'`,
      );
      const ids = Array.from({ length: total + 1 }, (_, index) => `b-${index}`);

      // Every child is itself a target: the cascade must exclude all of them
      // without binding one parameter per target.
      await cascadeReferencesTo(db, ObjectRegistry, {
        className:
          ObjectRegistry.getClassByConstructor(CascadeFeedTextNode)
            ?.qualifiedName ?? 'CascadeFeedTextNode',
        tableName: TEXT_NODES,
        ids,
      });

      expect(await count(db, TEXT_NODES)).toBe(total + 1);
    },
  );

  it('records nothing for a row whose explicitly registered tenant_id is not persisted', async () => {
    const unregister = ownedBy(CascadeFeedGlobalNote, ['tenant_id']);
    try {
      const { doc, note } = await seed();
      const before = (await feed(db)).length;

      await doc.delete();

      expect(await count(db, NOTES)).toBe(0);
      const added = (await feed(db)).slice(before);
      expect(added.some((entry) => entry.rowId === note.id)).toBe(false);
    } finally {
      unregister();
    }
  });

  it.skipIf(pglite)(
    'publishes cascaded signals only after the transaction commits',
    async () => {
      const { doc, tag } = await seed();
      const signals: ChangeSignal[] = [];
      subscribeToChangeSignals(db, (signal) => signals.push(signal));
      let duringTransaction: ChangeSignal[] = [];

      await doc.withTransaction(async (bound) => {
        await bound.delete();
        duringTransaction = [...signals];
      });

      expect(duringTransaction).toEqual([]);
      expect(signals).toContainEqual(
        expect.objectContaining({
          table: TAGS,
          operation: 'delete',
          rowId: tag.id,
          tenantId: ORG_A,
        }),
      );
    },
  );
});
