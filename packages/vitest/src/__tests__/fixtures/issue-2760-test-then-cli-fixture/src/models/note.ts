/** Production model for the #2760 test-then-CLI fixture. */
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  api: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class Note extends SmrtObject {
  @field({ required: true })
  body = '';
}
