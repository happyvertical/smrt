/**
 * A field declared as text stays text, whatever its column name (#5505).
 * The `*_at` / `*_date` / `date` column-name heuristic only applies to keys
 * with no field definition, and a field initialised with `new Date()` is a
 * real datetime field (scanner inference), so it keeps hydrating as a Date.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { formatDataJs } from '../utils';

@smrt({ packageName: '@fixture/text-dates' })
class TextDatedErrand extends SmrtObject {
  @field({ type: 'text' })
  title: string = '';

  @field({ type: 'text' })
  dueDate: string = '';

  @field({ type: 'text' })
  decidedAt: string = '';

  @field({ type: 'text' })
  date: string = '';

  // Unannotated Date initializer: inferred datetime by the scanner.
  recordedAt = new Date();

  constructor(options: any = {}) {
    super(options);
    for (const k of ['title', 'dueDate', 'decidedAt', 'date', 'recordedAt'])
      if (options[k] !== undefined) (this as any)[k] = options[k];
  }
}
class TextDatedErrandCollection extends SmrtCollection<TextDatedErrand> {
  static readonly _itemClass = TextDatedErrand;
}

describe('formatDataJs date handling', () => {
  it('keeps a declared text value a string even when its column ends in _at or _date', () => {
    const row = formatDataJs(
      { due_date: '2026-03-01', decided_at: '2026-03-01 09:30', date: '2026' },
      {
        dueDate: { type: 'text' },
        decidedAt: { type: 'text' },
        date: { type: 'text' },
      },
    );
    expect(row).toMatchObject({
      dueDate: '2026-03-01',
      decidedAt: '2026-03-01 09:30',
      date: '2026',
    });
  });

  it('parses declared datetime fields and undeclared date-named keys', () => {
    const row = formatDataJs<Record<string, unknown>>(
      {
        recorded_at: '2026-03-01T00:00:00.000Z',
        created_at: '2026-03-02T00:00:00.000Z',
      },
      { recordedAt: { type: 'datetime' } },
    );
    expect(row.recordedAt).toBeInstanceOf(Date);
    // No field definition for created_at: the name fallback still applies.
    expect(row.createdAt).toBeInstanceOf(Date);
    const noSchema = formatDataJs<Record<string, unknown>>({
      ended_at: '2026-03-03T00:00:00.000Z',
    });
    expect(noSchema.endedAt).toBeInstanceOf(Date);
  });
});

describe('declared text date-named fields round-trip unchanged', () => {
  ObjectRegistry.registerCollection(
    'TextDatedErrand',
    TextDatedErrandCollection,
  );
  let db: DatabaseInterface;
  let collection: TextDatedErrandCollection;
  let id: string;
  const raw = async () =>
    (
      await db.query(
        `SELECT due_date, decided_at, date FROM ${(collection as any).tableName} WHERE id = $1`,
        [id],
      )
    ).rows[0];

  beforeAll(async () => {
    db = await getTestDatabase({
      classes: ['TextDatedErrand'],
      type: 'sqlite',
      url: ':memory:',
    });
    collection = await TextDatedErrandCollection.create({ db });
    const errand = await collection.create({
      title: 'first',
      dueDate: '2026-03-01',
      decidedAt: '2026-03-01 09:30',
      date: '2026',
      recordedAt: new Date('2026-04-05T06:07:08.000Z'),
    });
    await errand.save();
    id = errand.id as string;
  });
  afterAll(async () => db?.close?.());

  it('records the Date initializer field as datetime in the registry', () => {
    const recorded = ObjectRegistry.getFields('TextDatedErrand').get(
      'recordedAt',
    ) as { type?: string } | undefined;
    expect(String(recorded?.type).toLowerCase()).toBe('datetime');
  });

  it('hydrates declared text as strings and the datetime field as a Date', async () => {
    const loaded = (await collection.get({ id })) as TextDatedErrand;
    expect(loaded.dueDate).toBe('2026-03-01');
    expect(loaded.decidedAt).toBe('2026-03-01 09:30');
    expect(loaded.date).toBe('2026');
    expect(loaded.recordedAt).toBeInstanceOf(Date);
    expect(loaded.recordedAt.toISOString()).toBe('2026-04-05T06:07:08.000Z');
  });

  it('does not rewrite declared text on an unrelated save, so string filters keep matching', async () => {
    const loaded = (await collection.get({ id })) as TextDatedErrand;
    loaded.title = 'renamed';
    await loaded.save();
    expect(await raw()).toEqual({
      due_date: '2026-03-01',
      decided_at: '2026-03-01 09:30',
      date: '2026',
    });
    expect(await collection.count({ where: { dueDate: '2026-03-01' } })).toBe(
      1,
    );
  });
});
