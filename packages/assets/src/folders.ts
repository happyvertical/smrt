/**
 * FolderCollection - Collection manager for Folder instances
 *
 * Provides tree operations for organizing assets into hierarchical folders.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import type { Asset } from './asset';
import type { AssetCollection } from './assets';
import { Folder } from './folder';

export class FolderCollection extends SmrtCollection<Folder> {
  static readonly _itemClass = Folder;

  /**
   * Get the folder tree starting from an optional root
   *
   * @param rootId - Optional root folder ID; if omitted, returns top-level folders
   * @returns Array of folders (flat list; use parentId to reconstruct tree)
   */
  async getTree(rootId?: string): Promise<Folder[]> {
    if (!rootId) {
      // Top-level folders (no parent)
      return (await this.list({
        where: { parentId: null },
        orderBy: 'name ASC',
      })) as Folder[];
    }

    // All descendants — walk the tree breadth-first
    const result: Folder[] = [];
    const queue: string[] = [rootId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = (await this.list({
        where: { parentId: currentId },
        orderBy: 'name ASC',
      })) as Folder[];

      for (const child of children) {
        result.push(child);
        queue.push(child.id!);
      }
    }

    return result;
  }

  /**
   * Get the path from root to a given folder (ancestors)
   *
   * @param folderId - The folder ID to get the path for
   * @returns Array of folders from root to the given folder (inclusive)
   */
  async getPath(folderId: string): Promise<Folder[]> {
    const path: Folder[] = [];
    let currentId: string | null = folderId;

    while (currentId) {
      const folder = (await this.get({ id: currentId })) as Folder | null;
      if (!folder) break;
      path.unshift(folder);
      currentId = folder.parentId;
    }

    return path;
  }

  /**
   * Get all assets that are direct children of a folder
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
   * Move an asset into a folder
   *
   * @param asset - The asset to move
   * @param folderId - The target folder ID (or null to move to root)
   */
  async moveAsset(asset: Asset, folderId: string | null): Promise<void> {
    asset.folderId = folderId;
    await asset.save();
  }
}
