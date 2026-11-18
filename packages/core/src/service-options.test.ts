import { describe, expect, expectTypeOf, it } from 'vitest';
import type { SmrtClassOptions } from './class.js';
import { ObjectRegistry } from './registry.js';
import {
  buildItemOptions,
  getRowValues,
  isServiceOptionInput,
  isServiceOptionKey,
  SMRT_ROW_VALUES,
  SMRT_SERVICE_OPTION_KEYS,
  type SmrtServiceOptionKey,
} from './service-options.js';

/** `SmrtClassOptions` keys that steer initialization and configure nothing. */
type InternalFlag =
  | '_className'
  | '_reuseInitializedDb'
  | '_deferRuntimeInitialization';

describe('service option keys', () => {
  it('give every SmrtClassOptions key a decision', () => {
    // A key added to `SmrtClassOptions` fails this line (and the `satisfies`
    // in service-options.ts) until it is classified as a service option or an
    // internal flag.
    expectTypeOf<SmrtServiceOptionKey | InternalFlag>().toEqualTypeOf<
      keyof SmrtClassOptions
    >();

    expect([...SMRT_SERVICE_OPTION_KEYS].sort()).toEqual(
      [
        'ai',
        'db',
        'decisions',
        'fs',
        'inference',
        'logging',
        'metrics',
        'persistence',
        'pubsub',
        'sanitization',
        'signals',
        'usage',
      ].sort(),
    );
    expect(Object.isFrozen(SMRT_SERVICE_OPTION_KEYS)).toBe(true);
    for (const key of SMRT_SERVICE_OPTION_KEYS) {
      expect(isServiceOptionKey(key)).toBe(true);
    }
    for (const key of ['_className', '_skipLoad', 'id', 'label', 'options']) {
      expect(isServiceOptionKey(key)).toBe(false);
    }
  });

  it('fail the type check when an option key has no decision', () => {
    // `SmrtClassOptions` as it would be after someone adds an option.
    type WithNewOption = keyof (SmrtClassOptions & { addedLater?: string });

    // The guard used above stops matching: the classified keys no longer
    // cover every option key. (`@ts-expect-error` itself fails the type check
    // if this line ever compiles.)
    type Classified = SmrtServiceOptionKey | InternalFlag;
    // @ts-expect-error an option key without a decision is not covered
    expectTypeOf<Classified>().toEqualTypeOf<WithNewOption>();

    // And the construct `service-options.ts` uses for its table rejects a
    // table that is missing a key.
    const complete = {
      _className: 'internal',
      db: 'service',
      persistence: 'service',
      fs: 'service',
      ai: 'service',
      decisions: 'service',
      inference: 'service',
      usage: 'service',
      logging: 'service',
      metrics: 'service',
      pubsub: 'service',
      sanitization: 'service',
      signals: 'service',
      _reuseInitializedDb: 'internal',
      _deferRuntimeInitialization: 'internal',
    } as const;
    const accepted = complete satisfies Record<
      keyof SmrtClassOptions,
      'service' | 'internal'
    >;
    // @ts-expect-error the same table does not cover the added key
    const rejected = complete satisfies Record<
      WithNewOption,
      'service' | 'internal'
    >;
    expect(Object.keys(accepted)).toHaveLength(Object.keys(rejected).length);
    expect(
      Object.entries(accepted)
        .filter(([, kind]) => kind === 'service')
        .map(([key]) => key)
        .sort(),
    ).toEqual([...SMRT_SERVICE_OPTION_KEYS].sort());
  });

  it('are request input unless the model declares the field', () => {
    const declaresMetrics = (key: string) => key === 'metrics';
    for (const key of SMRT_SERVICE_OPTION_KEYS) {
      expect(isServiceOptionInput(key, () => false)).toBe(true);
      expect(isServiceOptionInput(key, declaresMetrics)).toBe(
        key !== 'metrics',
      );
    }
    // The property that holds the service options is never a field.
    expect(isServiceOptionInput('options', () => true)).toBe(true);
    expect(isServiceOptionInput('label', () => false)).toBe(false);
    expect(isServiceOptionInput('_insertOnly', () => false)).toBe(false);
  });

  it('are all request input for an unknown or missing model', () => {
    for (const key of [...SMRT_SERVICE_OPTION_KEYS, 'options']) {
      expect(ObjectRegistry.isServiceOptionInput(undefined, key)).toBe(true);
      expect(
        ObjectRegistry.isServiceOptionInput('NoSuchRegisteredModel', key),
      ).toBe(true);
    }
    expect(ObjectRegistry.isServiceOptionInput(undefined, 'label')).toBe(false);
  });
});

