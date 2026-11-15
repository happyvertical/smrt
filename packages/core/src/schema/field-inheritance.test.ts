import { describe, expect, it, vi } from 'vitest';
import type {
  FieldOptions,
  NumericFieldOptions,
  TextFieldOptions,
} from '../decorators/index.js';
import {
  type FieldInheritanceLink,
  type InheritableField,
  resolveInheritedFields,
} from './field-inheritance.js';

type F = InheritableField & { unique?: boolean };

const link = (
  name: string,
  fields: Record<string, F>,
  frameworkBase = false,
): FieldInheritanceLink<F> => ({
  name,
  fields: Object.entries(fields),
  frameworkBase,
});

const resolve = (
  strategy: 'own-table' | 'shared-table',
  ancestors: Array<FieldInheritanceLink<F>>,
  own: Record<string, F>,
  representation: 'manifest' | 'registry' = 'manifest',
  onTypeMismatch?: (...args: never[]) => void,
) =>
  resolveInheritedFields<F>({
    strategy,
    className: 'Leaf',
    ancestors,
    own: Object.entries(own),
    representation,
    onTypeMismatch: onTypeMismatch as never,
  });

describe.each([
  'own-table',
  'shared-table',
] as const)('resolveInheritedFields (%s)', (strategy) => {
  it('an initializer default on a redeclaration is stated and wins (#4942)', () => {
    // `override completionRule: Rule = 'submit'` under a parent default 'attest'.
    const fields = resolve(
      strategy,
      [
        link('A', {
          rule: {
            type: 'text',
            required: true,
            default: 'attest',
            _meta: { __statedOptions: ['required', 'default'] },
          } as F,
        }),
      ],
      {
        rule: {
          type: 'text',
          required: false,
          default: 'submit',
          _meta: { __statedOptions: ['default'] },
        } as F,
      },
    );
    expect(fields.get('rule')).toMatchObject({
      required: true,
      default: 'submit',
    });
  });

  it('a bare redeclaration inherits every parent option', () => {
    const fields = resolve(
      strategy,
      [
        link('A', { n: { type: 'text', required: true, unique: true } }),
        link('B', { n: { type: 'text' } }),
      ],
      {},
    );
    expect(fields.get('n')).toMatchObject({
      type: 'text',
      required: true,
      unique: true,
    });
  });

  it('a type the scanner could not resolve is not a type change (#4942)', () => {
    // `override productType: ProductType = ...` with an enum the scanner cannot
    // see: it types the field json and marks the type as a fallback.
    const fields = resolve(
      strategy,
      [
        link('A', {
          kind: {
            type: 'text',
            required: true,
            enum: ['a', 'b'],
            _meta: { sqlType: 'VARCHAR(8)', __statedOptions: ['enum'] },
          } as F,
        }),
      ],
      {
        kind: {
          type: 'json',
          required: false,
          _meta: { __statedOptions: [], __typeUnresolved: true },
        } as F,
      },
    );
    expect(fields.get('kind')).toMatchObject({
      type: 'text',
      required: true,
      enum: ['a', 'b'],
    });
    expect(fields.get('kind')?._meta?.sqlType).toBe('VARCHAR(8)');
    expect(fields.get('kind')?._meta?.__typeUnresolved).toBeUndefined();
  });

  it('a resolved, different type is still a type change (#4942)', () => {
    const fields = resolve(
      strategy,
      [link('A', { kind: { type: 'text', enum: ['a'], required: true } })],
      { kind: { type: 'json', _meta: { __statedOptions: [] } } },
    );
    expect(fields.get('kind')?.type).toBe('json');
    expect(fields.get('kind')?.enum).toBeUndefined();
  });

  it('keeps a missing enum and overrides a stated description', () => {
    const fields = resolve(
      strategy,
      [link('A', { k: { type: 'text', enum: ['a'], description: 'Kind' } })],
      { k: { type: 'text', description: 'Own' } },
    );
    expect(fields.get('k')).toEqual({
      type: 'text',
      enum: ['a'],
      description: 'Own',
    });
  });

  it('the class own declaration wins over every ancestor, in either direction', () => {
    const fields = resolve(
      strategy,
      [link('A', { n: { type: 'integer', _meta: { min: 10, max: 80 } } })],
      { n: { type: 'integer', _meta: { min: 0, max: 100 } } },
    );
    expect(fields.get('n')?._meta).toEqual({ min: 0, max: 100 });
  });

  it('ignores scanner inferences when an inherited option exists', () => {
    const fields = resolve(
      strategy,
      [
        link('A', {
          n: {
            type: 'integer',
            required: false,
            _meta: { default: 7, __statedOptions: ['required', 'default'] },
          },
        }),
      ],
      {
        n: {
          type: 'integer',
          required: true,
          _meta: { default: 0, max: 20, __statedOptions: ['max'] },
        },
      },
    );
    expect(fields.get('n')).toMatchObject({
      required: false,
      _meta: { default: 7, max: 20 },
    });
  });

  it('uses fresh inferred type defaults only when the field type changes', () => {
    const inherited = link('A', {
      n: { type: 'text', required: true, _meta: { default: 'parent' } },
    });
    const own = {
      n: {
        type: 'integer',
        required: false,
        _meta: { default: 0, __statedOptions: [] },
      },
    };
    expect(resolve(strategy, [inherited], own).get('n')).toMatchObject({
      type: 'integer',
      required: true,
      default: 0,
    });
  });

  it('keeps independent defaults through three partial declarations', () => {
    const fields = resolve(
      strategy,
      [
        link('A', {
          n: {
            type: 'integer',
            required: true,
            _meta: { unique: true, min: 10, max: 80 },
          },
        }),
        link('B', { n: { type: 'integer', _meta: { max: 100 } } }),
      ],
      {
        n: {
          type: 'integer',
          _meta: { required: false, unique: false, min: 0 },
        },
      },
    );
    expect(fields.get('n')).toMatchObject({
      required: false,
      _meta: { required: false, unique: false, min: 0, max: 100 },
    });
  });

  it.each([
    'manifest',
    'registry',
  ] as const)('drops type-bound defaults on a type change (%s)', (representation) => {
    const fields = resolve(
      strategy,
      [
        link('A', {
          n: {
            type: 'text',
            required: true,
            _meta: {
              unique: true,
              sqlType: 'VARCHAR',
              min: 1,
              max: 9,
              enum: ['a'],
              default: 'a',
              backfill: "'a'",
              minLength: 1,
              maxLength: 9,
              pattern: '^a$',
              description: 'Kept',
              sensitive: true,
              readonly: true,
              indexed: true,
            },
          },
        }),
      ],
      { n: { type: 'integer', _meta: { max: 20 } } },
      representation,
    );
    const merged = fields.get('n');
    expect(merged).toMatchObject({ type: 'integer', required: true });
    expect(merged?._meta).toMatchObject({
      unique: true,
      max: 20,
      description: 'Kept',
      sensitive: true,
      readonly: true,
      indexed: true,
    });
    for (const key of [
      'sqlType',
      'min',
      'enum',
      'default',
      'backfill',
      'minLength',
      'maxLength',
      'pattern',
    ]) {
      expect(merged?._meta).not.toHaveProperty(key);
      expect(merged).not.toHaveProperty(key);
    }
  });

  it.each([
    'manifest',
    'registry',
  ] as const)('null clears options and later omissions keep them cleared (%s)', (representation) => {
    const clears = {
      sqlType: null,
      default: null,
      backfill: null,
      min: null,
      max: null,
      minLength: null,
      maxLength: null,
      pattern: null,
      description: null,
      readPermission: null,
    } satisfies FieldOptions & NumericFieldOptions & TextFieldOptions;
    const keys = Object.keys(clears);
    const cleared = resolve(
      strategy,
      [
        link('A', {
          n: {
            type: 'text',
            _meta: Object.fromEntries(keys.map((key) => [key, 'parent'])),
          },
        }),
      ],
      {
        n: {
          type: 'text',
          _meta: {
            ...clears,
            __statedOptions: keys,
          },
        },
      },
      representation,
    ).get('n');
    if (!cleared) throw new Error('missing resolved field');
    const leaf = resolve(
      strategy,
      [link('A', { n: cleared })],
      {
        n: {
          type: 'text',
          _meta: { default: 'inferred', __statedOptions: [] },
        },
      },
      representation,
    ).get('n');
    for (const key of keys) {
      expect(cleared).not.toHaveProperty(key);
      expect(cleared?._meta).not.toHaveProperty(key);
      expect(leaf).not.toHaveProperty(key);
      expect(leaf?._meta).not.toHaveProperty(key);
    }
  });

  it('a concrete declaration replaces a framework default whole, filling nothing', () => {
    const fields = resolve(
      strategy,
      [link('Base', { x: { type: 'text', description: 'Default' } }, true)],
      {},
    );
    expect(fields.get('x')?.description).toBe('Default');
    const replaced = resolve(
      strategy,
      [
        link('Base', { x: { type: 'text', description: 'Default' } }, true),
        link('Mid', { x: { type: 'integer' } }),
      ],
      {},
    );
    expect(replaced.get('x')).toEqual({ type: 'integer' });
  });

  it('keeps first-seen order, base first', () => {
    const fields = resolve(
      strategy,
      [link('A', { a: { type: 'text' }, b: { type: 'text' } })],
      { c: { type: 'text' }, a: { type: 'integer' } },
    );
    expect([...fields.keys()]).toEqual(['a', 'b', 'c']);
  });
});

