/**
 * AssetAssociationCollection - Collection manager for AssetAssociation instances
 *
 * Provides methods for linking/unlinking assets to arbitrary SmrtObjects
 * with role-based categorization and ordering.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { AssetAssociation } from './asset-association';

export class AssetAssociationCollection extends SmrtCollection<AssetAssociation> {
  static readonly _itemClass = AssetAssociation;

  /**
   * Get all associations for a given object
   *
   * @param metaType - Target class name (e.g., 'Article')
   * @param metaId - Target object ID
   * @returns Associations ordered by sortOrder
   */
  async getForObject(
    metaType: string,
    metaId: string,
  ): Promise<AssetAssociation[]> {
    return (await this.list({
      where: { metaType, metaId },
      orderBy: 'sort_order ASC',
    })) as AssetAssociation[];
  }

  /**
   * Get associations for an object filtered by role
   *
   * @param metaType - Target class name
   * @param metaId - Target object ID
   * @param role - Association role (e.g., 'hero', 'thumbnail')
   * @returns Matching associations ordered by sortOrder
   */
  async getForObjectByRole(
    metaType: string,
    metaId: string,
    role: string,
  ): Promise<AssetAssociation[]> {
    return (await this.list({
      where: { metaType, metaId, role },
      orderBy: 'sort_order ASC',
    })) as AssetAssociation[];
  }

  /**
   * Get all associations for a given asset
   *
   * @param assetId - The asset ID
   * @returns All associations linking this asset to other objects
   */
  async getForAsset(assetId: string): Promise<AssetAssociation[]> {
    return (await this.list({
      where: { assetId },
    })) as AssetAssociation[];
  }

  /**
   * Create an association between an asset and an object
   *
   * @param assetId - The asset ID
   * @param metaType - Target class name
   * @param metaId - Target object ID
   * @param role - Association role (default: 'default')
   * @param sortOrder - Sort order (default: 0)
   * @returns The created AssetAssociation
   */
  async associate(
    assetId: string,
    metaType: string,
    metaId: string,
    role = 'default',
    sortOrder = 0,
  ): Promise<AssetAssociation> {
    return (await this.create({
      assetId,
      metaType,
      metaId,
      role,
      sortOrder,
    })) as AssetAssociation;
  }

  /**
   * Remove association(s) between an asset and an object
   *
   * @param assetId - The asset ID
   * @param metaType - Target class name
   * @param metaId - Target object ID
   * @param role - Optional role filter; if omitted, removes all roles
   */
  async dissociate(
    assetId: string,
    metaType: string,
    metaId: string,
    role?: string,
  ): Promise<void> {
    const where: Record<string, string> = { assetId, metaType, metaId };
    if (role) where.role = role;

    const associations = (await this.list({ where })) as AssetAssociation[];
    for (const assoc of associations) {
      await assoc.delete();
    }
  }
}
