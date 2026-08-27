import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt({ tableName: 'issue_2453_revision_rows' })
class Issue2453RevisionRow extends SmrtObject {
  @field()
  title: string = '';
}

class Issue2453RevisionRows extends SmrtCollection<Issue2453RevisionRow> {
  static readonly _itemClass = Issue2453RevisionRow;
}

describe('issue #2453 revision-guarded saves', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let rows: Issue2453RevisionRows;

  beforeEach(async () => {
    db = await getTestDatabase({ classes: ['Issue2453RevisionRow'] });
    ObjectRegistry.registerCollection(
      'Issue2453RevisionRow',
      Issue2453RevisionRows,
    );
    rows = (await Issue2453RevisionRows.create({
      db,
    })) as Issue2453RevisionRows;
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('atomically rejects an update after another writer changes the row', async () => {
    const created = await rows.create({ title: 'original' });
    const first = await rows.get(String(created.id));
    if (!first) throw new Error('expected persisted row');

    const expectedUpdatedAt = first.updated_at;
    await db.update(
      'issue_2453_revision_rows',
      { id: created.id },
      {
        title: 'concurrent',
        updated_at: '2026-08-27T22:30:00.000Z',
      },
    );
    const [concurrentRow] = await db.list('issue_2453_revision_rows', {});
    expect((concurrentRow as Record<string, unknown>).updated_at).toBe(
      '2026-08-27T22:30:00.000Z',
    );

    first.title = 'stale overwrite';
    await expect(first.save({ expectedUpdatedAt })).rejects.toMatchObject({
      code: 'RUNTIME_REVISION_CONFLICT',
    });

    const stored = await rows.get(String(created.id));
    expect(stored?.title).toBe('concurrent');
  });
});
