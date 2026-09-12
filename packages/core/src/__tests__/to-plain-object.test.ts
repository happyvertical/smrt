import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SmrtObject } from '../object';

class PlainObjectSerializationProbe extends SmrtObject {
  protected transformJSON(data: Record<string, unknown>) {
    return {
      ...data,
      transformed: true,
      nested: {
        date: new Date('2026-09-12T12:34:56.789Z'),
        undefinedValue: undefined,
        nonFinite: Number.POSITIVE_INFINITY,
        list: [undefined, Number.NaN, new Date('2026-09-12T00:00:00.000Z')],
        rows: Array.from({ length: 5 }, (_, index) => ({
          id: `row-${index}`,
          createdAt: new Date(
            `2026-09-${String(index + 1).padStart(2, '0')}T01:02:03.000Z`,
          ),
          flags: [index % 2 === 0, undefined, Number.NEGATIVE_INFINITY],
          metadata: { sequence: index, missing: undefined },
        })),
        custom: {
          toJSON(key: string) {
            return { key, date: new Date('2026-09-12T01:02:03.000Z') };
          },
        },
      },
    };
  }
}

class ProtoKeySerializationProbe extends SmrtObject {
  protected transformJSON(data: Record<string, unknown>) {
    const nested: Record<string, unknown> = {};
    Object.defineProperty(nested, '__proto__', {
      configurable: true,
      enumerable: true,
      value: { retained: true },
      writable: true,
    });

    return { ...data, nested };
  }
}

