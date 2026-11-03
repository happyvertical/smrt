/**
 * Issue #4604: `getOrUpsert()`'s diff guard must compare JSON fields
 * structurally. It compared every non-Date value with `===`, so an object or
 * array JSON field never matched its hydrated stored value and every call
 * re-saved the row, moved `updated_at`, and appended a `_smrt_changes` entry.
 *
 * Runs against real in-process SQLite and DuckDB (never a mocked database).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChangeFeedEntry,
  getChangesSince,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt({ tableName: 'issue_4604_schedules', cli: false, mcp: false })
class Issue4604Schedule extends SmrtObject {
  @field({ required: true })
  name: string = '';

  @field({ type: 'json' })
  methodArgs: Record<string, unknown> = {};

  @field({ type: 'json' })
  tags: unknown[] = [];

  @field()
  priority: number = 0;
}

class Issue4604Schedules extends SmrtCollection<Issue4604Schedule> {
  static readonly _itemClass = Issue4604Schedule;
}

const BACKENDS = [
  { type: 'sqlite' as const, url: ':memory:' },
  { type: 'duckdb' as const, url: ':memory:' },
];

describe.each(BACKENDS)('Issue #4604: getOrUpsert JSON diff guard ($type)', ({
  type,
  url,
}) => {
  let db: DatabaseInterface;
  let schedules: Issue4604Schedules;

  const baseData = () => ({
    slug: 'nightly-sync',
    name: 'Nightly sync',
    priority: 3,
    methodArgs: {
      includeGeneric: true,
      reason: 'scheduled',
      window: { from: 1, to: [2, 3] },
    },
    tags: ['a', { b: 1, c: null }],
  });

  const changesFor = async (rowId: string): Promise<ChangeFeedEntry[]> => {
    const { changes } = await getChangesSince(db, { since: 0 });
    return changes.filter((change) => change.rowId === rowId);
  };

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    db = await getTestDatabase({
      type,
      url,
      classes: [Issue4604Schedule.name],
    });
    schedules = await Issue4604Schedules.create({ db });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.close?.();
  });

  it('performs zero writes when object/array JSON fields are unchanged', async () => {
    const created = await schedules.getOrUpsert(baseData());
    const before = await schedules.get(
      { slug: 'nightly-sync', context: '' },
      { cache: false },
    );
    expect(before).not.toBeNull();
    const updatedAtBefore = new Date(
      before?.updated_at as unknown as string | Date,
    ).getTime();
    const changesBefore = await changesFor(created.id as string);
    expect(changesBefore).toHaveLength(1);

    const saveSpy = vi.spyOn(SmrtObject.prototype, 'save');
    const upsertSpy = vi.spyOn(db, 'upsert');
    const updateSpy = vi.spyOn(db, 'update');

    // Same values, fresh object identities, and different key order.
    const reordered = baseData();
    const again = await schedules.getOrUpsert({
      ...reordered,
      methodArgs: {
        window: { to: [2, 3], from: 1 },
        reason: 'scheduled',
        includeGeneric: true,
      },
      tags: ['a', { c: null, b: 1 }],
    });
    await schedules.getOrUpsert(baseData());

    expect(again.id).toBe(created.id);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();

    const after = await schedules.get(
      { slug: 'nightly-sync', context: '' },
      { cache: false },
    );
    expect(
      new Date(after?.updated_at as unknown as string | Date).getTime(),
    ).toBe(updatedAtBefore);
    expect(await changesFor(created.id as string)).toHaveLength(1);
  });

  it('still writes when a nested JSON value changes', async () => {
    const created = await schedules.getOrUpsert(baseData());

    const changed = baseData();
    changed.methodArgs.window.to = [2, 4];
    const saveSpy = vi.spyOn(SmrtObject.prototype, 'save');
    await schedules.getOrUpsert(changed);
    expect(saveSpy).toHaveBeenCalledTimes(1);

    const reloaded = await schedules.get(
      { slug: 'nightly-sync', context: '' },
      { cache: false },
    );
    const args = reloaded?.methodArgs as {
      window: { to: number[] };
    };
    expect(args.window.to).toEqual([2, 4]);
    expect(await changesFor(created.id as string)).toHaveLength(2);
  });

  it('still writes when a JSON array changes order or gains a key', async () => {
    const created = await schedules.getOrUpsert(baseData());

    const saveSpy = vi.spyOn(SmrtObject.prototype, 'save');
    await schedules.getOrUpsert({
      ...baseData(),
      tags: [{ b: 1, c: null }, 'a'],
    });
    await schedules.getOrUpsert({
      ...baseData(),
      tags: [{ b: 1, c: null }, 'a'],
      methodArgs: { ...baseData().methodArgs, extra: false },
    });
    expect(saveSpy).toHaveBeenCalledTimes(2);
    expect(await changesFor(created.id as string)).toHaveLength(3);
  });
});

describe('Issue #4604: getDiff compares JSON fields structurally', () => {
  let db: DatabaseInterface;
  let schedules: Issue4604Schedules;

  beforeEach(async () => {
    db = await getTestDatabase({ classes: [Issue4604Schedule.name] });
    schedules = await Issue4604Schedules.create({ db });
  });

  afterEach(async () => {
    await db?.close?.();
  });

  it('treats a JSON-text stored value as equal to the same object', async () => {
    const existing = {
      methodArgs: '{"b":[1,{"y":2,"x":1}],"a":true}',
      tags: '[]',
      priority: 3,
    };
    expect(
      await schedules.getDiff(existing, {
        methodArgs: { a: true, b: [1, { x: 1, y: 2 }] },
        tags: [],
        priority: 3,
      }),
    ).toBeNull();
    expect(
      await schedules.getDiff(existing, {
        methodArgs: { a: true, b: [1, { x: 1, y: 3 }] },
      }),
    ).toEqual({ methodArgs: { a: true, b: [1, { x: 1, y: 3 }] } });
  });

  it('distinguishes null, missing keys, and empty containers', async () => {
    expect(
      await schedules.getDiff({ methodArgs: { a: null } }, { methodArgs: {} }),
    ).not.toBeNull();
    expect(
      await schedules.getDiff({ methodArgs: null }, { methodArgs: {} }),
    ).not.toBeNull();
    expect(await schedules.getDiff({ tags: [] }, { tags: {} })).not.toBeNull();
    expect(
      await schedules.getDiff({ methodArgs: null }, { methodArgs: null }),
    ).toBeNull();
  });

  it('does not treat a numeric string as equal to a number', async () => {
    expect(
      await schedules.getDiff({ priority: '3' }, { priority: 3 }),
    ).not.toBeNull();
  });
});
