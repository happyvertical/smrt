/**
 * Fixture model for issue #2750's registry-sharing regression test.
 *
 * Deliberately never imported by `registry-probe.spec.ts` — the spec must
 * only ever see this class through manifest-based registration (the
 * consumer-shaped path that reproduced #2750), not through decorator
 * side effects triggered by a direct import.
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class Widget extends SmrtObject {
  @field({ required: true })
  label = '';
}
