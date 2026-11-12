/**
 * Fixture model for #4922: a concrete own-table subclass of a class that
 * extends a FRAMEWORK BASE. Its table carries `TreeNode`'s fields, and the
 * inherited `parentId` must stay bound to this class's own table. Like
 * `TreeNode`, it reaches `ObjectRegistry` only through manifest registration.
 */

import { field, smrt } from '@happyvertical/smrt-core';
import { TreeNode } from './tree-node.js';

@smrt({
  api: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class Branch extends TreeNode {
  @field({ required: false })
  depth = 0;
}
