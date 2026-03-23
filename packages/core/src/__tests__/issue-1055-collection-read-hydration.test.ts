import type { DatabaseInterface } from '@happyvertical/sql';
import { syncSchema } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import type { SmrtObjectOptions } from '../object';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

const ISSUE_1055_LINKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS issue_1055_read_hydration_links (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT 'attachment',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS issue_1055_read_hydration_links_slug_context_idx
  ON issue_1055_read_hydration_links (slug, context);
`;

interface Issue1055ReadHydrationLinkOptions extends SmrtObjectOptions {
  parentId?: string;
  childId?: string;
  relationship?: string;
  sortOrder?: number;
}

@smrt({
  tableName: 'issue_1055_read_hydration_links',
  conflictColumns: ['parent_id', 'child_id', 'relationship'],
  api: { include: ['list', 'get'] },
  cli: false,
  mcp: false,
})
class Issue1055ReadHydrationLink extends SmrtObject {
  parentId = '';
  childId = '';
  relationship = 'attachment';
  sortOrder = 0;

  constructor(options: Issue1055ReadHydrationLinkOptions = {}) {
    super(options);
    if (options.parentId) this.parentId = options.parentId;
    if (options.childId) this.childId = options.childId;
    if (options.relationship) this.relationship = options.relationship;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
  }
}

class Issue1055ReadHydrationLinks extends SmrtCollection<Issue1055ReadHydrationLink> {
  static readonly _itemClass = Issue1055ReadHydrationLink;
}

describe('Issue #1055: collection reads should hydrate without saving', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ classes: [] });
    await syncSchema({ db, schema: ISSUE_1055_LINKS_SCHEMA });
  });

  afterEach(async () => {
    await db?.close?.();
  });

  it('list() and get() should not re-upsert existing rows during hydration', async () => {
    await db.insert('issue_1055_read_hydration_links', {
      id: 'link-1',
      slug: 'link-1',
      context: '',
      created_at: new Date(),
      updated_at: new Date(),
      parent_id: 'parent-1',
      child_id: 'child-1',
      relationship: 'thumbnail',
      sort_order: 3,
    });

    const links = await Issue1055ReadHydrationLinks.create({ db });

    const listed = await links.list({ where: { parentId: 'parent-1' } });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.childId).toBe('child-1');
    expect(listed[0]?.relationship).toBe('thumbnail');
    expect(listed[0]?.sortOrder).toBe(3);

    const loaded = await links.get({ id: 'link-1' });
    expect(loaded?.parentId).toBe('parent-1');
    expect(loaded?.childId).toBe('child-1');

    const rows = await db.list('issue_1055_read_hydration_links', {});
    expect(rows).toHaveLength(1);
  });
});
