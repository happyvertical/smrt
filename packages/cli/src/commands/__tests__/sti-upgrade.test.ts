import { ObjectRegistry, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { type DatabaseProvider, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  repairStiDiscriminatorRows,
  resolveStiDiscriminatorUpgrade,
} from '../sti-upgrade.js';

@smrt({ tableStrategy: 'sti', tableName: 'sti_upgrade_assets' })
class StiUpgradeAsset extends SmrtObject {}

@smrt()
class StiUpgradeImage extends StiUpgradeAsset {}

@smrt({
  tableStrategy: 'sti',
  tableName: 'sti_upgrade_customs',
  conflictColumns: ['external_key', '_meta_type'],
})
class StiUpgradeCustomIdentity extends SmrtObject {
  externalKey: string = '';
}

describe('resolveStiDiscriminatorUpgrade', () => {
  let db: DatabaseProvider | undefined;

  beforeEach(() => {
    ObjectRegistry.clear();
    ObjectRegistry.register(StiUpgradeAsset, {
      packageName: '@happyvertical/smrt-assets',
    });
    ObjectRegistry.register(StiUpgradeImage, {
      packageName: '@happyvertical/smrt-images',
    });
    ObjectRegistry.register(StiUpgradeCustomIdentity, {
      packageName: '@happyvertical/smrt-cli',
      tableStrategy: 'sti',
      tableName: 'sti_upgrade_customs',
      conflictColumns: ['external_key', '_meta_type'],
    });
  });

  afterEach(async () => {
    await db?.close?.();
    db = undefined;
  });

  it('skips discriminators that are already current', () => {
    expect(
      resolveStiDiscriminatorUpgrade(
        '@happyvertical/smrt-images:StiUpgradeImage',
      ),
    ).toEqual({
      action: 'skip',
      reason: 'already-current',
    });
  });

  it('upgrades simple discriminators to the current qualified name', () => {
    expect(resolveStiDiscriminatorUpgrade('StiUpgradeImage')).toEqual({
      action: 'upgrade',
      className: 'StiUpgradeImage',
      currentQualifiedName: '@happyvertical/smrt-images:StiUpgradeImage',
      sourceKind: 'simple',
    });
  });

  it('upgrades stale qualified discriminators to the current package', () => {
    expect(
      resolveStiDiscriminatorUpgrade(
        '@happyvertical/smrt-assets:StiUpgradeImage',
      ),
    ).toEqual({
      action: 'upgrade',
      className: 'StiUpgradeImage',
      currentQualifiedName: '@happyvertical/smrt-images:StiUpgradeImage',
      sourceKind: 'stale-qualified',
    });
  });

  it('skips unregistered discriminators', () => {
    expect(
      resolveStiDiscriminatorUpgrade('@happyvertical/other:NotRegistered'),
    ).toEqual({
      action: 'skip',
      reason: 'unregistered',
    });
  });

  it('skips ambiguous simple discriminators when multiple classes share the name', () => {
    const findClassesByName = vi
      .spyOn(ObjectRegistry, 'findClassesByName')
      .mockReturnValue([
        {
          name: 'StiUpgradeDuplicate',
          qualifiedName: '@happyvertical/smrt-assets:StiUpgradeDuplicate',
        },
        {
          name: 'StiUpgradeDuplicate',
          qualifiedName: '@happyvertical/smrt-images:StiUpgradeDuplicate',
        },
      ] as ReturnType<typeof ObjectRegistry.findClassesByName>);

    expect(resolveStiDiscriminatorUpgrade('StiUpgradeDuplicate')).toEqual({
      action: 'skip',
      reason: 'ambiguous',
    });

    findClassesByName.mockRestore();
  });

  it('skips classes that are registered without a qualified package name', () => {
    const findClassesByName = vi
      .spyOn(ObjectRegistry, 'findClassesByName')
      .mockReturnValue([
        {
          name: 'UnqualifiedStiUpgrade',
          qualifiedName: undefined,
        },
      ] as ReturnType<typeof ObjectRegistry.findClassesByName>);

    expect(resolveStiDiscriminatorUpgrade('UnqualifiedStiUpgrade')).toEqual({
      action: 'skip',
      reason: 'unqualified',
    });

    findClassesByName.mockRestore();
  });

  it('repairs lone legacy discriminator rows by id', async () => {
    db = await getDatabase({
      type: 'sqlite',
      url: ':memory:',
      __smrtSkipVitestSchemaPreparation: true,
    });
    await db.query(`
      CREATE TABLE sti_upgrade_assets (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        _meta_type TEXT NOT NULL
      )
    `);
    await db.query(
      'CREATE UNIQUE INDEX sti_upgrade_assets_identity_idx ON sti_upgrade_assets(slug, context, _meta_type)',
    );
    await db.query(`
      INSERT INTO sti_upgrade_assets (id, slug, context, _meta_type)
      VALUES ('legacy-1', 'same-place', '', 'StiUpgradeImage')
    `);

    const result = await repairStiDiscriminatorRows({
      db,
      tableName: 'sti_upgrade_assets',
      className: 'StiUpgradeImage',
      legacyMetaType: 'StiUpgradeImage',
      qualifiedMetaType: '@happyvertical/smrt-images:StiUpgradeImage',
    });

    expect(result).toMatchObject({
      checkedRows: 1,
      updatedRows: 1,
      wouldUpdateRows: 0,
      conflicts: [],
    });
    const rows = (
      await db.query('SELECT id, _meta_type FROM sti_upgrade_assets')
    ).rows;
    expect(rows).toEqual([
      {
        id: 'legacy-1',
        _meta_type: '@happyvertical/smrt-images:StiUpgradeImage',
      },
    ]);
  });

  it('reports qualified duplicates instead of violating the STI unique index', async () => {
    db = await getDatabase({
      type: 'sqlite',
      url: ':memory:',
      __smrtSkipVitestSchemaPreparation: true,
    });
    await db.query(`
      CREATE TABLE sti_upgrade_assets (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        _meta_type TEXT NOT NULL
      )
    `);
    await db.query(
      'CREATE UNIQUE INDEX sti_upgrade_assets_identity_idx ON sti_upgrade_assets(slug, context, _meta_type)',
    );
    await db.query(`
      INSERT INTO sti_upgrade_assets (id, slug, context, _meta_type)
      VALUES ('legacy-1', 'same-place', '', 'StiUpgradeImage')
    `);
    await db.query(`
      INSERT INTO sti_upgrade_assets (id, slug, context, _meta_type)
      VALUES ('qualified-1', 'same-place', '', '@happyvertical/smrt-images:StiUpgradeImage')
    `);

    const result = await repairStiDiscriminatorRows({
      db,
      tableName: 'sti_upgrade_assets',
      className: 'StiUpgradeImage',
      legacyMetaType: 'StiUpgradeImage',
      qualifiedMetaType: '@happyvertical/smrt-images:StiUpgradeImage',
    });

    expect(result.updatedRows).toBe(0);
    expect(result.conflicts).toEqual([
      {
        tableName: 'sti_upgrade_assets',
        legacyMetaType: 'StiUpgradeImage',
        qualifiedMetaType: '@happyvertical/smrt-images:StiUpgradeImage',
        legacyId: 'legacy-1',
        qualifiedId: 'qualified-1',
        conflictIdentity: {
          slug: 'same-place',
          context: '',
        },
      },
    ]);
    const rows = (
      await db.query(
        'SELECT id, _meta_type FROM sti_upgrade_assets ORDER BY id',
      )
    ).rows;
    expect(rows.map((row: any) => row._meta_type)).toEqual([
      'StiUpgradeImage',
      '@happyvertical/smrt-images:StiUpgradeImage',
    ]);
  });

  it('uses custom STI conflict columns when finding qualified duplicates', async () => {
    db = await getDatabase({
      type: 'sqlite',
      url: ':memory:',
      __smrtSkipVitestSchemaPreparation: true,
    });
    await db.query(`
      CREATE TABLE sti_upgrade_customs (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        external_key TEXT NOT NULL,
        _meta_type TEXT NOT NULL
      )
    `);
    await db.query(
      'CREATE UNIQUE INDEX sti_upgrade_customs_identity_idx ON sti_upgrade_customs(external_key, _meta_type)',
    );
    await db.query(`
      INSERT INTO sti_upgrade_customs (id, slug, context, external_key, _meta_type)
      VALUES ('legacy-1', 'legacy-slug', '', 'shared-key', 'StiUpgradeCustomIdentity')
    `);
    await db.query(`
      INSERT INTO sti_upgrade_customs (id, slug, context, external_key, _meta_type)
      VALUES ('qualified-1', 'different-slug', '', 'shared-key', '@happyvertical/smrt-cli:StiUpgradeCustomIdentity')
    `);

    const result = await repairStiDiscriminatorRows({
      db,
      tableName: 'sti_upgrade_customs',
      className: 'StiUpgradeCustomIdentity',
      legacyMetaType: 'StiUpgradeCustomIdentity',
      qualifiedMetaType: '@happyvertical/smrt-cli:StiUpgradeCustomIdentity',
    });

    expect(result.updatedRows).toBe(0);
    expect(result.conflicts).toEqual([
      {
        tableName: 'sti_upgrade_customs',
        legacyMetaType: 'StiUpgradeCustomIdentity',
        qualifiedMetaType: '@happyvertical/smrt-cli:StiUpgradeCustomIdentity',
        legacyId: 'legacy-1',
        qualifiedId: 'qualified-1',
        conflictIdentity: {
          external_key: 'shared-key',
        },
      },
    ]);
  });
});
