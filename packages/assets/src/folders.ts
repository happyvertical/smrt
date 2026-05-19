/**
 * FolderCollection — collection manager for Folder instances.
 *
 * Provides tree-oriented helpers that wrap the inherited SmrtHierarchical
 * traversal methods, plus folder-content helpers (`getContents`,
 * `moveAsset`) for working with the assets in a folder.
 *
 * Post R3-D, Folder lives on its own `folders` table; tree queries no
 * longer have to filter by `type_slug='folder'`.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import type { Asset } from './asset';
import type { AssetCollection } from './assets';
import { Folder } from './folder';

export class FolderCollection extends SmrtCollection<Folder> {
  static readonly _itemClass = Folder;

  /**
   * Get the folder tree starting from an optional root.
   *
   * When `rootId` is omitted, returns top-level folders (those with no
   * parent). When `rootId` is provided, returns all descendants of that
   * folder via the inherited SmrtHierarchical BFS traversal — same
   * cycle-safe, one-query-per-depth behaviour as Place/Event.
   *
   * @param rootId - Optional root folder ID; if omitted, returns top-level folders
   * @returns Array of folders (flat list; use parentId to reconstruct tree)
   */
  async getTree(rootId?: string): Promise<Folder[]> {
    if (!rootId) {
      return (await this.list({
        where: { parentId: null },
        orderBy: 'name ASC',
      })) as Folder[];
    }

    const root = (await this.get({ id: rootId })) as Folder | null;
    if (!root) return [];
    return await root.getDescendants();
  }

  /**
   * Get the path from root to a given folder (ancestors + self).
   *
   * @param folderId - The folder ID to get the path for
   * @returns Array of folders from root to the given folder (inclusive)
   */
  async getPath(folderId: string): Promise<Folder[]> {
    const folder = (await this.get({ id: folderId })) as Folder | null;
    if (!folder) return [];
    const ancestors = await folder.getAncestors();
    return [...ancestors, folder];
  }

  /**
   * Get all assets that are direct children of a folder.
   *
   * Folder membership is recorded on `Asset.folderId`, not on the folder
   * itself, so this is delegated to the asset collection.
   *
   * @param folderId - The folder ID
   * @param assetCollection - An AssetCollection instance for querying
   * @returns Array of assets in this folder
   */
  async getContents(
    folderId: string,
    assetCollection: AssetCollection,
  ): Promise<Asset[]> {
    return (await assetCollection.list({
      where: { folderId },
    })) as Asset[];
  }

  /**
   * Move an asset into a folder (or out, by passing `null`).
   *
   * @param asset - The asset to move
   * @param folderId - The target folder ID (or null to move to root)
   */
  async moveAsset(asset: Asset, folderId: string | null): Promise<void> {
    asset.folderId = folderId;
    await asset.save();
  }
}
