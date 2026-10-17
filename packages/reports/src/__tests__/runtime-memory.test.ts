/**
 * In-memory runner edges the SQL parity matrix does not reach (#4100).
 */
import { describe, expect, it } from 'vitest';
import {
  type RuntimeReportMemorySource,
  runRuntimeReportInMemory,
} from '../runtime-memory.js';
import { parseRuntimeReportSpec, RuntimeReportError } from '../runtime-spec.js';

const sources: RuntimeReportMemorySource[] = [
  {
    id: 'notes',
    schema: [
      { name: 'a', type: 'string' },
      { name: 'b', type: 'string' },
      { name: 'n', type: 'integer' },
    ],
  },
];

describe('runRuntimeReportInMemory', () => {
  it('keeps tuples apart when a value contains a delimiter', async () => {
    const spec = parseRuntimeReportSpec({
      title: 'Pairs',
      source: 'notes',
      dimensions: [{ field: 'a' }, { field: 'b' }],
      measures: [{ fn: 'count' }],
    });
    const result = await runRuntimeReportInMemory(
      spec,
      [
        { a: 'a|string:b', b: 'c' },
        { a: 'a', b: 'b|string:c' },
      ],
      { sources },
    );
    expect(result.rows).toHaveLength(2);
  });

  it('refuses integers past the safe range instead of merging them', async () => {
    const spec = parseRuntimeReportSpec({
      title: 'Distinct',
      source: 'notes',
      measures: [{ fn: 'countDistinct', field: 'n' }],
    });
    await expect(
      runRuntimeReportInMemory(
        spec,
        [{ n: 9007199254740992n }, { n: 9007199254740993n }],
        { sources },
      ),
    ).rejects.toBeInstanceOf(RuntimeReportError);
  });
});
