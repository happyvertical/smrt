import { describe, expect, it } from 'vitest';
import { bucketExpr, buildAggregate } from '../aggregate.js';

describe('report aggregate SQL builder', () => {
  it('builds grouped aggregate SQL with where, having, order, and paging', () => {
    const result = buildAggregate(
      {
        from: 'invoices',
        select: [
          { column: 'customer_id', as: 'customer_id' },
          { bucket: 'month', column: 'issued_at', as: 'issued_month' },
          { fn: 'sum', column: 'total_amount', as: 'revenue' },
          { fn: 'count', as: 'invoice_count' },
        ],
        where: {
          status: 'paid',
          'issued_at >=': new Date('2026-01-01T00:00:00Z'),
        },
        groupBy: ['customer_id', 'issued_month'],
        having: { 'revenue >': 1000 },
        orderBy: ['issued_month DESC', 'revenue DESC'],
        limit: 10,
        offset: 20,
      },
      1,
      'sqlite',
    );

    expect(result.sql).toBe(
      "SELECT customer_id AS customer_id, strftime('%Y-%m-01 00:00:00', issued_at) AS issued_month, SUM(total_amount) AS revenue, COUNT(*) AS invoice_count FROM invoices WHERE status = $1 AND issued_at >= $2 GROUP BY customer_id, strftime('%Y-%m-01 00:00:00', issued_at) HAVING SUM(total_amount) > $3 ORDER BY issued_month DESC, revenue DESC LIMIT $4 OFFSET $5",
    );
    expect(result.values).toEqual([
      'paid',
      '2026-01-01T00:00:00.000Z',
      1000,
      10,
      20,
    ]);
  });

  it('supports date buckets across adapters', () => {
    expect(bucketExpr('postgres', 'day', 'created_at')).toBe(
      "date_trunc('day', created_at)",
    );
    expect(bucketExpr('duckdb', 'quarter', 'created_at')).toBe(
      "date_trunc('quarter', created_at)",
    );
    expect(bucketExpr('sqlite', 'week', 'created_at')).toBe(
      "date(created_at, printf('-%d days', (CAST(strftime('%w', created_at) AS INTEGER) + 6) % 7))",
    );
  });

  it('rejects unsafe identifiers before SQL generation', () => {
    expect(() =>
      buildAggregate({
        from: 'invoices; drop table users',
        select: [{ fn: 'count', as: 'count' }],
      }),
    ).toThrow(/Invalid column name|invalid/i);
  });
});
