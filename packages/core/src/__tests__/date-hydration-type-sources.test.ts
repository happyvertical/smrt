/**
 * Where the type that decides Date hydration comes from (#5505):
 * - an STI `Meta<T>` field: its underlying type (`Meta<Date>` reloads as a
 *   Date, `Meta<string>` stays a string);
 * - a field registered from decorators alone whose decorator states no type:
 *   the registry's `text` is a guess, so the column-name rule still applies;
 * - the framework timestamp columns: always Dates, even under a `createdAt`
 *   alias that a stale manifest still declares as text.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field, type Meta } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { formatDataJs } from '../utils';

@smrt({ tableStrategy: 'sti' })
class DatedSourceVisit extends SmrtObject {
  label: string = '';
}

@smrt()
class DatedSourceInspection extends DatedSourceVisit {
  date: Meta<Date> = new Date(0);
  dueDate: Meta<string> = '';
}

class DatedSourceInspectionCollection extends SmrtCollection<DatedSourceInspection> {
  static readonly _itemClass = DatedSourceInspection;
}

describe('STI meta fields hydrate by their underlying type', () => {
  ObjectRegistry.registerCollection(
    'DatedSourceInspection',
    DatedSourceInspectionCollection,
  );
  let db: DatabaseInterface;
  let collection: DatedSourceInspectionCollection;
  let id: string;

  beforeAll(async () => {
    db = await getTestDatabase({
      classes: ['DatedSourceVisit', 'DatedSourceInspection'],
      type: 'sqlite',
      url: ':memory:',
    });
    collection = await DatedSourceInspectionCollection.create({ db });
    const inspection = await collection.create({
      label: 'first',
      date: new Date('2026-05-06T07:08:09.000Z'),
      dueDate: '2026-06-01',
    });
    await inspection.save();
    id = inspection.id as string;
  });
  afterAll(async () => db?.close?.());

  it('records the underlying types in the registry', () => {
    const fields = ObjectRegistry.getFields('DatedSourceInspection');
    const date = fields.get('date') as {
      type?: string;
      _meta?: { underlyingType?: string };
    };
    expect(date?.type).toBe('meta');
    expect(date?._meta?.underlyingType).toBe('datetime');
  });

  it('reloads Meta<Date> as a Date and Meta<string> as a string', async () => {
    const loaded = (await collection.get({ id })) as DatedSourceInspection;
    expect(loaded.date).toBeInstanceOf(Date);
    expect((loaded.date as Date).getTime()).toBe(
      new Date('2026-05-06T07:08:09.000Z').getTime(),
    );
    expect(loaded.dueDate).toBe('2026-06-01');
  });
});

describe('formatDataJs type sources', () => {
  it('uses the meta underlying type, and the column name when none is recorded', () => {
    const row = formatDataJs<Record<string, unknown>>(
      {
        date: '2026-05-06T07:08:09.000Z',
        due_date: '2026-06-01',
        started_at: '2026-05-06T07:08:09.000Z',
      },
      {
        date: { type: 'meta', _meta: { underlyingType: 'datetime' } },
        dueDate: { type: 'meta', _meta: { underlyingType: 'text' } },
        startedAt: { type: 'meta', _meta: {} },
      },
    );
    expect(row.date).toBeInstanceOf(Date);
    expect(row.dueDate).toBe('2026-06-01');
    expect(row.startedAt).toBeInstanceOf(Date);
  });

  it('parses the framework timestamp columns under a text alias', () => {
    const row = formatDataJs<Record<string, unknown>>(
      {
        created_at: '2026-03-02T00:00:00.000Z',
        updated_at: '2026-03-03T00:00:00.000Z',
      },
      { createdAt: { type: 'text' }, updatedAt: { type: 'text' } },
    );
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });
});

describe('decorator-only fields without a stated type', () => {
  // Declared inside a function, so no manifest describes it: registration
  // comes from the decorators alone.
  function defineDecoratorOnlyModel() {
    @smrt({ packageName: '@fixture/date-sources-runtime' })
    class DecoratorOnlyDatedVisit extends SmrtObject {
      @field({ required: true })
      publishedAt: Date = new Date(0);

      @field({ indexed: true })
      startedAt = new Date(0);

      @field({ type: 'text' })
      decidedAt: string = '';
    }
    return DecoratorOnlyDatedVisit;
  }

  it('keeps the column-name rule for a guessed type, and a stated text type stays text', () => {
    const model = defineDecoratorOnlyModel();
    const fields = Object.fromEntries(
      ObjectRegistry.getFields(model.name).entries(),
    ) as Record<string, { type?: string; _meta?: unknown }>;
    expect(fields.publishedAt?.type).toBe('text');
    const row = formatDataJs<Record<string, unknown>>(
      {
        published_at: '2026-05-06T07:08:09.000Z',
        started_at: '2026-05-06T07:08:09.000Z',
        decided_at: '2026-05-06 07:08',
      },
      fields,
    );
    expect(row.publishedAt).toBeInstanceOf(Date);
    expect(row.startedAt).toBeInstanceOf(Date);
    expect(row.decidedAt).toBe('2026-05-06 07:08');
  });
});
