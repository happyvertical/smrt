import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { field, foreignKey } from '../decorators';
import type { SmrtObjectOptions } from '../object';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt({
  tableName: 'issue_1137_hydration_parents',
  cli: false,
  mcp: false,
})
class Issue1137HydrationParent extends SmrtObject {
  @field({ required: true })
  name: string = '';

  constructor(options: SmrtObjectOptions = {}) {
    super(options);
    if (options.name) this.name = options.name;
  }
}

@smrt({
  tableName: 'issue_1137_hydration_entries',
  cli: false,
  mcp: false,
})
class Issue1137HydrationEntry extends SmrtObject {
  @field({ required: true })
  name: string = '';

  @field()
  status: string = 'draft';

  @field()
  startDate: string = '';

  @field()
  publish_date: string = '';

  @foreignKey('Issue1137HydrationParent')
  parentId?: string;

  constructor(options: SmrtObjectOptions = {}) {
    super(options);
    if (options.name) this.name = options.name;
    if (options.status) this.status = options.status;
    if (options.startDate) this.startDate = options.startDate;
    if ((options as any).publish_date)
      this.publish_date = (options as any).publish_date;
    if ((options as any).publishDate)
      this.publish_date = (options as any).publishDate;
    if (options.parentId) this.parentId = options.parentId;
  }
}

class Issue1137HydrationParents extends SmrtCollection<Issue1137HydrationParent> {
  static readonly _itemClass = Issue1137HydrationParent;
}

class Issue1137HydrationEntries extends SmrtCollection<Issue1137HydrationEntry> {
  static readonly _itemClass = Issue1137HydrationEntry;
}

function formatDateOnly(value: unknown): unknown {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

describe('Issue #1137: collection upsert semantics and lightweight hydration', () => {
  let db: DatabaseInterface;
  let parents: Issue1137HydrationParents;
  let entries: Issue1137HydrationEntries;
  let mockAi: {
    message: ReturnType<typeof vi.fn>;
    embed: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    db = await getTestDatabase({
      classes: [Issue1137HydrationParent.name, Issue1137HydrationEntry.name],
    });

    mockAi = {
      message: vi.fn().mockResolvedValue('Hydrated description'),
      embed: vi.fn().mockResolvedValue([]),
    };

    parents = await Issue1137HydrationParents.create({ db, ai: mockAi as any });
    entries = await Issue1137HydrationEntries.create({ db, ai: mockAi as any });
  });

  afterEach(async () => {
    await db?.close?.();
  });

  it('returns existing rows without writing when getOrUpsert has no changes', async () => {
    const created = await entries.create({
      slug: 'existing-entry',
      name: 'Existing Entry',
      status: 'draft',
      startDate: '2026-03-01',
    });

    const upsertSpy = vi.spyOn(db, 'upsert');
    upsertSpy.mockClear();

    const loaded = await entries.getOrUpsert({
      slug: 'existing-entry',
      name: 'Existing Entry',
      status: 'draft',
      startDate: '2026-03-01',
    });

    expect(loaded.id).toBe(created.id);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('writes exactly once when getOrUpsert creates a new row', async () => {
    const upsertSpy = vi.spyOn(db, 'upsert');

    const created = await entries.getOrUpsert({
      slug: 'created-once',
      name: 'Created Once',
      status: 'draft',
    });

    expect(created.id).toBeDefined();
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });

  it('writes exactly once when getOrUpsert updates an existing row', async () => {
    await entries.create({
      slug: 'updated-once',
      name: 'Updated Once',
      status: 'draft',
    });

    const upsertSpy = vi.spyOn(db, 'upsert');
    upsertSpy.mockClear();

    const updated = await entries.getOrUpsert({
      slug: 'updated-once',
      name: 'Updated Once',
      status: 'published',
    });

    expect(updated.status).toBe('published');
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });

  it('detects camelCase field updates before SQL formatting', async () => {
    await entries.create({
      slug: 'camel-case-entry',
      name: 'Camel Case Entry',
      startDate: '2026-03-01',
    });

    const updated = await entries.getOrUpsert({
      slug: 'camel-case-entry',
      startDate: '2026-04-15',
    });

    expect(formatDateOnly(updated.startDate)).toBe('2026-04-15');

    const persisted = await entries.get({ slug: 'camel-case-entry' });
    expect(formatDateOnly(persisted?.startDate)).toBe('2026-04-15');
  });

  it('maps camelCase input onto snake_case logical field names', async () => {
    await entries.create({
      slug: 'snake-logical-entry',
      name: 'Snake Logical Entry',
      publish_date: '2026-03-01',
    } as any);

    const updated = await entries.getOrUpsert({
      slug: 'snake-logical-entry',
      publishDate: '2026-04-15',
    } as any);

    expect(formatDateOnly(updated.publish_date)).toBe('2026-04-15');

    const persisted = await entries.get({ slug: 'snake-logical-entry' });
    expect(formatDateOnly(persisted?.publish_date)).toBe('2026-04-15');
  });

  it('keeps id lookup precedence ahead of conflicting slug data', async () => {
    const created = await entries.create({
      slug: 'id-priority-entry',
      name: 'ID Priority Entry',
      status: 'draft',
    });

    const updated = await entries.getOrUpsert({
      id: created.id,
      slug: 'different-slug',
      status: 'published',
    });

    expect(updated.id).toBe(created.id);
    expect(updated.slug).toBe(created.slug);
    expect(updated.status).toBe('published');
  });

  it('hydrates query results without runtime bootstrap but keeps ORM behavior intact', async () => {
    const parent = await parents.create({ name: 'Parent Record' });
    const created = await entries.create({
      slug: 'hydrated-entry',
      name: 'Hydrated Entry',
      parentId: parent.id,
      status: 'draft',
    });

    const loaded = await entries.get({ id: created.id });
    expect(loaded).toBeDefined();
    expect(loaded?.signalBus).toBeUndefined();

    loaded!.status = 'published';
    await loaded?.save();

    const relatedParent = await loaded?.getRelated('parentId');
    expect(relatedParent?.id).toBe(parent.id);

    const described = await loaded?.describe();
    expect(described).toBe('Hydrated description');
    expect(mockAi.message).toHaveBeenCalledTimes(1);
    expect(loaded?.signalBus).toBeDefined();

    await loaded?.delete();
    expect(await entries.get({ id: created.id })).toBeNull();
  });
});
