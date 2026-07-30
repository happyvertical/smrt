/**
 * Registered `@smrt()` fixture objects for the conformance composition spec.
 * Explicit `api`/`mcp`/`cli` config — an omitted config means full CRUD
 * (#1400). Kept in their own module so the decorator side effects run once
 * per test process.
 */
import { SmrtCollection, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  api: false,
  cli: false,
  mcp: { include: ['list', 'get'] },
})
export class AppMcpConformanceItem extends SmrtObject {
  name = '';
  summary = '';
  quantity = 0;
}

export class AppMcpConformanceItemCollection extends SmrtCollection<AppMcpConformanceItem> {
  static readonly _itemClass = AppMcpConformanceItem;
}

@smrt({
  api: false,
  cli: false,
  mcp: { include: ['list', 'get', 'create'] },
})
export class AppMcpConformanceOrder extends SmrtObject {
  name = '';
  status = '';
  total = 0.0;
}

export class AppMcpConformanceOrderCollection extends SmrtCollection<AppMcpConformanceOrder> {
  static readonly _itemClass = AppMcpConformanceOrder;
}
