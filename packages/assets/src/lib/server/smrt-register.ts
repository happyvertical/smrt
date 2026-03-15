/**
 * Auto-generated SMRT object registration
 * DO NOT EDIT - changes will be overwritten
 *
 * Importing these modules triggers their @smrt() decorators, which performs
 * the initial registration. The explicit re-registration below is intentional:
 * it upgrades bundled runtimes to deterministic qualified registrations.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import { Asset } from '../../asset';
import { AssetAssociation } from '../../asset-association';
import { AssetAssociationCollection } from '../../asset-associations';
import { AssetMetafield } from '../../asset-metafield';
import { AssetMetafieldCollection } from '../../asset-metafields';
import { AssetStatus } from '../../asset-status';
import { AssetStatusCollection } from '../../asset-statuses';
import { AssetType } from '../../asset-type';
import { AssetTypeCollection } from '../../asset-types';
import { AssetCollection } from '../../assets';
import { Folder } from '../../folder';
import { FolderCollection } from '../../folders';

// Re-register imported objects with explicit package names for bundled runtimes
ObjectRegistry.register(AssetAssociation, {
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(AssetAssociationCollection, {
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(AssetMetafield, {
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(AssetMetafieldCollection, {
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(AssetStatus, {
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(AssetStatusCollection, {
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(AssetType, {
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(AssetTypeCollection, {
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(Asset, { packageName: '@happyvertical/smrt-assets' });
ObjectRegistry.register(AssetCollection, {
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(Folder, { packageName: '@happyvertical/smrt-assets' });
ObjectRegistry.register(FolderCollection, {
  packageName: '@happyvertical/smrt-assets',
});
