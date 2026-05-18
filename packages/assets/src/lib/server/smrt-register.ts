/**
 * Auto-generated SMRT object registration
 * DO NOT EDIT - changes will be overwritten
 *
 * Importing these modules triggers their @smrt() decorators, which perform
 * the initial registration. The explicit re-registration below is intentional:
 * it upgrades bundled runtimes to deterministic qualified registrations.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';

import { Asset } from '../../asset';
import { AssetAssociation } from '../../asset-association';
import { AssetMetafield } from '../../asset-metafield';
import { AssetStatus } from '../../asset-status';
import { AssetType } from '../../asset-type';
import { Folder } from '../../folder';
import '../../asset-metafields';
import '../../asset-statuses';
import '../../asset-types';
import '../../assets';
import '../../folders';

// Re-register imported objects with explicit package names for bundled runtimes
ObjectRegistry.register(AssetAssociation, {
  name: 'AssetAssociation',
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(AssetMetafield, {
  name: 'AssetMetafield',
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(AssetStatus, {
  name: 'AssetStatus',
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(AssetType, {
  name: 'AssetType',
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(Asset, {
  name: 'Asset',
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(Folder, {
  name: 'Folder',
  packageName: '@happyvertical/smrt-assets',
});
