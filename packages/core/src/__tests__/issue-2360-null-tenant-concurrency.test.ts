/**
 * Issue #2360 — concurrent NULL-tenant creates on file-backed SQLite.
 *
 * With the tenant-led conflict target, every NULL-tenant (global) create of a
 * tenant-scoped class routes through the SDK's null-aware upsert, which on a
 * file-backed SQLite database runs each attempt in a write transaction on a
 * SECOND connection. The change-feed append that follows every save writes
 * through the root connection; with libsql's zero busy-timeout the two sides
 * livelocked into `SQLITE_BUSY` under a `Promise.all` of creates (surfaced by
 * smrt-facts' `getEntityBriefing` suite in CI). The embedded write queue
 * (`src/embedded-write-queue.ts`) serializes exactly those two writers per
 * database; this test is the regression probe — it fails with SQLITE_BUSY in
 * seconds without the queue.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';

@smrt({
  tableName: 'issue_2360_conc_widgets',
  tenantScoped: { mode: 'optional' },
})
class Issue2360ConcWidget extends SmrtObject {
  @field({ type: 'text', required: true })
  name: string = '';

  @field({ required: false, nullable: true })
  tenantId: string | null = null;

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.name === 'string') this.name = options.name;
    if (options.tenantId !== undefined) {
      this.tenantId = options.tenantId as string | null;
    }
  }
}

class Issue2360ConcWidgetCollection extends SmrtCollection<Issue2360ConcWidget> {
  static readonly _itemClass = Issue2360ConcWidget;
}

describe('concurrent NULL-tenant creates on file-backed SQLite (#2360)', () => {
  let dir: string;
  let db: Awaited<ReturnType<typeof getDatabase>>;

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'Issue2360ConcWidget',
      Issue2360ConcWidgetCollection,
    );
    dir = mkdtempSync(join(tmpdir(), 'issue-2360-conc-'));
    const url = join(dir, 'conc.db');
    // Create the schema through the registry path on a FILE database — the
    // in-memory adapter never opens a second connection, so only a file DB
    // reproduces the contention.
    const setup = await getTestDatabase({
      type: 'sqlite',
      url,
      classes: ['Issue2360ConcWidget'],
    });
    await setup.close?.();
    db = await getDatabase({ type: 'sqlite', url });
  });

  afterAll(async () => {
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates 15 distinct global rows concurrently without SQLITE_BUSY', async () => {
    const widgets = await Issue2360ConcWidgetCollection.create({ db });
    const rows = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        widgets.create({ name: `Widget ${i + 1}` }),
      ),
    );
    expect(rows).toHaveLength(15);
    expect(await db.list('issue_2360_conc_widgets', {})).toHaveLength(15);
  }, 60_000);

  it('mixes concurrent global and tenant creates without livelock', async () => {
    const widgets = await Issue2360ConcWidgetCollection.create({ db });
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) =>
        widgets.create({ name: `Global ${i + 1}` }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        widgets.create({ name: `Scoped ${i + 1}`, tenantId: TENANT_A }),
      ),
    ]);
    const all = (await db.list('issue_2360_conc_widgets', {})) as Array<
      Record<string, unknown>
    >;
    expect(all.filter((row) => row.tenant_id === TENANT_A)).toHaveLength(5);
  }, 60_000);
});
