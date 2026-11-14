import { describe, expect, it } from 'vitest';
import type { FieldDefinition } from '../scanner/types.js';
import {
  createFieldFromManifest,
  mergeManifestField,
  readFieldEnum,
} from './manifest-field-merge.js';

describe('manifest field enum (#3598)', () => {
  const def = (extra: Partial<FieldDefinition>): FieldDefinition => ({
    type: 'text',
    ...extra,
  });

  it('mirrors a manifest enum into registry _meta, copied not aliased', () => {
    const source = ['draft', 'sent'];
    const field = createFieldFromManifest(def({ enum: source }));
    expect(field._meta?.enum).toEqual(['draft', 'sent']);
    expect(field._meta?.enum).not.toBe(source);
    expect(readFieldEnum(field)).toEqual(['draft', 'sent']);
  });

  it('merge adopts the manifest enum over an existing field', () => {
    const existing = createFieldFromManifest(def({}));
    expect(readFieldEnum(existing)).toBeUndefined();
    const merged = mergeManifestField(existing, def({ enum: ['a'] }));
    expect(readFieldEnum(merged)).toEqual(['a']);
  });

  it('readFieldEnum prefers top level and ignores empty lists', () => {
    expect(readFieldEnum(def({ enum: ['x'], _meta: { enum: ['y'] } }))).toEqual(
      ['x'],
    );
    expect(readFieldEnum(def({ enum: [] }))).toBeUndefined();
    expect(readFieldEnum(undefined)).toBeUndefined();
  });
});

describe('manifest field bounds (#4924)', () => {
  it('retains top-level numeric and length constraints during registration and merge', () => {
    const field = createFieldFromManifest({
      type: 'integer',
      min: 3,
      max: 5,
      _meta: { min: 1, max: 9 },
    });
    expect(field._meta).toMatchObject({ min: 3, max: 5 });
    const merged = mergeManifestField(field, {
      type: 'integer',
      min: 4,
      max: 6,
    });
    expect(merged._meta).toMatchObject({ min: 4, max: 6 });
    const text = createFieldFromManifest({
      type: 'text',
      minLength: 4,
      maxLength: 8,
    });
    expect(text._meta).toMatchObject({ minLength: 4, maxLength: 8 });
    expect(
      mergeManifestField(text, { type: 'text', maxLength: 5 })._meta,
    ).toMatchObject({ minLength: 4, maxLength: 5 });
  });
});
