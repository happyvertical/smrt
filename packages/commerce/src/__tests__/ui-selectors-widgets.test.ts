/**
 * #3602: commerce declares CustomerSelect and VendorSelect as the selectors
 * for Customer and Vendor, and hints presentation widgets on its text fields.
 *
 * Reads the manifest the smrt-vitest plugin generates from source before the
 * run (`.smrt/manifest.json`), i.e. exactly what the scanner emits.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findSelectorFor } from '@happyvertical/smrt-core/ui-metadata';
import { describe, expect, it } from 'vitest';
import { COMMERCE_UI_SLOTS } from '../ui.js';

type ManifestField = { _meta?: { ui?: { widget?: string } } };
const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), '.smrt/manifest.json'), 'utf8'),
) as {
  objects: Record<string, { fields: Record<string, ManifestField> }>;
  uiSelectors: Record<string, { slotId: string; selects: string }>;
};

const widgetOf = (className: string, field: string) =>
  manifest.objects[`@happyvertical/smrt-commerce:${className}`].fields[field]
    ?._meta?.ui?.widget;

describe('commerce selector slots', () => {
  it('declares the party selectors with literal selects targets', () => {
    expect(COMMERCE_UI_SLOTS['customer-select']).toMatchObject({
      selects: '@happyvertical/smrt-commerce:Customer',
      propsInterface: 'CustomerSelectProps',
    });
    expect(COMMERCE_UI_SLOTS['vendor-select']).toMatchObject({
      selects: '@happyvertical/smrt-commerce:Vendor',
      propsInterface: 'VendorSelectProps',
    });
  });

  it('emits both selectors into the manifest', () => {
    expect(manifest.uiSelectors['customer-select']).toMatchObject({
      slotId: 'customer-select',
      selects: '@happyvertical/smrt-commerce:Customer',
    });
    expect(manifest.uiSelectors['vendor-select']).toMatchObject({
      slotId: 'vendor-select',
      selects: '@happyvertical/smrt-commerce:Vendor',
    });
  });

  it('resolves a selector for each model, and none for others', () => {
    const host = { uiSelectors: manifest.uiSelectors } as never;
    expect(
      findSelectorFor(host, '@happyvertical/smrt-commerce:Customer')?.slotId,
    ).toBe('customer-select');
    expect(
      findSelectorFor(host, '@happyvertical/smrt-commerce:Vendor')?.slotId,
    ).toBe('vendor-select');
    expect(
      findSelectorFor(host, '@happyvertical/smrt-commerce:Invoice'),
    ).toBeUndefined();
  });
});

describe('commerce field widget hints', () => {
  it('hints long text as textarea', () => {
    expect(widgetOf('Contract', 'terms')).toBe('textarea');
    expect(widgetOf('Contract', 'notes')).toBe('textarea');
    expect(widgetOf('Order', 'terms')).toBe('textarea');
    expect(widgetOf('Customer', 'notes')).toBe('textarea');
    expect(widgetOf('Vendor', 'notes')).toBe('textarea');
    expect(widgetOf('Invoice', 'notes')).toBe('textarea');
  });

  it('hints currency codes as currency, and never an amount', () => {
    for (const [model, field] of [
      ['Contract', 'currency'],
      ['Vendor', 'currency'],
      ['Invoice', 'currency'],
      ['Payment', 'currency'],
    ]) {
      expect(widgetOf(model, field)).toBe('currency');
    }
    expect(widgetOf('Contract', 'totalAmount')).toBeUndefined();
  });

  it('hints vendor contact email and phone', () => {
    expect(widgetOf('Vendor', 'defaultContactEmail')).toBe('email');
    expect(widgetOf('Vendor', 'defaultContactPhone')).toBe('phone');
  });
});
