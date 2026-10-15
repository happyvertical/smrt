import { describe, expect, it } from 'vitest';
import {
  type CommerceLineAmountsReport,
  serializeCommerceLineAmountsReportCsv,
  serializeCommerceLineAmountsReportJson,
} from '../migrations/commerceLineAmounts.js';

function report(): CommerceLineAmountsReport {
  return {
    version: 1,
    documents: [
      {
        tenantId: 'tenant-z',
        documentType: 'invoice',
        documentId: 'invoice-2',
        status: 'SENT',
        arJournalIdSet: true,
        old: { subtotalMinor: 100, taxMinor: 5, totalMinor: 105 },
        next: { subtotalMinor: 100, taxMinor: 5, totalMinor: 105 },
        delta: { subtotalMinor: 0, taxMinor: 0, totalMinor: 0 },
        reasons: ['UNRECONCILED', 'ISSUED_BACKFILLED', 'UNRECONCILED'],
      },
      {
        tenantId: 'tenant-a',
        documentType: 'contract',
        documentId: 'contract,1',
        status: 'DRAFT',
        arJournalIdSet: false,
        old: { subtotalMinor: -101, taxMinor: -5, totalMinor: -106 },
        next: { subtotalMinor: -100, taxMinor: -5, totalMinor: -105 },
        delta: { subtotalMinor: 1, taxMinor: 0, totalMinor: 1 },
        reasons: ['NEGATIVE_HALF_UNIT_GROSS', 'DRAFT_RECOMPUTED'],
      },
    ],
    tenants: [
      {
        tenantId: 'tenant-z',
        documentCount: 1,
        changingDraftCount: 0,
        issuedUnpostedFallbackTaxCount: 0,
        reasonCounts: { UNRECONCILED: 1, ISSUED_BACKFILLED: 1 },
      },
      {
        tenantId: 'tenant-a',
        documentCount: 1,
        changingDraftCount: 1,
        issuedUnpostedFallbackTaxCount: 0,
        reasonCounts: {
          NEGATIVE_HALF_UNIT_GROSS: 1,
          DRAFT_RECOMPUTED: 1,
        },
      },
    ],
  };
}

describe('commerce line-amount report serializers (#3933)', () => {
  it('returns deterministic canonical JSON without mutating input', () => {
    const input = report();
    const before = structuredClone(input);
    const first = serializeCommerceLineAmountsReportJson(input);
    const second = serializeCommerceLineAmountsReportJson(input);
    expect(second).toBe(first);
    expect(input).toEqual(before);
    const parsed = JSON.parse(first) as CommerceLineAmountsReport;
    expect(parsed.documents.map((row) => row.documentId)).toEqual([
      'contract,1',
      'invoice-2',
    ]);
    expect(parsed.documents[0].reasons).toEqual([
      'DRAFT_RECOMPUTED',
      'NEGATIVE_HALF_UNIT_GROSS',
    ]);
    expect(parsed.documents[1].reasons).toEqual([
      'ISSUED_BACKFILLED',
      'UNRECONCILED',
    ]);
  });

  it('writes fixed-column CSV with quoting and signed minor units', () => {
    const csv = serializeCommerceLineAmountsReportCsv(report());
    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('deltaTotalMinor,reasons');
    expect(lines[1]).toContain('tenant-a,contract,"contract,1",DRAFT,false');
    expect(lines[1]).toContain(',-101,-5,-106,-100,-5,-105,1,0,1,');
    expect(lines[1]).toContain('DRAFT_RECOMPUTED|NEGATIVE_HALF_UNIT_GROSS');
  });

  it('rejects duplicate documents, unsafe money and unknown reasons', () => {
    const duplicate = report();
    duplicate.documents.push(structuredClone(duplicate.documents[0]));
    expect(() => serializeCommerceLineAmountsReportJson(duplicate)).toThrow(
      /Duplicate report document/,
    );

    const unsafe = report();
    unsafe.documents[0].old.taxMinor = Number.MAX_SAFE_INTEGER + 1;
    expect(() => serializeCommerceLineAmountsReportJson(unsafe)).toThrow(
      /safe integer minor units/,
    );

    const unknown = report();
    unknown.documents[0].reasons = ['UNKNOWN' as never];
    expect(() => serializeCommerceLineAmountsReportJson(unknown)).toThrow(
      /Unknown commerce line-amount reason code/,
    );
  });
});
