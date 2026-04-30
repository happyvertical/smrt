/**
 * Issue #1170: legacy STI discriminator rows should not hit generic
 * primary-key/upsert collisions when save() serializes them to qualified names.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt({
  tableStrategy: 'sti',
  tableName: 'issue_1170_places',
})
class Issue1170Place extends SmrtObject {
  @field()
  name: string = '';
}

@smrt({
  tableStrategy: 'sti',
  tableName: 'issue_1170_external_places',
})
class Issue1170ExternalPlace extends SmrtObject {
  @field()
  name: string = '';
}

@smrt({
  tableStrategy: 'sti',
  tableName: 'issue_1170_custom_places',
  conflictColumns: ['external_key', '_meta_type'],
})
class Issue1170CustomIdentityPlace extends SmrtObject {
  @field()
  externalKey: string = '';

  @field()
  name: string = '';
}

const tableName = 'issue_1170_places';
const externalTableName = 'issue_1170_external_places';
const customTableName = 'issue_1170_custom_places';
const legacyMetaType = 'Issue1170Place';
const qualifiedMetaType = '@happyvertical/smrt-core:Issue1170Place';
const externalLegacyMetaType = 'Issue1170ExternalPlace';
const externalQualifiedMetaType =
  '@happyvertical/smrt-places:Issue1170ExternalPlace';
const customLegacyMetaType = 'Issue1170CustomIdentityPlace';
const customQualifiedMetaType =
  '@happyvertical/smrt-core:Issue1170CustomIdentityPlace';

const externalPlaceClass = ObjectRegistry.findClass('Issue1170ExternalPlace');
const originalExternalPackageName = externalPlaceClass?.packageName;
const originalExternalQualifiedName = externalPlaceClass?.qualifiedName;

describe('Issue #1170: legacy STI discriminator save handling', () => {
  let db: DatabaseInterface;

  beforeAll(() => {
    if (!externalPlaceClass) {
      throw new Error('Issue1170ExternalPlace was not registered');
    }
    externalPlaceClass.packageName = '@happyvertical/smrt-places';
    externalPlaceClass.qualifiedName = externalQualifiedMetaType;
  });

  afterAll(() => {
    if (externalPlaceClass) {
      externalPlaceClass.packageName = originalExternalPackageName;
      externalPlaceClass.qualifiedName = originalExternalQualifiedName;
    }
  });

  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        'Issue1170Place',
        'Issue1170ExternalPlace',
        'Issue1170CustomIdentityPlace',
      ],
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
    expect((loaded as any)._meta_type).toBe(qualifiedMetaType);

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
        conflictIdentity: {
          slug: 'shared-place',
          context: 'weather',
        },
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

  it('uses the registered package namespace when upgrading a legacy discriminator', async () => {
    await db.insert(externalTableName, {
      id: 'external-legacy-place',
      slug: 'external-place',
      context: 'weather',
      _meta_type: externalLegacyMetaType,
      name: 'Legacy External Place',
    });

    const loaded = (await new Issue1170ExternalPlace({
      db,
      id: 'external-legacy-place',
    }).initialize()) as Issue1170ExternalPlace;
    expect((loaded as any)._meta_type).toBe(externalLegacyMetaType);
    expect(loaded.toJSON()._meta_type).toBe(externalQualifiedMetaType);

    loaded.name = 'Migrated External Place';
    await expect(loaded.save()).resolves.toBe(loaded);
    expect((loaded as any)._meta_type).toBe(externalQualifiedMetaType);

    const rows = await db.list(externalTableName, {
      slug: 'external-place',
      context: 'weather',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'external-legacy-place',
      _meta_type: externalQualifiedMetaType,
      name: 'Migrated External Place',
    });
  });

  it('uses custom STI conflict columns when checking for qualified duplicates', async () => {
    await db.insert(customTableName, [
      {
        id: 'custom-legacy-place',
        slug: 'legacy-slug',
        context: 'weather',
        external_key: 'same-logical-place',
        _meta_type: customLegacyMetaType,
        name: 'Legacy Custom Place',
      },
      {
        id: 'custom-qualified-place',
        slug: 'qualified-slug',
        context: 'weather',
        external_key: 'same-logical-place',
        _meta_type: customQualifiedMetaType,
        name: 'Qualified Custom Place',
      },
    ]);

    const loaded = (await new Issue1170CustomIdentityPlace({
      db,
      id: 'custom-legacy-place',
    }).initialize()) as Issue1170CustomIdentityPlace;
    loaded.name = 'Edited Legacy Custom Place';

    await expect(loaded.save()).rejects.toMatchObject({
      code: 'DB_STI_DISCRIMINATOR_CONFLICT',
      details: {
        className: 'Issue1170CustomIdentityPlace',
        tableName: customTableName,
        id: 'custom-legacy-place',
        slug: 'legacy-slug',
        context: 'weather',
        conflictIdentity: {
          external_key: 'same-logical-place',
        },
        legacyMetaType: customLegacyMetaType,
        qualifiedMetaType: customQualifiedMetaType,
        duplicateId: 'custom-qualified-place',
      },
    });
  });
});
