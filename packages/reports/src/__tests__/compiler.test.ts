import { ObjectRegistry, SmrtObject } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildReportDefinition,
  compileReportDefinition,
  getReportGroupingColumns,
} from '../compiler.js';

class CompilerInvoice extends SmrtObject {}
class CompilerRevenueReport extends SmrtObject {}
class CompilerBrokenReport extends SmrtObject {}

function registerSource() {
  ObjectRegistry.registerFromManifest(
    'CompilerInvoice',
    {
      className: 'CompilerInvoice',
      fields: {
        customerId: { type: 'text' },
        issuedAt: { type: 'datetime' },
        totalAmount: { type: 'decimal' },
        status: { type: 'text' },
      },
      methods: {},
      decoratorConfig: { tableName: 'compiler_invoices' },
      schema: {
        tableName: 'compiler_invoices',
        ddl: '',
        columns: {},
        indexes: [],
        version: 'test',
      },
    },
    '@test/reports',
  );
}

function registerRevenueReport() {
  ObjectRegistry.registerFromManifest(
    'CompilerRevenueReport',
    {
      className: 'CompilerRevenueReport',
      fields: {
        customerId: {
          type: 'text',
          _meta: { __report: { kind: 'group', sourceColumn: 'customerId' } },
        },
        issuedMonth: {
          type: 'datetime',
          _meta: {
            __report: {
              kind: 'bucket',
              unit: 'month',
              sourceColumn: 'issuedAt',
            },
          },
        },
        revenue: {
          type: 'decimal',
          _meta: {
            __report: {
              kind: 'aggregate',
              fn: 'sum',
              column: 'totalAmount',
            },
          },
        },
        paidInvoices: {
          type: 'integer',
          _meta: { __report: { kind: 'aggregate', fn: 'count' } },
        },
        refreshedAt: { type: 'datetime' },
      },
      methods: {},
      decoratorConfig: {
        tableName: 'compiler_revenue_reports',
        report: {
          source: 'CompilerInvoice',
          where: { status: 'paid' },
          having: { 'revenue >': 0 },
          refresh: { manual: true },
        },
      },
      schema: {
        tableName: 'compiler_revenue_reports',
        ddl: '',
        columns: {},
        indexes: [],
        version: 'test',
      },
    },
    '@test/reports',
  );
}

describe('report compiler', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
    registerSource();
  });

  afterEach(() => {
    ObjectRegistry.clear();
  });

  it('builds a report definition from manifest metadata', async () => {
    registerRevenueReport();

    const definition = await buildReportDefinition(CompilerRevenueReport);

    expect(definition).toMatchObject({
      reportClassName: '@test/reports:CompilerRevenueReport',
      sourceClassName: 'CompilerInvoice',
      sourceTable: 'compiler_invoices',
      refresh: { manual: true },
    });
    expect(definition.fields.map((field) => field.fieldName)).toEqual([
      'customerId',
      'issuedMonth',
      'revenue',
      'paidInvoices',
    ]);
  });

  it('compiles report metadata into a portable aggregate spec', async () => {
    registerRevenueReport();

    const spec = compileReportDefinition(
      await buildReportDefinition(CompilerRevenueReport),
    );

    expect(spec).toEqual({
      from: 'compiler_invoices',
      select: [
        { column: 'customer_id', as: 'customer_id' },
        { bucket: 'month', column: 'issued_at', as: 'issued_month' },
        {
          fn: 'sum',
          column: 'total_amount',
          as: 'revenue',
          distinct: undefined,
        },
        {
          fn: 'count',
          column: undefined,
          as: 'paid_invoices',
          distinct: undefined,
        },
      ],
      groupBy: ['customer_id', 'issued_month'],
      where: { status: 'paid' },
      having: { 'revenue >': 0 },
    });
    expect(
      getReportGroupingColumns(
        await buildReportDefinition(CompilerRevenueReport),
      ),
    ).toEqual(['customer_id', 'issued_month']);
  });

  it('rejects non-system report fields without report metadata', async () => {
    ObjectRegistry.registerFromManifest(
      'CompilerBrokenReport',
      {
        className: 'CompilerBrokenReport',
        fields: {
          plainMetric: { type: 'integer' },
        },
        methods: {},
        decoratorConfig: {
          tableName: 'compiler_broken_reports',
          report: { source: 'CompilerInvoice' },
        },
      },
      '@test/reports',
    );

    await expect(buildReportDefinition(CompilerBrokenReport)).rejects.toThrow(
      /neither a grouping key nor an aggregate/,
    );
  });
});
