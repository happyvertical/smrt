import { describe, expect, it } from 'vitest';

import { parseMaterializedReportDrilldown } from '../template/src/lib/materialized-report-drilldown.js';

const presentation = {
  version: 1,
  selectedMeasure: { id: 'tax_minor', label: 'Tax collected' },
  currency: 'CAD',
  complete: false,
  contributors: [
    {
      id: 'invoice-a',
      source: 'Invoice',
      identity: 'INV-1',
      date: '2026-09-01',
      party: 'Acme',
      values: { valueMinor: 4050, taxableMinor: 81000, taxMinor: 4050 },
    },
  ],
  warnings: [
    { code: 'source-state-diverged', kind: 'drift', message: 'Source data changed.' },
  ],
} as const;

describe('parseMaterializedReportDrilldown', () => {
  it('preserves a complete versioned host presentation', () => {
    expect(parseMaterializedReportDrilldown(presentation)).toEqual(presentation);
  });

  it.each([
    [{ ...presentation, currency: 'Canadian dollars' }],
    [{ ...presentation, contributors: [{ ...presentation.contributors[0], values: { taxMinor: 1.5 } }] }],
    [{ ...presentation, warnings: [{ code: 'unknown', kind: 'other', message: 'Unknown state.' }] }],
    [{ ...presentation, selectedMeasure: { id: '', label: 'Tax collected' } }],
    [{ ...presentation, version: 2 }],
  ])('rejects an invalid presentation %#', (value) => {
    expect(parseMaterializedReportDrilldown(value)).toBeUndefined();
  });
});
