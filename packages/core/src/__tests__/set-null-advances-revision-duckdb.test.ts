/**
 * DuckDB has no database-level ON DELETE SET NULL, so only the app-side
 * cross-package reference clears there. That SET NULL still advances
 * `updated_at`, so a copy loaded before the parent was deleted conflicts on
 * save instead of writing the deleted parent's id back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { crossPackageRef, field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { snapshotObjectRegistryState } from '../test-utils';
import { getTestDatabase } from '../testing/database';

@smrt({ packageName: '@setnull-duck/docs', tableName: 'setnull_duck_docs' })
class SetNullDuckDoc extends SmrtObject {
  @field() title = '';
}
class SetNullDuckDocCollection extends SmrtCollection<SetNullDuckDoc> {
  static readonly _itemClass = SetNullDuckDoc;
}

@smrt({ packageName: '@setnull-duck/other', tableName: 'setnull_duck_refs' })
class SetNullDuckRef extends SmrtObject {
  @field() text = '';
  @crossPackageRef('@setnull-duck/docs:SetNullDuckDoc', {
    onDelete: 'SET NULL',
    nullable: true,
  } as never)
  docId: string | null = null;
}
class SetNullDuckRefCollection extends SmrtCollection<SetNullDuckRef> {
  static readonly _itemClass = SetNullDuckRef;
}

describe('SET NULL cascade revision on duckdb', () => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let docs: SetNullDuckDocCollection;
  let refs: SetNullDuckRefCollection;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.registerCollection(
      'SetNullDuckDoc',
      SetNullDuckDocCollection,
    );
    ObjectRegistry.registerCollection(
      'SetNullDuckRef',
      SetNullDuckRefCollection,
    );
    db = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: [
        '@setnull-duck/docs:SetNullDuckDoc',
        '@setnull-duck/other:SetNullDuckRef',
      ],
    });
    docs = (await SetNullDuckDocCollection.create({ db })) as never;
    refs = (await SetNullDuckRefCollection.create({ db })) as never;
  });

  afterEach(async () => {
    await db?.close?.();
    restore();
  });

  async function row(id: string) {
    return ((await db.list('setnull_duck_refs', {})) as any[]).find(
      (r) => r.slug === id, // native UUID ids hydrate as non-strings; slug mirrors the id
    );
  }

  it('advances updated_at and conflicts a stale save', async () => {
    const doc = await docs.create({ title: 'P' } as never);
    const ref = await refs.create({ text: 'a', docId: doc.id } as never);
    const stale = (await refs.get(String(ref.id)))!;
    const before = await row(String(ref.id));

    await doc.delete();

    const after = await row(String(ref.id));
    expect(after.doc_id).toBeNull();
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );

    stale.text = 'edited';
    await expect(stale.save()).rejects.toMatchObject({
      code: 'RUNTIME_REVISION_CONFLICT',
    });
    const final = await row(String(ref.id));
    expect(final.doc_id).toBeNull();
    expect(final.text).toBe('a');
  });
});