describe('buildItemOptions', () => {
  const services = { ai: undefined, decisions: undefined, db: 'own-db' };

  it('applies every service the collection binds and leaves the rest unset', () => {
    const data = Object.fromEntries(
      SMRT_SERVICE_OPTION_KEYS.map((key) => [key, `from-data:${key}`]),
    );
    const bound = Object.fromEntries(
      SMRT_SERVICE_OPTION_KEYS.map((key) => [key, `own:${key}`]),
    );
    const { options } = buildItemOptions(data, {}, bound as never);
    for (const key of SMRT_SERVICE_OPTION_KEYS) {
      expect([key, options[key]]).toEqual([key, `own:${key}`]);
    }
    // An unbound (or explicitly undefined) service is not set at all, so the
    // model resolves it from configuration.
    const partial = buildItemOptions(
      data,
      {},
      {
        ai: undefined,
        decisions: undefined,
        db: 'own-db',
        fs: 'own-fs' as never,
        signals: undefined,
      },
    ).options;
    expect(partial.fs).toBe('own-fs');
    expect(Object.hasOwn(partial, 'signals')).toBe(false);
    expect(Object.hasOwn(partial, 'logging')).toBe(false);
  });

  it('applies the collection services over any data key', () => {
    const data = Object.fromEntries(
      SMRT_SERVICE_OPTION_KEYS.map((key) => [key, `from-data:${key}`]),
    );
    const { options, dataServiceKeys } = buildItemOptions(
      { ...data, label: 'kept' },
      {},
      {
        ai: 'own-ai' as never,
        decisions: 'own-decisions' as never,
        db: 'own-db',
      },
    );
    expect(options.db).toBe('own-db');
    expect(options.ai).toBe('own-ai');
    expect(options.decisions).toBe('own-decisions');
    for (const key of SMRT_SERVICE_OPTION_KEYS) {
      if (key === 'db' || key === 'ai' || key === 'decisions') continue;
      expect(Object.hasOwn(options, key)).toBe(false);
    }
    expect(options.label).toBe('kept');
    expect([...dataServiceKeys].sort()).toEqual(
      [...SMRT_SERVICE_OPTION_KEYS].sort(),
    );
    // The removed values stay available as row data for declared fields.
    expect(getRowValues(options)).toEqual(data);
  });

  it('keeps control keys, lets data override default flags, and keeps symbols', () => {
    const marker = Symbol('caller-marker');
    const { options, dataServiceKeys } = buildItemOptions(
      {
        id: 'row-id',
        _meta_type: 'Child',
        _insertOnly: true,
        _adoptNaturalKey: true,
        _skipLoad: false,
        [marker]: 'kept',
      },
      { _skipLoad: true, _reuseInitializedDb: true },
      services,
    );
    expect(options).toMatchObject({
      id: 'row-id',
      _meta_type: 'Child',
      _insertOnly: true,
      _adoptNaturalKey: true,
      _skipLoad: false,
      _reuseInitializedDb: true,
      db: 'own-db',
    });
    expect((options as Record<symbol, unknown>)[marker]).toBe('kept');
    expect(dataServiceKeys).toEqual([]);
    expect(getRowValues(options)).toEqual({});
  });

  it('marks its output and nothing else as built by a collection', () => {
    expect(getRowValues({ metrics: '[]' })).toBeUndefined();
    const { options } = buildItemOptions({ metrics: '[]' }, {}, services);
    expect(getRowValues(options)).toEqual({ metrics: '[]' });
    // JSON cannot carry the marker, so parsed data never looks collection-built.
    const parsed = JSON.parse(
      JSON.stringify({ [SMRT_ROW_VALUES.toString()]: { db: 'x' } }),
    );
    expect(getRowValues(parsed)).toBeUndefined();
  });

  it('copies an own __proto__ entry as data instead of applying it', () => {
    const data = JSON.parse(
      '{"__proto__": {"db": "from-proto"}, "label": "x"}',
    );
    const { options } = buildItemOptions(data, {}, services);
    expect(Object.getPrototypeOf(options)).toBe(Object.prototype);
    expect(options.db).toBe('own-db');
  });
});
