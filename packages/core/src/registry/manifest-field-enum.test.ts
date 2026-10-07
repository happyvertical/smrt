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