describe('SmrtObject.toPlainObject', () => {
  it('preserves JSON-compatible values from transformJSON without a string round trip', () => {
    const object = new PlainObjectSerializationProbe();

    expect(object.toPlainObject()).toMatchObject({
      transformed: true,
      nested: {
        date: '2026-09-12T12:34:56.789Z',
        nonFinite: null,
        list: [null, null, '2026-09-12T00:00:00.000Z'],
        custom: { key: 'custom', date: '2026-09-12T01:02:03.000Z' },
      },
    });
    expect(object.toPlainObject().nested).not.toHaveProperty('undefinedValue');
  });

  it('rejects bigint values like JSON serialization', () => {
    const object = new PlainObjectSerializationProbe();
    object.transformJSON = (data) => ({ ...data, bigint: Object(1n) });

    expect(() => object.toPlainObject()).toThrow(
      'Do not know how to serialize a BigInt',
    );
  });

  it('preserves own __proto__ keys without changing a plain object prototype', () => {
    const object = new ProtoKeySerializationProbe();
    const plain = object.toPlainObject();
    const legacy = JSON.parse(JSON.stringify(object));
    const nested = plain.nested as Record<string, unknown>;

    expect(plain).toEqual(legacy);
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
    expect(Object.hasOwn(nested, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(nested, '__proto__')?.value).toEqual(
      { retained: true },
    );
  });

  it('matches legacy conversion for callable hooks and boxed primitive values', () => {
    const makePayload = () => {
      let hookReads = 0;
      const callable = () => undefined;
      Object.defineProperty(callable, 'toJSON', {
        configurable: true,
        get() {
          hookReads++;
          return () => 'saved';
        },
      });
      const arrayCallable = Object.assign(() => undefined, {
        toJSON: () => 'saved',
      });
      const boxedBoolean = Object.assign(new Boolean(true), {
        valueOf: () => false,
      });
      const boxedNumber = Object.assign(new Number(3), {
        valueOf: () => '7',
      });
      const boxedString = Object.assign(new String('abc'), {
        valueOf: () => 'other',
      });

      return {
        data: {
          callable,
          list: [arrayCallable],
          negativeZero: -0,
          boxedBoolean,
          boxedNumber,
          boxedString,
        },
        hookReads: () => hookReads,
      };
    };
    const directPayload = makePayload();
    const legacyPayload = makePayload();
    const object = new PlainObjectSerializationProbe();
    object.transformJSON = (data) => ({ ...data, ...directPayload.data });
    const legacy = JSON.parse(JSON.stringify(legacyPayload.data));
    const plain = object.toPlainObject();

    expect(plain).toMatchObject(legacy);
    expect(directPayload.hookReads()).toBe(1);
    expect(Object.is(plain.negativeZero, 0)).toBe(true);
  });

  it('snapshots array length before getters can mutate it', () => {
    const object = new PlainObjectSerializationProbe();
    const makeValues = () => {
      const values = ['a', 'b'];
      Object.defineProperty(values, 0, {
        configurable: true,
        enumerable: true,
        get() {
          values.length = 1;
          return 'a';
        },
      });
      return values;
    };
    object.transformJSON = (data) => {
      return { ...data, values: makeValues() };
    };

    const legacy = JSON.parse(JSON.stringify(makeValues()));
    expect(object.toPlainObject()).toMatchObject({ values: legacy });
  });

  it('coerces a proxy array length once before reading indices', () => {
    const makePayload = () => {
      let coercions = 0;
      const length = {
        valueOf: () => {
          coercions++;
          return 1.9;
        },
      };
      return {
        values: new Proxy(['first', 'second'], {
          get(target, key, receiver) {
            return key === 'length'
              ? length
              : Reflect.get(target, key, receiver);
          },
        }),
        coercions: () => coercions,
      };
    };
    const direct = makePayload();
    const legacy = makePayload();
    const object = new PlainObjectSerializationProbe();
    object.transformJSON = () => ({ values: direct.values });
    expect(object.toPlainObject()).toEqual(
      JSON.parse(JSON.stringify({ values: legacy.values })),
    );
    expect(direct.coercions()).toBe(1);
    expect(legacy.coercions()).toBe(1);
  });

  it('preserves cross-realm boxed primitives and bigint hooks', () => {
    const [boxedBoolean, boxedNumber, boxedString] = runInNewContext(
      '[new Boolean(true), new Number(3), new String("abc")]',
    );
    const originalToJSON = Object.getOwnPropertyDescriptor(
      BigInt.prototype,
      'toJSON',
    );
    Object.defineProperty(BigInt.prototype, 'toJSON', {
      configurable: true,
      value() {
        return `${this.toString()}n`;
      },
    });

    try {
      const object = new PlainObjectSerializationProbe();
      object.transformJSON = (data) => ({
        ...data,
        bigint: 1n,
        boxedBoolean,
        boxedNumber,
        boxedString,
      });
      const legacy = JSON.parse(
        JSON.stringify({ bigint: 1n, boxedBoolean, boxedNumber, boxedString }),
      );

      expect(object.toPlainObject()).toMatchObject(legacy);
    } finally {
      if (originalToJSON) {
        Object.defineProperty(BigInt.prototype, 'toJSON', originalToJSON);
      } else {
        Reflect.deleteProperty(BigInt.prototype, 'toJSON');
      }
    }
  });

  it('matches legacy coercion without observing Symbol.toStringTag', () => {
    const overriddenToString = Object.assign(new String('abc'), {
      toString: () => 'changed',
    });
    const overriddenPrimitive = Object.assign(new String('abc'), {
      [Symbol.toPrimitive]: () => 'primitive',
    });
    const taggedNumber = Object.assign(new Number(3), {
      [Symbol.toStringTag]: 'custom',
    });
    const throwingTagNumber = new Number(4);
    Object.defineProperty(throwingTagNumber, Symbol.toStringTag, {
      get() {
        throw new Error('tag getter must not run');
      },
    });
    const data = {
      overriddenPrimitive,
      overriddenToString,
      taggedNumber,
      throwingTagNumber,
    };
    const object = new PlainObjectSerializationProbe();
    object.transformJSON = (base) => ({ ...base, ...data });

    expect(object.toPlainObject()).toMatchObject(
      JSON.parse(JSON.stringify(data)),
    );
  });

  it('decodes native raw JSON primitive literals once', () => {
    const object = new PlainObjectSerializationProbe();
    const literals = ['123', 'true', 'null', '"text"', '-0', '1e400'];
    const nativeJSON = JSON as typeof JSON & { rawJSON(text: string): unknown };
    object.transformJSON = () => ({
      literals: literals.map((literal) => nativeJSON.rawJSON(literal)),
    });
    expect(object.toPlainObject()).toEqual(JSON.parse(JSON.stringify(object)));
  });

  it('invokes hooks without reading their call property', () => {
    const object = new PlainObjectSerializationProbe();
    const nested = {
      marker: 'nested',
      toJSON(key: string) {
        return { marker: this.marker, key };
      },
    };
    Object.defineProperty(nested.toJSON, 'call', {
      get() {
        throw new Error('call property must not be read');
      },
    });
    object.transformJSON = () => ({ nested });
    expect(object.toPlainObject()).toEqual(JSON.parse(JSON.stringify(object)));
    expect(object.toPlainObject()).toEqual({
      nested: { marker: 'nested', key: 'nested' },
    });
  });

  it('does not invoke a replacement value toJSON hook again', () => {
    const object = new PlainObjectSerializationProbe();
    let replacementHookCalls = 0;
    const replacement = {
      retained: true,
      toJSON() {
        replacementHookCalls++;
        return 'wrong';
      },
    };
    object.transformJSON = () => ({
      replacement: { toJSON: () => replacement },
      dateReplacement: { toJSON: () => new Date(0) },
    });
    expect(object.toPlainObject()).toEqual(JSON.parse(JSON.stringify(object)));
    expect(object.toPlainObject()).toEqual({
      replacement: { retained: true },
      dateReplacement: {},
    });
    expect(replacementHookCalls).toBe(0);
  });

  it('copies shared siblings independently and rejects cycles on the active path', () => {
    const object = new PlainObjectSerializationProbe();
    const shared = { values: [1, 2] };
    object.transformJSON = () => ({ left: shared, right: shared });
    const plain = object.toPlainObject();
    expect(plain).toEqual(JSON.parse(JSON.stringify(object)));
    expect(plain.left).not.toBe(plain.right);
    (plain.left as typeof shared).values.push(3);
    expect((plain.right as typeof shared).values).toEqual([1, 2]);
    expect(shared.values).toEqual([1, 2]);

    const cyclic: unknown[] = [];
    cyclic.push({ back: cyclic });
    object.transformJSON = () => ({ cyclic });
    expect(() => object.toPlainObject()).toThrow(TypeError);
    expect(() => JSON.stringify(object)).toThrow(TypeError);
  });

  it('rejects boxed numbers whose numeric coercion returns bigint', () => {
    const object = new PlainObjectSerializationProbe();
    const boxed = Object.assign(new Number(1), { valueOf: () => 2n });
    object.transformJSON = () => ({ boxed });
    expect(() => JSON.stringify(object)).toThrow(TypeError);
    expect(() => object.toPlainObject()).toThrow(TypeError);
  });

  it.each([
    'row',
    'nested',
  ] as const)('reports %s per-call benchmark measurements without timing assertions', (shape) => {
    const object =
      shape === 'nested'
        ? new PlainObjectSerializationProbe()
        : new SmrtObject();
    if (shape === 'row') {
      object.transformJSON = (data) => ({
        ...data,
        transformed: true,
        title: 'Representative list row',
        quantity: 12,
        rate: 0.25,
        active: true,
        tags: ['published', 'featured'],
        metadata: { locale: 'en', priority: 3 },
      });
    }
    const callsPerSample = 5_000;
    const samples = 11;
    const measure = (operation: () => unknown): number => {
      const start = performance.now();
      for (let index = 0; index < callsPerSample; index++) {
        operation();
      }
      return performance.now() - start;
    };
    const directSamples: number[] = [];
    const legacySamples: number[] = [];

    // Warm both paths before collecting alternating samples, which keeps JIT
    // startup and temporary allocation effects from favoring one path.
    measure(() => object.toPlainObject());
    measure(() => JSON.parse(JSON.stringify(object)));

    for (let sample = 0; sample < samples; sample++) {
      const direct = () => object.toPlainObject();
      const legacy = () => JSON.parse(JSON.stringify(object));
      if (sample % 2 === 0) {
        directSamples.push(measure(direct));
        legacySamples.push(measure(legacy));
      } else {
        legacySamples.push(measure(legacy));
        directSamples.push(measure(direct));
      }
    }

    const median = (values: number[]) =>
      [...values].sort((left, right) => left - right)[
        Math.floor(values.length / 2)
      ];

    console.info(
      `toPlainObject ${shape} benchmark (${samples} interleaved x ${callsPerSample} representative rows): direct median=${median(directSamples).toFixed(2)}ms legacy median=${median(legacySamples).toFixed(2)}ms`,
    );
    expect(object.toPlainObject()).toEqual(JSON.parse(JSON.stringify(object)));
    expect(object.toPlainObject().transformed).toBe(true);
  });
});
