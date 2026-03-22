/**
 * Auto-generated SMRT object registration
 * DO NOT EDIT - changes will be overwritten
 *
 * Importing these modules triggers their @smrt() decorators, which performs
 * the initial registration. The explicit re-registration below is intentional:
 * it upgrades bundled runtimes to deterministic qualified registrations.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';

import { AssetAssociation } from '../../asset-association';
import '../../asset-associations';
import { AssetMetafield } from '../../asset-metafield';
import '../../asset-metafields';
import { AssetStatus } from '../../asset-status';
import '../../asset-statuses';
import { AssetType } from '../../asset-type';
import '../../asset-types';
import { Asset } from '../../asset';
import '../../assets';
import { Folder } from '../../folder';
import '../../folders';

// Re-register imported objects with explicit package names for bundled runtimes
ObjectRegistry.register(AssetAssociation, {
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(AssetMetafield, {
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(AssetStatus, {
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(AssetType, {
  packageName: '@happyvertical/smrt-assets',
});
ObjectRegistry.register(Asset, { packageName: '@happyvertical/smrt-assets' });
ObjectRegistry.register(Folder, { packageName: '@happyvertical/smrt-assets' });
