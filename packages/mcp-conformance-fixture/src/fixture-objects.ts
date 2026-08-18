import { SmrtCollection, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { backgroundEligible } from '@happyvertical/smrt-jobs';

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
  /**
   * Price in **integer minor units** (cents), matching the framework money rule
   * (#2401). The initializer literal is what picks the column type — `= 0.0`
   * would compile this to a floating-point column and put the fixture at odds
   * with the convention the conformance surface is meant to demonstrate.
   */
  price = 0;
}

export class ConformanceGadgetCollection extends SmrtCollection<ConformanceGadget> {
  static readonly _itemClass = ConformanceGadget;
}

@smrt({
  tableStrategy: 'sti',
  api: false,
  cli: false,
  mcp: { include: ['create', 'get'] },
})
export class ConformanceAnimal extends SmrtObject {
  name = '';
}

@smrt({ api: false, cli: false })
export class ConformanceCat extends ConformanceAnimal {
  lives = 9;
}

export class ConformanceAnimalCollection extends SmrtCollection<ConformanceAnimal> {
  static readonly _itemClass = ConformanceAnimal;
}

export class ConformanceCatCollection extends SmrtCollection<ConformanceCat> {
  static readonly _itemClass = ConformanceCat;
}

@smrt({
  api: false,
  cli: false,
  mcp: { include: ['slowGenerate'], tasks: ['slowGenerate'] },
})
export class ConformanceTaskWidget extends SmrtObject {
  name = '';

  @backgroundEligible()
  async slowGenerate(options: { prompt: string }) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { generated: options.prompt };
  }
}

export class ConformanceTaskWidgetCollection extends SmrtCollection<ConformanceTaskWidget> {
  static readonly _itemClass = ConformanceTaskWidget;
}
