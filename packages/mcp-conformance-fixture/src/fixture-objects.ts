/**
 * Fixture `@smrt()` objects for the generated-template conformance run.
 *
 * Two plain objects (no tenancy, no cross-package refs) so the generated
 * Tier-1 server exercises the default template path: static TOOLS baked at
 * generation time, stdio transport, no tenant gate imports. Explicit
 * `api`/`mcp`/`cli` config — an omitted config means full CRUD (#1400).
 */
import { SmrtCollection, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  api: false,
  cli: false,
  mcp: { include: ['list', 'get'] },
})
export class ConformanceWidget extends SmrtObject {
  name = '';
  description = '';
  count = 0;
}

export class ConformanceWidgetCollection extends SmrtCollection<ConformanceWidget> {
  static readonly _itemClass = ConformanceWidget;
}

@smrt({
  api: false,
  cli: false,
  mcp: { include: ['list', 'get', 'create'] },
})
export class ConformanceGadget extends SmrtObject {
  name = '';
  label = '';
  price = 0.0;
}

export class ConformanceGadgetCollection extends SmrtCollection<ConformanceGadget> {
  static readonly _itemClass = ConformanceGadget;
}
