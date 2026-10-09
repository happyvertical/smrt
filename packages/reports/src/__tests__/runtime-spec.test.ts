import { describe, expect, it } from 'vitest';
import {
  parseRuntimeReportSpec,
  RUNTIME_REPORT_LIMITS,
  RuntimeReportError,
  runtimeReportSpecHash,
  serializeRuntimeReportSpec,
} from '../runtime-spec.js';

const base = () => ({
  title: 'Revenue by status',
  source: 'invoices',
  dimensions: [{ field: 'status' }],
  measures: [{ fn: 'sum', field: 'totalAmount', as: 'revenue' }],
});

function reject(input: unknown, path?: string): RuntimeReportError {
  try {
    parseRuntimeReportSpec(input);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeReportError);
    if (path) expect((error as RuntimeReportError).path).toBe(path);
    return error as RuntimeReportError;
  }
  throw new Error('expected the spec to be rejected');
}

describe('parseRuntimeReportSpec', () => {
  it('normalizes defaults and derives aliases', () => {
    const spec = parseRuntimeReportSpec({
      title: ' Monthly revenue ',
      source: 'invoices',
      dimensions: [{ field: 'issuedAt', bucket: 'month' }, { field: 'status' }],
      measures: [{ fn: 'count' }, { fn: 'avg', field: 'totalAmount' }],
    });
    expect(spec).toMatchObject({
      version: 1,
      title: 'Monthly revenue',
      limit: RUNTIME_REPORT_LIMITS.defaultRowLimit,
      filters: [],
      having: [],
      sort: [],
      chart: { type: 'table' },
    });
    expect(spec.dimensions.map((d) => d.as)).toEqual([
      'issued_at_month',
      'status',
    ]);
    expect(spec.measures.map((m) => m.as)).toEqual([
      'row_count',
      'avg_total_amount',
    ]);
  });

  it('accepts the JSON string form and hashes equal specs equally', () => {
    const a = parseRuntimeReportSpec(JSON.stringify(base()));
    const b = parseRuntimeReportSpec({
      measures: base().measures,
      dimensions: base().dimensions,
      source: 'invoices',
      title: 'Revenue by status',
    });
    expect(runtimeReportSpecHash(a)).toBe(runtimeReportSpecHash(b));
    expect(serializeRuntimeReportSpec(a)).toBe(serializeRuntimeReportSpec(b));
    expect(parseRuntimeReportSpec(serializeRuntimeReportSpec(a))).toEqual(a);
    const changed = parseRuntimeReportSpec({ ...base(), limit: 5 });
    expect(runtimeReportSpecHash(changed)).not.toBe(runtimeReportSpecHash(a));
  });

  it('accepts filters, having, sort and chart hints', () => {
    const spec = parseRuntimeReportSpec({
      ...base(),
      filters: [
        { field: 'status', op: 'in', value: ['paid', 'open'] },
        { field: 'deletedAt', op: 'isNull' },
        { field: 'totalAmount', op: 'gte', value: 100 },
      ],
      having: [{ measure: 'revenue', op: 'gt', value: 0 }],
      sort: [{ by: 'revenue', direction: 'desc' }],
      limit: 10,
      chart: { type: 'bar', x: 'status', y: ['revenue'] },
    });
    expect(spec.chart).toEqual({ type: 'bar', x: 'status', y: ['revenue'] });
    expect(spec.sort).toEqual([{ by: 'revenue', direction: 'desc' }]);
  });

  describe('rejects structure that could smuggle code', () => {
    it.each([
      ['non-object', 'SELECT 1'],
      ['array', []],
      ['null', null],
    ])('%s', (_name, input) => {
      reject(input);
    });

    it('unknown top-level keys (raw where/sql/table/tenant)', () => {
      for (const key of [
        'where',
        'sql',
        'table',
        'from',
        'tenantId',
        'permissions',
        'groupBy',
        'having_sql',
        '__proto__',
        'constructor',
      ]) {
        const input = JSON.parse(
          JSON.stringify({ ...base() }).replace(
            /^\{/,
            `{${JSON.stringify(key)}:"1=1",`,
          ),
        );
        reject(input, `spec.${key}`);
      }
    });

    it('unknown nested keys', () => {
      reject(
        {
          ...base(),
          dimensions: [{ field: 'status', expression: 'lower(status)' }],
        },
        'spec.dimensions[0].expression',
      );
      reject(
        {
          ...base(),
          filters: [{ field: 'status', op: 'eq', value: 'a', raw: '1=1' }],
        },
        'spec.filters[0].raw',
      );
    });

    it.each([
      'status; DROP TABLE invoices',
      'status--',
      'a.b',
      'a b',
      '"status"',
      "status'",
      '1status',
      'status)',
      '',
      '*',
      'lower(status)',
      'a'.repeat(65),
    ])('field name %j', (field) => {
      reject({ ...base(), dimensions: [{ field }] });
      reject({
        ...base(),
        filters: [{ field, op: 'eq', value: 'x' }],
      });
      reject({ ...base(), measures: [{ fn: 'sum', field, as: 'x' }] });
    });

    it.each([
      'x" OR 1=1 --',
      'Revenue',
      'x y',
      'x;y',
      '1x',
      'select',
      'order',
      'group',
      'null',
      'x'.repeat(41),
    ])('alias %j', (as) => {
      reject({
        ...base(),
        measures: [{ fn: 'sum', field: 'totalAmount', as }],
      });
      reject({
        ...base(),
        dimensions: [{ field: 'status', as }],
      });
    });

    it.each([
      'invoices; DROP TABLE x',
      'a b',
      "x'",
      '../etc/passwd',
      '',
      'x'.repeat(121),
    ])('source id %j', (source) => {
      reject({ ...base(), source });
    });

    it('unknown functions, operators, buckets and chart types', () => {
      reject({
        ...base(),
        measures: [{ fn: 'sum(x) --', field: 'a', as: 'x' }],
      });
      reject({ ...base(), measures: [{ fn: 'median', field: 'a', as: 'x' }] });
      reject({
        ...base(),
        filters: [{ field: 'status', op: 'like', value: '%' }],
      });
      reject({
        ...base(),
        filters: [{ field: 'status', op: '= 1 OR 1 =', value: 'x' }],
      });
      reject({
        ...base(),
        dimensions: [{ field: 'issuedAt', bucket: 'century' }],
      });
      reject({ ...base(), chart: { type: 'iframe' } });
    });
  });

  describe('rejects malformed values', () => {
    it('non-scalar and oversized filter values', () => {
      reject({
        ...base(),
        filters: [{ field: 'status', op: 'eq', value: { $ne: null } }],
      });
      reject({
        ...base(),
        filters: [{ field: 'status', op: 'eq', value: ['a'] }],
      });
      reject({
        ...base(),
        filters: [{ field: 'status', op: 'in', value: 'a' }],
      });
      reject({
        ...base(),
        filters: [{ field: 'status', op: 'in', value: [] }],
      });
      reject({
        ...base(),
        filters: [
          {
            field: 'status',
            op: 'in',
            value: Array.from(
              { length: RUNTIME_REPORT_LIMITS.maxInValues + 1 },
              (_, i) => `v${i}`,
            ),
          },
        ],
      });
      reject({
        ...base(),
        filters: [
          {
            field: 'status',
            op: 'eq',
            value: 'x'.repeat(RUNTIME_REPORT_LIMITS.maxStringValueLength + 1),
          },
        ],
      });
      reject({
        ...base(),
        filters: [{ field: 'totalAmount', op: 'eq', value: Number.NaN }],
      });
      reject({
        ...base(),
        filters: [{ field: 'totalAmount', op: 'eq', value: Infinity }],
      });
      reject({
        ...base(),
        filters: [{ field: 'status', op: 'eq', value: 'a\u0000b' }],
      });
      reject({
        ...base(),
        filters: [{ field: 'status', op: 'isNull', value: 'x' }],
      });
      reject({
        ...base(),
        filters: [{ field: 'status', op: 'eq' }],
      });
      reject({
        ...base(),
        filters: [{ field: 'totalAmount', op: 'contains', value: 5 }],
      });
    });

    it('bounds counts and limits', () => {
      reject({ ...base(), limit: 0 });
      reject({ ...base(), limit: RUNTIME_REPORT_LIMITS.maxRowLimit + 1 });
      reject({ ...base(), limit: 1.5 });
      reject({ ...base(), limit: '10' });
      reject({ ...base(), measures: [] });
      reject({
        ...base(),
        dimensions: Array.from({ length: 5 }, (_, i) => ({
          field: 'status',
          as: `d${i}`,
        })),
      });
      reject({
        ...base(),
        filters: Array.from({ length: 13 }, () => ({
          field: 'status',
          op: 'eq',
          value: 'a',
        })),
      });
    });

    it('control characters and oversized text in title/description', () => {
      reject({ ...base(), title: 'a\u0007b' });
      reject({ ...base(), title: '   ' });
      reject({ ...base(), title: 'x'.repeat(121) });
      reject({ ...base(), description: 'x'.repeat(501) });
      reject('x'.repeat(70 * 1024));
      reject('{not json');
    });
  });

  describe('alias hygiene', () => {
    it('duplicate aliases across dimensions and measures', () => {
      reject({
        ...base(),
        dimensions: [{ field: 'status', as: 'x' }],
        measures: [{ fn: 'count', as: 'x' }],
      });
      reject({
        ...base(),
        dimensions: [
          { field: 'status', as: 'x' },
          { field: 'customerId', as: 'x' },
        ],
      });
    });

    it('sort, having and chart must reference declared aliases', () => {
      reject({ ...base(), sort: [{ by: 'nope', direction: 'asc' }] });
      reject({
        ...base(),
        having: [{ measure: 'status', op: 'gt', value: 1 }],
      });
      reject({ ...base(), chart: { type: 'bar', x: 'revenue' } });
      reject({ ...base(), chart: { type: 'bar', y: ['status'] } });
    });

    it('requires a field for every aggregate but a plain count', () => {
      reject({ ...base(), measures: [{ fn: 'sum', as: 'x' }] });
      reject({ ...base(), measures: [{ fn: 'countDistinct', as: 'x' }] });
      expect(
        parseRuntimeReportSpec({ ...base(), measures: [{ fn: 'count' }] })
          .measures,
      ).toEqual([{ fn: 'count', as: 'row_count' }]);
    });
  });
});
