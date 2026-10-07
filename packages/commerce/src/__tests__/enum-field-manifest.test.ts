/**
 * #3598: enum- and literal-union-typed fields carry their allowed values in
 * the manifest, so generic forms and generated tool schemas can constrain them
 * instead of treating the field as free text.
 *
 * Reads the manifest the smrt-vitest plugin generates from source before the
 * run (`.smrt/manifest.json`), i.e. exactly what the scanner emits.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type ManifestField = { type: string; enum?: Array<string | number> };
const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), '.smrt/manifest.json'), 'utf8'),
) as { objects: Record<string, { fields: Record<string, ManifestField> }> };

const fieldsOf = (className: string) =>
  manifest.objects[`@happyvertical/smrt-commerce:${className}`].fields;

describe('commerce manifest enum fields', () => {
  it('emits ContractStatus values (not member names) on Contract.status', () => {
    expect(fieldsOf('Contract').status).toMatchObject({
      type: 'text',
      enum: ['draft', 'sent', 'accepted', 'declined', 'completed', 'cancelled'],
    });
  });

  it('emits literal-union values on Customer', () => {
    expect(fieldsOf('Customer').status.enum).toEqual([
      'active',
      'inactive',
      'suspended',
    ]);
    expect(fieldsOf('Customer').customerType.enum).toEqual([
      'dtc',
      'wholesale',
      'retail',
    ]);
  });

  it('leaves free-text fields unconstrained', () => {
    expect(fieldsOf('Customer').name?.enum).toBeUndefined();
  });
});
