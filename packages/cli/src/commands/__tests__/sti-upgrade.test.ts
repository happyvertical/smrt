import { ObjectRegistry, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveStiDiscriminatorUpgrade } from '../sti-upgrade.js';

@smrt({ tableStrategy: 'sti', tableName: 'sti_upgrade_assets' })
class StiUpgradeAsset extends SmrtObject {}

@smrt()
class StiUpgradeImage extends StiUpgradeAsset {}

describe('resolveStiDiscriminatorUpgrade', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
    ObjectRegistry.register(StiUpgradeAsset, {
      packageName: '@happyvertical/smrt-assets',
    });
    ObjectRegistry.register(StiUpgradeImage, {
      packageName: '@happyvertical/smrt-images',
    });
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
});
