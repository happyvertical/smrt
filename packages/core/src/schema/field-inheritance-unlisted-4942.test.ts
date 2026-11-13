/**
 * A field entry with no `_meta.__statedOptions` comes from a manifest built
 * before the scanner wrote the list, or from one written by hand. The shared
 * rule cannot tell what its author wrote, and a `required: false` on such an
 * entry is what the older scanner inferred. It must not be refused (#4932) for
 * something the author never wrote (#4942).
 */
import { describe, expect, it } from 'vitest';
import {
  type FieldInheritanceLink,
  type InheritableField,
  resolveInheritedFields,
} from './field-inheritance.js';

type F = InheritableField & { default?: unknown };

const link = (
  name: string,
  fields: Record<string, F>,
): FieldInheritanceLink<F> => ({
  name,
  fields: Object.entries(fields),
  frameworkBase: false,
});

const parent = (extra: Record<string, unknown> = {}): F =>
  ({
    type: 'text',
    required: true,
    _meta: {
      requiredFor: 'identity',
      __statedOptions: ['required', 'requiredFor'],
    },
    ...extra,
  }) as F;

describe.each([
  ['own-table', 'manifest'],
  ['own-table', 'registry'],
  ['shared-table', 'manifest'],
  ['shared-table', 'registry'],
] as const)('a field entry with no stated list (%s, %s)', (strategy, representation) => {
  const resolve = (parentField: F, own: F) =>
    resolveInheritedFields<F>({
      strategy,
      className: 'Leaf',
      ancestors: [link('Base', { code: parentField })],
      own: [['code', own]],
      representation,
    }).get('code') as F;

  it('inherits over a requiredFor parent instead of being refused', () => {
    const resolved = resolve(parent(), { type: 'text', required: false });
    expect(resolved.required).toBe(true);
    expect(resolved._meta?.requiredFor).toBe('identity');
  });

  it('inherits when the entry also carries an inferred nullable', () => {
    const resolved = resolve(parent(), {
      type: 'text',
      required: false,
      _meta: { nullable: true },
    });
    expect(resolved.required).toBe(true);
    expect(resolved._meta?.requiredFor).toBe('identity');
  });

  it('still refuses an entry that lists required among the options it states', () => {
    expect(() =>
      resolve(parent(), {
        type: 'text',
        required: false,
        _meta: { __statedOptions: ['required'] },
      }),
    ).toThrow(/Leaf\.code cannot be made optional.*identity/);
  });

  it('an empty list states nothing and inherits', () => {
    const resolved = resolve(parent(), {
      type: 'text',
      required: false,
      _meta: { __statedOptions: [] },
    });
    expect(resolved.required).toBe(true);
  });

  it('keeps the other options the entry carries, as before the list existed', () => {
    const resolved = resolve(
      parent({ default: 'a', description: 'Parent description' }),
      {
        type: 'text',
        required: false,
        default: 'b',
        description: 'Own description',
      },
    );
    // The entry replaced its parent's field whole before this release, so the
    // values it carries win. Only `required` is not trusted: the older scanner
    // wrote it for every field, whether or not the author did.
    expect(resolved.default).toBe('b');
    expect(resolved.description).toBe('Own description');
    expect(resolved.required).toBe(true);
    expect(resolved._meta?.requiredFor).toBe('identity');
  });

  it('keeps an entry that is required over a parent that is not', () => {
    const resolved = resolve({ type: 'text', required: false } as F, {
      type: 'text',
      required: true,
    });
    expect(resolved.required).toBe(true);
  });

  it('lets required:false win over a required parent that states no reason', () => {
    const resolved = resolve({ type: 'text', required: true } as F, {
      type: 'text',
      required: false,
    });
    expect(resolved.required).toBe(false);
  });
});
