/**
 * Folder model - Asset subclass for organizing assets into hierarchies
 *
 * Folders are Assets with typeSlug='folder'. Uses existing parentId
 * for tree structure. Stored via STI in the assets table.
 */

import { smrt } from '@happyvertical/smrt-core';
import { Asset } from './asset';
import type { FolderOptions } from './types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
})
export class Folder extends Asset {
  constructor(options: FolderOptions = {}) {
    super({ typeSlug: 'folder', ...options });
  }
}
