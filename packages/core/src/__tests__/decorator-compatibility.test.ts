import { beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field, method } from '../decorators/index.js';
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

function createMethodContext(
  name: string,
  metadata: Record<PropertyKey, unknown>,
  isStatic = false,
): ClassMethodDecoratorContext<any, any> {
  return {
    kind: 'method',
    name,
    static: isStatic,
    private: false,
    access: { has: () => true, get: () => undefined },
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

  it('applies stage-3 @method() metadata on a class with no class decorator', () => {
    // A plain `SmrtCollection` subclass registered through
    // `registerCollection()` carries no `@smrt()`, and `@smrt()`/`@TenantScoped`
    // were the only things that flushed the pending-decorator queue. Under
    // standard decorators the config was queued and never applied, so the
    // runtime store stayed empty while a legacy `api.routes` entry still routed
    // the action — a silent widening, since absent exposure metadata defaults
    // open (#2686). Note there is NO class-decorator flush here, unlike the
    // field test below.
    const metadata: Record<PropertyKey, unknown> = {};

    // A TC39 decorator emit attaches the metadata object to the constructor
    // under `Symbol.metadata`, polyfilling the symbol when the host lacks it
    // (Node exposes it only behind a flag). Do the same, so this exercises the
    // real lookup path rather than a private hook.
    const symbolHolder = Symbol as typeof Symbol & { metadata?: symbol };
    const hadMetadataSymbol = symbolHolder.metadata !== undefined;
    if (!hadMetadataSymbol) {
      symbolHolder.metadata = Symbol('Symbol.metadata');
    }
    const metadataSymbol = symbolHolder.metadata as symbol;

    try {
      class StandardDecoratedCollection extends SmrtCollection<SmrtObject> {
        async concealed(): Promise<void> {}
      }
      Object.defineProperty(StandardDecoratedCollection, metadataSymbol, {
        value: metadata,
        configurable: true,
      });

      method({ expose: false, reason: 'internal' })(
        StandardDecoratedCollection.prototype.concealed,
        createMethodContext('concealed', metadata),
      );

      // Queued, not yet applied: nothing has flushed it.
      expect(
        ObjectRegistry.getMethodDecorator(
          StandardDecoratedCollection,
          'concealed',
        ),
      ).toBeUndefined();

      ObjectRegistry.registerCollection(
        'StandardDecoratedItem',
        StandardDecoratedCollection as never,
      );

      expect(
        ObjectRegistry.getMethodDecorator(
          StandardDecoratedCollection,
          'concealed',
        ),
      ).toMatchObject({ expose: false, reason: 'internal' });
    } finally {
      if (!hadMetadataSymbol) symbolHolder.metadata = undefined;
    }
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
