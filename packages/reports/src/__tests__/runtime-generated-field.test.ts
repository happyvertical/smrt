import {
  ObjectRegistry,
  planRuntimeModelDDL,
  registerRuntimeModel,
} from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import {
  compileRuntimeReportSpec,
  runRuntimeReport,
} from '../runtime-compiler.js';
import { parseRuntimeReportSpec } from '../runtime-spec.js';

describe('runtime report over database-generated fields #4915', () => {
  for (const engine of ['sqlite', 'postgres'] as const) {
    it(`${engine}: sums and groups a generated field from a runtime model`, async () => {
      ObjectRegistry.clear();
      const db = await getDatabase(
        engine === 'sqlite'
          ? { type: 'sqlite', url: ':memory:' }
          : { type: 'pglite' },
      );
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
