/**
 * A SET NULL cascade changes the child row, so it advances `updated_at` like
 * any other write: a copy of the child loaded before the parent was deleted
 * conflicts on save instead of restoring the cleared reference. Runs on
 * SQLite by default and on PGlite under `pnpm test:pglite`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { crossPackageRef, field, foreignKey } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { snapshotObjectRegistryState } from '../test-utils';
import { getTestDatabase } from '../testing/database';

@smrt({ packageName: '@setnull-rev/docs', tableName: 'setnull_rev_docs' })
class SetNullRevDoc extends SmrtObject {
  @field() title = '';
}
class SetNullRevDocCollection extends SmrtCollection<SetNullRevDoc> {
  static readonly _itemClass = SetNullRevDoc;
}

@smrt({ packageName: '@setnull-rev/docs', tableName: 'setnull_rev_notes' })
class SetNullRevNote extends SmrtObject {
  @field() text = '';
  @foreignKey('SetNullRevDoc', { onDelete: 'SET NULL', nullable: true })
  docId: string | null = null;
}
class SetNullRevNoteCollection extends SmrtCollection<SetNullRevNote> {
  static readonly _itemClass = SetNullRevNote;
}

@smrt({ packageName: '@setnull-rev/other', tableName: 'setnull_rev_refs' })
class SetNullRevRef extends SmrtObject {
  @field() text = '';
  @crossPackageRef('@setnull-rev/docs:SetNullRevDoc', {
    onDelete: 'SET NULL',
    nullable: true,
  } as never)
  docId: string | null = null;
}
class SetNullRevRefCollection extends SmrtCollection<SetNullRevRef> {
  static readonly _itemClass = SetNullRevRef;
}

type Engine = 'sqlite' | 'pglite';
const engines: Engine[] =
  process.env.SMRT_TEST_PGLITE === '1' ? ['pglite'] : ['sqlite'];

describe.each(engines)('SET NULL cascade revision on %s', (engine) => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let docs: SetNullRevDocCollection;
  let notes: SetNullRevNoteCollection;
  let refs: SetNullRevRefCollection;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.registerCollection('SetNullRevDoc', SetNullRevDocCollection);
    ObjectRegistry.registerCollection(
      'SetNullRevNote',
      SetNullRevNoteCollection,
    );
    ObjectRegistry.registerCollection('SetNullRevRef', SetNullRevRefCollection);
    db = await getTestDatabase({
      type: engine,
      ...(engine === 'sqlite' ? { url: ':memory:' } : {}),
      classes: ['SetNullRevDoc', 'SetNullRevNote', 'SetNullRevRef'],
    });
    docs = (await SetNullRevDocCollection.create({ db })) as never;
    notes = (await SetNullRevNoteCollection.create({ db })) as never;
    refs = (await SetNullRevRefCollection.create({ db })) as never;
  });

  afterEach(async () => {
    await db?.close?.();
    restore();
  });

  async function row(table: string, id: string) {
    return ((await db.list(table, {})) as any[]).find((r) => r.id === id);
  }

  it('control: an ordinary concurrent save makes the stale save conflict', async () => {
    const doc = await docs.create({ title: 'P' } as never);
    const note = await notes.create({ text: 'a', docId: doc.id } as never);
    const stale = (await notes.get(String(note.id)))!;
    const fresh = (await notes.get(String(note.id)))!;
    fresh.text = 'fresh';
    await fresh.save();
    stale.text = 'stale';
    await expect(stale.save()).rejects.toMatchObject({
      code: 'RUNTIME_REVISION_CONFLICT',
    });
  });

  it('cross-package SET NULL advances updated_at and conflicts a stale save', async () => {
    const doc = await docs.create({ title: 'P' } as never);
    const ref = await refs.create({ text: 'a', docId: doc.id } as never);
    const stale = (await refs.get(String(ref.id)))!;
    const before = await row('setnull_rev_refs', String(ref.id));

    await doc.delete();

    const after = await row('setnull_rev_refs', String(ref.id));
    expect(after.doc_id).toBeNull();
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );

    stale.text = 'edited';
    await expect(stale.save()).rejects.toMatchObject({
      code: 'RUNTIME_REVISION_CONFLICT',
    });
    const final = await row('setnull_rev_refs', String(ref.id));
    expect(final.doc_id).toBeNull();
    expect(final.text).toBe('a');
  });

  it('foreign-key SET NULL advances updated_at and conflicts a stale save', async () => {
    const doc = await docs.create({ title: 'P' } as never);
    const note = await notes.create({ text: 'a', docId: doc.id } as never);
    const stale = (await notes.get(String(note.id)))!;
    const before = await row('setnull_rev_notes', String(note.id));

    await doc.delete();

    const after = await row('setnull_rev_notes', String(note.id));
    expect(after.doc_id).toBeNull();
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );

    stale.text = 'edited';
    await expect(stale.save()).rejects.toMatchObject({
      code: 'RUNTIME_REVISION_CONFLICT',
    });
  });

  it('keeps an unrelated child untouched', async () => {
    const doc = await docs.create({ title: 'P' } as never);
    const other = await docs.create({ title: 'Q' } as never);
    const note = await notes.create({ text: 'a', docId: other.id } as never);
    const before = await row('setnull_rev_notes', String(note.id));

    await doc.delete();

    const after = await row('setnull_rev_notes', String(note.id));
    expect(after.doc_id).toBe(other.id);
    expect(String(after.updated_at)).toBe(String(before.updated_at));
  });
});
