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
