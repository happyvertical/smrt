import {
  ObjectRegistry,
  planRuntimeModelDDL,
  registerRuntimeModel,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  compileRuntimeReportSpec,
  runRuntimeReport,
} from '../runtime-compiler.js';
import { parseRuntimeReportSpec } from '../runtime-spec.js';

describe('runtime report over database-generated fields #4915', () => {
  const engines =
    process.env.SMRT_TEST_PGLITE === '1'
      ? (['postgres'] as const)
      : (['sqlite'] as const);
  for (const engine of engines) {
    it(`${engine}: sums and groups a generated field from a runtime model`, async () => {
      ObjectRegistry.clear();
      const db = await getTestDatabase({
        type: engine === 'sqlite' ? 'sqlite' : 'pglite',
        classes: [],
      });
      try {
        const name = registerRuntimeModel({
          name: 'GeneratedReportLine',
          packageName: '@test/generated-report',
          fields: {
            category: { type: 'text' },
            qty: { type: 'integer' },
            price: { type: 'integer' },
            total: {
              type: 'integer',
              generated: {
                op: 'mul',
                left: { col: 'qty' },
                right: { col: 'price' },
              },
            },
          },
        });
        for (const sql of await planRuntimeModelDDL(
          name,
          engine,
          async () => null,
        ))
          await db.query(sql);
        const lines = await ObjectRegistry.getCollection(name, { db });
        await lines.create({ category: 'parts', qty: 2, price: 50 });
        await lines.create({ category: 'parts', qty: 3, price: 10 });
        const source = { id: 'lines', className: name, label: 'Lines' };
        const spec = parseRuntimeReportSpec({
          title: 'Generated totals',
          source: 'lines',
          dimensions: [{ field: 'category' }],
          measures: [{ fn: 'sum', field: 'total', as: 'total' }],
        });
        const compiled = await compileRuntimeReportSpec(spec, {
          sources: [source],
          tenantId: null,
        });
        const result = await runRuntimeReport(compiled, {
          db,
          adapterType: engine,
        });
        expect(result.rows).toEqual([{ category: 'parts', total: 130 }]);
        const grouped = await compileRuntimeReportSpec(
          parseRuntimeReportSpec({
            title: 'Generated dimension',
            source: 'lines',
            dimensions: [{ field: 'total' }],
            measures: [{ fn: 'count', as: 'count' }],
          }),
          { sources: [source], tenantId: null },
        );
        expect(
          (await runRuntimeReport(grouped, { db, adapterType: engine })).rows,
        ).toHaveLength(2);
      } finally {
        await db.close();
        ObjectRegistry.clear();
      }
    });
  }
});

it('keeps an ordered limited SQLite report numeric after casting integer output', async () => {
  ObjectRegistry.clear();
  const db = await getTestDatabase({ type: 'sqlite', classes: [] });
  try {
    const name = registerRuntimeModel({
      name: 'OrderedReportLine',
      packageName: '@test/ordered-report',
      fields: { category: { type: 'text' }, amount: { type: 'integer' } },
    });
    for (const sql of await planRuntimeModelDDL(
      name,
      'sqlite',
      async () => null,
    ))
      await db.query(sql);
    const lines = await ObjectRegistry.getCollection(name, { db });
    for (const amount of [100, 2, 10, 9])
      await lines.create({ category: `c${amount}`, amount });
    const query = vi.spyOn(db, 'query');
    for (const direction of ['asc', 'desc'] as const) {
      const compiled = await compileRuntimeReportSpec(
        parseRuntimeReportSpec({
          title: 'Ordered limited',
          source: 'lines',
          dimensions: [{ field: 'category' }],
          measures: [{ fn: 'sum', field: 'amount', as: 'total' }],
          sort: [{ by: 'total', direction }],
          limit: 3,
        }),
        {
          sources: [{ id: 'lines', className: name, label: 'Lines' }],
          tenantId: null,
        },
      );
      const result = await runRuntimeReport(compiled, {
        db,
        adapterType: 'sqlite',
      });
      expect(result.rows.map((row) => row.total)).toEqual(
        direction === 'asc' ? [2, 9, 10] : [100, 10, 9],
      );
      expect(result.truncated).toBe(true);
      expect(query.mock.calls.at(-1)?.[0]).toContain(
        `AS "_smrt_report_result" ORDER BY "_smrt_report_result"."r_total" ${direction.toUpperCase()}`,
      );
    }
  } finally {
    await db.close();
    ObjectRegistry.clear();
  }
});
