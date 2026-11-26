/**
 * The JSON adapter clears a cross-package SET NULL reference with its own
 * update path; it must advance `updated_at` like the SQL path does, so a copy
 * loaded before the parent was deleted is recognisably stale. The JSON adapter
 * has no SET NULL foreign keys, so only cross-package references apply.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { crossPackageRef, field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { nullSyncReference } from '../sync-tombstones';
import { snapshotObjectRegistryState } from '../test-utils';
import { getTestDatabase } from '../testing/database';

@smrt({ packageName: '@setnull-json/docs', tableName: 'setnull_json_docs' })
class SetNullJsonDoc extends SmrtObject {
  @field() title = '';
}
class SetNullJsonDocCollection extends SmrtCollection<SetNullJsonDoc> {
  static readonly _itemClass = SetNullJsonDoc;
}

@smrt({ packageName: '@setnull-json/other', tableName: 'setnull_json_refs' })
class SetNullJsonRef extends SmrtObject {
  @field() text = '';
  @crossPackageRef('@setnull-json/docs:SetNullJsonDoc', {
    onDelete: 'SET NULL',
    nullable: true,
  } as never)
  docId: string | null = null;
}
class SetNullJsonRefCollection extends SmrtCollection<SetNullJsonRef> {
  static readonly _itemClass = SetNullJsonRef;
}

describe('SET NULL cascade revision on the JSON adapter', () => {
  let restore: () => void;
  let directory: string;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let docs: SetNullJsonDocCollection;
  let refs: SetNullJsonRefCollection;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.registerCollection(
      'SetNullJsonDoc',
      SetNullJsonDocCollection,
    );
    ObjectRegistry.registerCollection(
      'SetNullJsonRef',
      SetNullJsonRefCollection,
    );
    directory = mkdtempSync(join(tmpdir(), 'setnull-json-'));
    db = await getTestDatabase({
      type: 'json',
      url: directory,
      classes: ['SetNullJsonDoc', 'SetNullJsonRef'],
    });
    docs = (await SetNullJsonDocCollection.create({ db })) as never;
    refs = (await SetNullJsonRefCollection.create({ db })) as never;
  });

  afterEach(async () => {
    await db?.close?.();
    rmSync(directory, { recursive: true, force: true });
    restore();
  });

  async function row(id: string) {
    return ((await db.list('setnull_json_refs', {})) as any[]).find(
      (r) => r.id === id,
    );
  }

  it('cross-package SET NULL clears the reference and advances updated_at', async () => {
    const doc = await docs.create({ title: 'P' } as never);
    const ref = await refs.create({ text: 'a', docId: doc.id } as never);
    const before = await row(String(ref.id));

    await doc.delete();

    const after = await row(String(ref.id));
    expect(after.doc_id).toBeNull();
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );
  });

  it('a stale save in the same millisecond as the cascade conflicts and leaves the reference cleared', async () => {
    // One frozen clock for the whole sequence: the child's stored timestamp
    // and the cascade's own clock read are the same millisecond.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-03-04T05:06:07.500Z'));
      const doc = await docs.create({ title: 'P' } as never);
      const ref = await refs.create({ text: 'a', docId: doc.id } as never);
      const stale = (await refs.get(String(ref.id)))!;

      await doc.delete();

      const after = await row(String(ref.id));
      expect(after.doc_id).toBeNull();
      expect(new Date(after.updated_at).getTime()).toBe(
        new Date('2026-03-04T05:06:07.501Z').getTime(),
      );

      stale.text = 'edited';
      await expect(stale.save()).rejects.toMatchObject({
        code: 'RUNTIME_REVISION_CONFLICT',
      });
      const final = await row(String(ref.id));
      expect(final.doc_id).toBeNull();
      expect(final.text).toBe('a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a failed read of the referencing rows instead of skipping the timestamp', async () => {
    const doc = await docs.create({ title: 'P' } as never);
    const ref = await refs.create({ text: 'a', docId: doc.id } as never);
    const list = db.list;
    (db as any).list = async (table: string, ...rest: unknown[]) => {
      if (table === 'setnull_json_refs') throw new Error('disk read failed');
      return (list as any).call(db, table, ...rest);
    };
    let updated = -1;
    try {
      await expect(
        nullSyncReference(
          db,
          'setnull_json_refs',
          'doc_id',
          { doc_id: doc.id },
          (count) => {
            updated = count;
          },
        ),
      ).rejects.toThrow(/disk read failed/);
    } finally {
      (db as any).list = list;
    }
    expect(updated).toBe(-1);
    expect((await row(String(ref.id))).doc_id).toBe(doc.id);
  });

  it('keeps an unrelated reference untouched', async () => {
    const doc = await docs.create({ title: 'P' } as never);
    const other = await docs.create({ title: 'Q' } as never);
    const ref = await refs.create({ text: 'a', docId: other.id } as never);
    const before = await row(String(ref.id));

    await doc.delete();

    const after = await row(String(ref.id));
    expect(after.doc_id).toBe(other.id);
    expect(String(after.updated_at)).toBe(String(before.updated_at));
  });
});
