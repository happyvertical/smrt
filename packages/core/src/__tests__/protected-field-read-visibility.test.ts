/**
 * A protected field the caller cannot read is never compared with the stored
 * value (#5195): the comparison would confirm a guess of a value their own
 * responses omit. A caller who can read it keeps the unchanged round trip.
 */

import { describe, expect, it } from 'vitest';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { prepareWriteInput } from '../request-input.js';
import { FieldNotWritableError } from '../write-input.js';

@smrt()
class ReadVisibilityRow extends SmrtObject {
  @field({ type: 'text' })
  label: string = '';

  @field({ type: 'text', readonly: true })
  code: string = '';

  @field({ type: 'text', readonly: true, sensitive: true })
  secretHash: string = '';

  @field({
    type: 'text',
    readonly: true,
    readPermission: 'readvisibilityrow.read_gated',
  })
  gated: string = '';
}

describe('write input and read visibility', () => {
  const stored = () =>
    Object.assign(new ReadVisibilityRow(), {
      label: 'a',
      code: 'C-1',
      secretHash: 'hash',
      gated: 'g',
    });
  const model = 'ReadVisibilityRow';

  it('is registered', () => {
    expect(ObjectRegistry.getClass(model)).toBeTruthy();
  });

  it('accepts a readable protected field unchanged and refuses it changed', () => {
    expect(
      prepareWriteInput(model, { code: 'C-1', label: 'b' }, stored()),
    ).toEqual({ label: 'b' });
    expect(() => prepareWriteInput(model, { code: 'C-2' }, stored())).toThrow(
      FieldNotWritableError,
    );
  });

  it('refuses a sensitive field whatever its value', () => {
    for (const value of ['hash', 'guess']) {
      expect(() =>
        prepareWriteInput(model, { secretHash: value }, stored(), {
          permissions: ['readvisibilityrow.read_gated'],
        }),
      ).toThrow(FieldNotWritableError);
    }
  });

  it('refuses a readPermission field the caller lacks, and compares it for a holder', () => {
    for (const value of ['g', 'guess']) {
      expect(() =>
        prepareWriteInput(model, { gated: value }, stored(), {
          permissions: [],
        }),
      ).toThrow(FieldNotWritableError);
      // No read options: no permission is held.
      expect(() =>
        prepareWriteInput(model, { gated: value }, stored()),
      ).toThrow(FieldNotWritableError);
    }
    const holder = { permissions: ['readvisibilityrow.read_gated'] };
    expect(prepareWriteInput(model, { gated: 'g' }, stored(), holder)).toEqual(
      {},
    );
    expect(() =>
      prepareWriteInput(model, { gated: 'guess' }, stored(), holder),
    ).toThrow(FieldNotWritableError);
  });
});
