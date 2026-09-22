/**
 * Fixture model for issue #2970.
 *
 * A consumer's own `@smrt()` class that extends a FRAMEWORK BASE declared by
 * `@happyvertical/smrt-core` — the shape that made the false ambiguity
 * reachable downstream. Deliberately not imported by the probe spec: it must
 * reach `ObjectRegistry` only through manifest registration.
 */

import { field, SmrtHierarchical, smrt } from '@happyvertical/smrt-core';

@smrt({
  api: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class TreeNode extends SmrtHierarchical {
  @field({ required: false })
  label = '';
}
