import {
  field,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReportDefinition, compileReportDefinition } from '../compiler.js';
import { count, groupBy, max, report, sum } from '../decorators.js';

describe('report field decorator compatibility', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
  });

  afterEach(() => {
    ObjectRegistry.clear();
  });

  it('preserves group metadata stacked under an exact core field decorator', async () => {
    @smrt({
      packageName: '@fixture/report-source',
      tableName: 'decorator_compatibility_sources_2763',
    })
    class Source extends SmrtObject {
      @field({ type: 'text' })
      name = '';
    }

    @smrt({
      packageName: '@fixture/report-output',
      tableName: 'decorator_compatibility_reports_2763',
    })
    @report({ source: Source })
    class Report extends SmrtObject {
      @field({ type: 'text' })
      @groupBy('name')
      name = '';
    }

    expect(
      ObjectRegistry.getClassByConstructor(Report)?.fields.get('name'),
    ).toMatchObject({
      type: 'text',
      _meta: { __report: { kind: 'group', sourceColumn: 'name' } },
    });
    await expect(buildReportDefinition(Report)).resolves.toMatchObject({
      fields: [
        {
          fieldName: 'name',
          report: { kind: 'group', sourceColumn: 'name' },
        },
      ],
    });
  });

  it('registers joins, row expressions and filtered counts through the decorators', async () => {
    @smrt({
      packageName: '@fixture/report-source',
      tableName: 'decorator_join_orders_3903',
    })
    class JoinOrder extends SmrtObject {
      @field({ type: 'text' })
      title = '';

      @field({ type: 'decimal' })
      estimatedHours = 0;
    }

    @smrt({
      packageName: '@fixture/report-source',
      tableName: 'decorator_join_entries_3903',
    })
    class JoinEntry extends SmrtObject {
      @field({ type: 'text' })
      orderId = '';

      @field({ type: 'boolean' })
      halted = false;

      @field({ type: 'integer' })
      seconds = 0;
    }

    @smrt({
      packageName: '@fixture/report-output',
      tableName: 'decorator_join_reports_3903',
    })
    @report({
      source: JoinEntry,
      joins: { wo: { source: JoinOrder, on: 'orderId' } },
    })
    class JoinReport extends SmrtObject {
      @field({ type: 'text' })
      @groupBy('wo.title')
      title = '';

      @field({ type: 'decimal' })
      @max('wo.estimatedHours')
      estimate = 0;

      @field({ type: 'integer' })
      @count({
        filter: { op: 'eq', left: { col: 'halted' }, right: { value: true } },
      })
      haltedCount = 0;

      @field({ type: 'decimal' })
      @sum({
        expr: { op: 'div', left: { col: 'seconds' }, right: { value: 3600 } },
      })
      hours = 0;
    }

    const spec = compileReportDefinition(
      await buildReportDefinition(JoinReport),
    );
    expect(spec).toMatchObject({
      from: 'decorator_join_entries_3903',
      fromAlias: 'src',
      joins: [
        { table: 'decorator_join_orders_3903', alias: 'wo', type: 'left' },
      ],
    });
    expect(spec.select).toEqual([
      { column: 'wo.title', as: 'title' },
      {
        fn: 'max',
        column: 'wo.estimated_hours',
        as: 'estimate',
        distinct: undefined,
      },
      {
        fn: 'count',
        column: undefined,
        filter: {
          op: 'eq',
          left: { col: 'src.halted' },
          right: { value: true },
        },
        as: 'halted_count',
        distinct: undefined,
      },
      {
        fn: 'sum',
        column: undefined,
        expr: {
          op: 'div',
          left: { col: 'src.seconds' },
          right: { value: 3600 },
        },
        as: 'hours',
        distinct: undefined,
      },
    ]);
  });
});
