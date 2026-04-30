/**
 * Issue #1170: legacy STI discriminator rows should not hit generic
 * primary-key/upsert collisions when save() serializes them to qualified names.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt({
  tableStrategy: 'sti',
  tableName: 'issue_1170_places',
})
class Issue1170Place extends SmrtObject {
  @field()
  name: string = '';
}

const tableName = 'issue_1170_places';
const legacyMetaType = 'Issue1170Place';
const qualifiedMetaType = '@happyvertical/smrt-core:Issue1170Place';

describe('Issue #1170: legacy STI discriminator save handling', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['Issue1170Place'],
    });
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('updates a lone legacy discriminator row in place by id', async () => {
    await db.insert(tableName, {
      id: 'legacy-place',
      slug: 'shared-place',
      context: 'weather',
      _meta_type: legacyMetaType,
      name: 'Legacy Place',
    });

    const loaded = (await new Issue1170Place({
      db,
      id: 'legacy-place',
    }).initialize()) as Issue1170Place;
    expect((loaded as any)._meta_type).toBe(legacyMetaType);

    loaded.name = 'Migrated Place';
    await expect(loaded.save()).resolves.toBe(loaded);

    const rows = await db.list(tableName, {
      slug: 'shared-place',
      context: 'weather',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'legacy-place',
      _meta_type: qualifiedMetaType,
      name: 'Migrated Place',
    });
  });

  it('fails with an actionable STI discriminator conflict when a qualified duplicate exists', async () => {
    await db.insert(tableName, [
      {
        id: 'legacy-place',
        slug: 'shared-place',
        context: 'weather',
        _meta_type: legacyMetaType,
        name: 'Legacy Place',
      },
      {
        id: 'qualified-place',
        slug: 'shared-place',
        context: 'weather',
        _meta_type: qualifiedMetaType,
        name: 'Qualified Place',
      },
    ]);

    const loaded = (await new Issue1170Place({
      db,
      id: 'legacy-place',
    }).initialize()) as Issue1170Place;
    loaded.name = 'Edited Legacy Place';

    await expect(loaded.save()).rejects.toMatchObject({
      code: 'DB_STI_DISCRIMINATOR_CONFLICT',
      details: {
        className: 'Issue1170Place',
        tableName,
        id: 'legacy-place',
        slug: 'shared-place',
        context: 'weather',
        legacyMetaType,
        qualifiedMetaType,
        duplicateId: 'qualified-place',
      },
    });

    const rows = await db.list(tableName, {
      slug: 'shared-place',
      context: 'weather',
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row._meta_type).sort()).toEqual(
      [legacyMetaType, qualifiedMetaType].sort(),
    );
  });
});
