/**
 * Production model for issue #4128's concurrent-build fixture: present in
 * both the production manifest and the test manifest snapshot.
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  api: { include: ['list', 'get'] },
  mcp: { include: ['list'] },
  cli: { skipApiCheck: true },
})
export class Widget extends SmrtObject {
  @field({ required: true })
  label = '';
}
