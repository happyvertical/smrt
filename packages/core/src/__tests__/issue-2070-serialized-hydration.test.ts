import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';

let activeInitializers = 0;
let maximumActiveInitializers = 0;
let initializationOrder: number[] = [];

@smrt({ tableName: 'issue_2070_hydration_probes' })
class Issue2070HydrationProbe extends SmrtObject {
  @field()
  position: number = 0;

  override async initialize(): Promise<this> {
    await super.initialize();
    if (!this.isPersisted || !this.id) return this;

    activeInitializers += 1;
    maximumActiveInitializers = Math.max(
      maximumActiveInitializers,
      activeInitializers,
    );
    initializationOrder.push(this.position);

    try {
      // Keep the initialization query in flight long enough for parallel row
      // hydration to overlap deterministically on the same database adapter.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await this.db.get(this.tableName, { id: this.id });
    } finally {
      activeInitializers -= 1;
    }

    return this;
  }
}

class Issue2070HydrationProbeCollection extends SmrtCollection<Issue2070HydrationProbe> {
  static readonly _itemClass = Issue2070HydrationProbe;
}

function resetInitializationEvidence(): void {
  activeInitializers = 0;
  maximumActiveInitializers = 0;
  initializationOrder = [];
}

describe('Issue #2070: collection hydration serializes model initialization', () => {
  let db: DatabaseInterface;
  let probes: Issue2070HydrationProbeCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ classes: ['Issue2070HydrationProbe'] });
    probes = await Issue2070HydrationProbeCollection.create({ db });

    for (const position of [1, 2, 3]) {
      await probes.create({ position });
    }

    resetInitializationEvidence();
  });

  afterEach(async () => {
    await db?.close?.();
  });

  it('serializes list() hydration and preserves selected row order', async () => {
    const rows = await probes.list({ orderBy: 'position ASC' });

    expect(rows.map((row) => row.position)).toEqual([1, 2, 3]);
    expect(initializationOrder).toEqual([1, 2, 3]);
    expect(maximumActiveInitializers).toBe(1);
  });

  it('serializes query() hydration and preserves selected row order', async () => {
    const rows = await probes.query(
      `SELECT * FROM ${probes.tableName} ORDER BY position DESC`,
    );

    expect(rows.map((row) => row.position)).toEqual([3, 2, 1]);
    expect(initializationOrder).toEqual([3, 2, 1]);
    expect(maximumActiveInitializers).toBe(1);
  });
});
