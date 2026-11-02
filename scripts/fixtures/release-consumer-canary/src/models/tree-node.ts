import { field, SmrtHierarchical, smrt } from '@happyvertical/smrt-core';

/** The app's own model, extending a framework base declared by smrt-core. */
@smrt({ api: { include: ['list', 'get'] }, cli: { skipApiCheck: true } })
export class TreeNode extends SmrtHierarchical {
  @field({ required: false })
  label = '';
}
