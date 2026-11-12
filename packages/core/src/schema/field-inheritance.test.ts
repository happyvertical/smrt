import { describe, expect, it, vi } from 'vitest';
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
  it('the nearest concrete declaration wins between ancestors, wholesale', () => {
    const fields = resolve(
      strategy,
      [
        link('A', { n: { type: 'text', required: true, unique: true } }),
        link('B', { n: { type: 'text' } }),
      ],
      {},
    );
    expect(fields.get('n')).toEqual({ type: 'text' });
  });

  it('fills only a missing enum and description from the replaced declaration', () => {
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