describe('SmrtHierarchical.parentId binding', () => {
  const base = link(
    'SmrtHierarchical',
    { parentId: { type: 'text', required: true } },
    true,
  );

  it('own-table: bound to the class itself, a concrete ancestor never rebinds it', () => {
    const fields = resolve(
      'own-table',
      [base, link('Mid', { parentId: { type: 'foreignKey', related: 'Mid' } })],
      {},
    );
    expect(fields.get('parentId')).toMatchObject({
      type: 'foreignKey',
      related: 'Leaf',
      required: false,
      _meta: { nullable: true },
    });
  });

  it('shared-table: bound to the family root, the first concrete class', () => {
    const fields = resolve(
      'shared-table',
      [base, link('Root', {}), link('Mid', {})],
      {},
    );
    expect(fields.get('parentId')?.related).toBe('Root');
    expect(resolve('shared-table', [base], {}).get('parentId')?.related).toBe(
      'Leaf',
    );
  });
});

describe('registry representation', () => {
  it('fills enum and description under _meta and keeps runtime-only state', async () => {
    const parentValidate = vi.fn(async () => true);
    const childValidate = vi.fn(async () => false);
    const fields = resolve(
      'own-table',
      [
        link('A', {
          k: {
            type: 'text',
            enum: ['a'],
            value: 'kept',
            _meta: { validate: parentValidate, __tenancy: { x: 1 } },
          },
        }),
      ],
      { k: { type: 'text', _meta: { validate: childValidate } } },
      'registry',
    );
    const merged = fields.get('k');
    expect(merged?._meta?.enum).toEqual(['a']);
    expect(merged?.value).toBe('kept');
    expect(merged?._meta?.__tenancy).toEqual({ x: 1 });
    const validate = merged?._meta?.validate as (
      v: unknown,
    ) => Promise<boolean>;
    expect(await validate(1)).toBe(false);
    expect(parentValidate).toHaveBeenCalled();
    expect(childValidate).toHaveBeenCalled();
  });

  it('reports a type change on a replaced declaration', () => {
    const seen = vi.fn();
    resolve(
      'own-table',
      [link('A', { n: { type: 'text' } })],
      { n: { type: 'integer' } },
      'registry',
      seen,
    );
    expect(seen).toHaveBeenCalledWith('n', 'text', 'integer', {
      type: 'text',
    });
  });
});
