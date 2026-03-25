import { beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

function createFieldContext(
  name: string,
  metadata: Record<PropertyKey, unknown>,
): ClassFieldDecoratorContext<any, any> {
  return {
    kind: 'field',
    name,
    static: false,
    private: false,
    access: {
      has: () => true,
      get: () => undefined,
      set: () => {},
    },
    addInitializer: () => {},
    metadata,
  };
}

function createClassContext(
  ctor: abstract new (...args: any[]) => any,
  metadata: Record<PropertyKey, unknown>,
): ClassDecoratorContext<typeof ctor> {
  return {
    kind: 'class',
    name: ctor.name,
    addInitializer: () => {},
    metadata,
  };
}

describe('decorator compatibility helpers', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
  });

  it('registers stage-3 field metadata before any instance is constructed', () => {
    const metadata: Record<PropertyKey, unknown> = {};
    const decorator = field({ required: true });

    decorator(undefined, createFieldContext('title', metadata));

    class StandardDecoratedRecord extends SmrtObject {
      title: string = '';
    }

    smrt()(
      StandardDecoratedRecord,
      createClassContext(StandardDecoratedRecord, metadata),
    );

    expect(
      ObjectRegistry.getFieldDecorator('StandardDecoratedRecord', 'title'),
    ).toMatchObject({
      required: true,
    });
  });
});
