import { describe, expect, it } from 'vitest';
import { catalog } from '../src/lib/catalog/index.ts';
import type { CatalogModel } from '../src/lib/catalog/types.ts';
import {
  blankRecord,
  errorSummary,
  missingRequired,
} from '../src/lib/data/columns.ts';
import { fakeRecords } from '../src/lib/data/fakes.ts';
import { formatValue } from '../src/lib/data/format.ts';
import {
  fractionToPercent,
  percentToFraction,
} from '../src/lib/fields/percent.ts';
import { chooseRenderer } from '../src/lib/fields/renderer.ts';
import type { ViewField } from '../src/lib/recipes/policy.ts';

const allModels = (): CatalogModel[] => {
  const found: CatalogModel[] = [];
  const walk = (o: unknown) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      const rec = o as Record<string, unknown>;
      if (typeof rec.id === 'string' && Array.isArray(rec.fields))
        found.push(rec as unknown as CatalogModel);
      else Object.values(rec).forEach(walk);
    }
  };
  walk(catalog);
  return found;
};

const time = (value: unknown) => Date.parse(String(value));

describe('sample dates agree with each other', () => {
  const dated = (names: string[]) =>
    allModels().filter((m) =>
      names.every((n) => m.fields.some((f) => f.name === n)),
    );

  it('issue <= due <= expiry wherever a model has them', () => {
    const models = dated(['issueDate', 'dueDate']);
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      for (const row of fakeRecords(m, 25, 3)) {
        expect(time(row.issueDate)).toBeLessThanOrEqual(time(row.dueDate));
        if ('expiryDate' in row) {
          expect(time(row.issueDate)).toBeLessThanOrEqual(time(row.expiryDate));
        }
      }
    }
  });

  it('start <= end and the dates stay deterministic', () => {
    for (const m of dated(['startDate', 'endDate'])) {
      const rows = fakeRecords(m, 20, 5);
      expect(rows).toEqual(fakeRecords(m, 20, 5));
      for (const row of rows) {
        expect(time(row.startDate)).toBeLessThanOrEqual(time(row.endDate));
      }
    }
  });
});

describe('rates are typed as percentages', () => {
  const taxRate = allModels()
    .flatMap((m) => m.fields)
    .find((f) => f.name === 'taxRate');
  if (!taxRate) throw new Error('taxRate');

  it('converts between the typed percentage and the stored fraction', () => {
    expect(fractionToPercent(0.05)).toBe(5);
    expect(fractionToPercent(0.0825)).toBe(8.25);
    expect(percentToFraction(5)).toBe(0.05);
    expect(percentToFraction(8.25)).toBe(0.0825);
    expect(percentToFraction(null)).toBeNull();
    expect(fractionToPercent(undefined)).toBeNull();
  });

  it('uses the percent input and still shows the table as 5%', () => {
    expect(chooseRenderer(taxRate)).toBe('percent');
    expect(formatValue(taxRate, 0.05)).toBe('5%');
  });
});

describe('required-field messages', () => {
  const field = (name: string, label: string, required = true): ViewField =>
    ({ name, label, required, type: 'text' }) as unknown as ViewField;
  const fields = [
    field('customerId', 'Customer'),
    field('issueDate', 'Issue date'),
    field('notes', 'Notes', false),
  ];

  it('names every missing required field', () => {
    const errors = missingRequired(fields, blankRecord(fields));
    expect(errors).toEqual({
      customerId: 'Customer is required.',
      issueDate: 'Issue date is required.',
    });
  });

  it('summarises them near Save and clears as they are fixed', () => {
    const errors = missingRequired(fields, blankRecord(fields));
    expect(errorSummary(fields, errors)).toBe(
      'Cannot save yet: Customer, Issue date are required.',
    );
    delete errors.issueDate;
    expect(errorSummary(fields, errors)).toBe(
      'Cannot save yet: Customer is required.',
    );
    delete errors.customerId;
    expect(errorSummary(fields, errors)).toBe('');
  });
});
