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

  it('reports representative per-call benchmark measurements without timing assertions', () => {
    const object = new PlainObjectSerializationProbe();
    const callsPerSample = 2_000;
    const samples = 7;
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
      `toPlainObject benchmark (${samples} interleaved x ${callsPerSample} representative rows): direct median=${median(directSamples).toFixed(2)}ms legacy median=${median(legacySamples).toFixed(2)}ms`,
    );
    expect(object.toPlainObject().transformed).toBe(true);
  });
});
