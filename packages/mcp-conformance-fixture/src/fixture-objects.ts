import { SmrtCollection, SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({ api: false, cli: false, mcp: { include: ['list', 'get'] } })
export class ConformanceWidget extends SmrtObject {
  name = '';
  description = '';
  count = 0;
}

export class ConformanceWidgetCollection extends SmrtCollection<ConformanceWidget> {
  static readonly _itemClass = ConformanceWidget;
}

@smrt({ api: false, cli: false, mcp: { include: ['list', 'get', 'create'] } })
export class ConformanceGadget extends SmrtObject {
  name = '';
  label = '';
  price = 0.0;
}

export class ConformanceGadgetCollection extends SmrtCollection<ConformanceGadget> {
  static readonly _itemClass = ConformanceGadget;
}
