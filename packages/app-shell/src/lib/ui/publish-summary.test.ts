import { describe, expect, it } from 'vitest';
import { preview } from '../../test/draft-fixtures.ts';
import {
  isPlumbingSummary,
  publishChanges,
  publishDataTables,
  publishOtherDataLines,
  publishQuietLine,
  publishSummaryGroups,
} from './publish.ts';
import type { PublishPreview } from './types.ts';

const empty = (): PublishPreview => ({
  ...structuredClone(preview),
  methods: [],
  archives: { values: 0, tables: 0 },
  versions: [],
  definition: {
    modelsAdded: [],
    modelsRemoved: [],
    recipesAdded: [],
    recipesRemoved: [],
    models: {},
  },
});

describe('publish summary', () => {
  it('omits zero-count groups and says so in one line', () => {
    const p = structuredClone(preview);
    p.definition.modelsRemoved = [];
    p.definition.models = {};
    p.archives = { values: 0, tables: 0 };
    p.versions = [];
    expect(publishSummaryGroups(p).map((g) => g.name)).toEqual(['Added']);
    expect(publishQuietLine(p)).toBe('Nothing removed, changed or archived.');
    expect(publishQuietLine(preview)).toBeNull();
    expect(publishQuietLine(empty())).toBe('No changes to publish.');
  });

  it('builds one table per loaded model with only non-zero counts', () => {
    const p = empty();
    p.fields = {
      Order: {
        workbookRow: { type: 'integer' },
        workbookLookup: { type: 'text' },
        secret: { type: 'text', hidden: true },
        item: { type: 'text', label: 'Item' },
      },
    };
    p.modelLabels = { Order: 'Orders' };
    p.versions = [
      {
        version: 2,
        summary: 'Load',
        statements: [],
        steps: [],
        dataSteps: [
          {
            op: 'loadRecords',
            model: 'Order',
            mode: 'insert',
            counts: { insert: 1, update: 0, unchanged: 0, rejected: 0 },
          },
          {
            op: 'loadRecords',
            model: 'Order',
            mode: 'upsert',
            counts: { insert: 4, update: 2, unchanged: 0, rejected: 1 },
          },
        ],
      },
    ];
    const [table] = publishDataTables(p);
    expect(table).toMatchObject({
      model: 'Order',
      label: 'Orders',
      inserted: 5,
      sentence: '5 records added, 2 updated, 1 skipped',
    });
    expect(table.columns.map((c) => c.key)).toEqual(['item']);
    expect(publishOtherDataLines(p)).toEqual([]);
  });

  it('uses the singular for one record and never prints a zero wall', () => {
    const p = empty();
    p.versions = [
      {
        version: 2,
        summary: 'Load',
        statements: [],
        steps: [],
        dataSteps: [
          {
            op: 'loadRecords',
            model: 'Order',
            mode: 'insert',
            counts: { insert: 1, update: 0, unchanged: 0, rejected: 0 },
          },
        ],
      },
    ];
    expect(publishDataTables(p)[0].sentence).toBe('1 record added');
  });

  it('drops importer bookkeeping from the ordered changes', () => {
    expect(isPlumbingSummary('Hide field: Workbook row in Orders')).toBe(true);
    expect(isPlumbingSummary('Hide field: Workbook lookup in Orders')).toBe(
      true,
    );
    expect(isPlumbingSummary('Hide field: Notes in Orders')).toBe(false);
    const p = empty();
    p.versions = [
      'Hide field: Workbook row in Orders',
      'Add model: Orders',
    ].map((humanSummary, i) => ({
      version: i + 2,
      summary: humanSummary,
      humanSummary,
      statements: [],
      steps: [],
    }));
    expect(publishChanges(p).map((c) => c.text)).toEqual(['Add model: Orders']);
  });
});
