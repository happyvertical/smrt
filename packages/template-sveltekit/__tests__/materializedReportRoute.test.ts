import { beforeEach, describe, expect, it } from 'vitest';
import { materializedReportHosts } from '../template/src/lib/server/materialized-reports.js';
import { load } from '../template/src/routes/reports/materialized/[id]/+page.server.js';
import { POST } from '../template/src/routes/reports/materialized/[id]/drilldown/+server.js';

const host = {
  id: 'tax-summary', collection: 'taxsummaryreports', className: 'TaxSummaryReport',
  readPermission: 'taxsummaryreports.read',
  drilldownColumnIds: ['tax_minor'],
  descriptor: async () => ({ reportClassName: 'Tax summary', identityField: 'id', dataTable: { columns: [] } }),
  query: async (context: { tenantId: string }, request: { page: { offset: number; limit: number } }) => {
    if (context.tenantId !== 'tenant-a') throw new Error('wrong tenant');
    return {
      version: 1 as const,
      requestId: 'stub',
      queryFingerprint: 'stub',
      identityField: 'id',
      rows: [{ id: 'a-row' }],
      page: { kind: 'offset' as const, offset: request.page.offset, limit: request.page.limit, hasMore: false },
      total: { kind: 'exact' as const, value: 1 },
      freshness: { state: 'unknown' as const },
      warnings: [],
      truncated: false,
      execution: 'visible' as const,
    };
  },
  drilldown: async (context: { tenantId: string }, cell: { id: string; columnId: string }) => {
    if (context.tenantId !== 'tenant-a' || cell.id !== 'a-row') throw new Error('missing');
    if (cell.columnId !== 'tax_minor') throw new Error('hidden');
    return { contributors: [{ source: 'invoice' }] };
  },
};
const locals = (permissions = ['taxsummaryreports.read'], tenantId: string | null = 'tenant-a') => ({
  user: tenantId ? { id: 'user-a' } : null, tenantId, permissions,
});

beforeEach(() => {
  (materializedReportHosts as unknown as unknown[]).splice(0);
  (materializedReportHosts as unknown as unknown[]).push(host);
});

describe('materialized report route', () => {
  it('gates page loads by authenticated tenant and read permission', async () => {
    const args = (permissions = ['taxsummaryreports.read'], tenantId: string | null = 'tenant-a', id = 'tax-summary', search = '') => ({ locals: locals(permissions, tenantId), params: { id }, url: new URL(`https://app.test/${search}`) });
    await expect(load(args([], null) as never)).rejects.toMatchObject({ status: 401 });
    await expect(load(args([]) as never)).rejects.toMatchObject({ status: 403 });
    await expect(load(args() as never)).resolves.toMatchObject({
      hostId: 'tax-summary',
      page: { totalRows: 1, offset: 0, limit: 50 },
    });
    await expect(load(args(undefined, 'tenant-a', 'unknown') as never)).rejects.toMatchObject({ status: 404 });
    await expect(
      load(args(undefined, 'tenant-a', 'tax-summary', '?offset=25&limit=10') as never),
    ).resolves.toMatchObject({ page: { totalRows: 1, offset: 25, limit: 10 } });
    (materializedReportHosts as unknown as unknown[]).push({
      ...host,
      id: 'unavailable-total',
      query: async () => ({
        version: 1 as const,
        requestId: 'unavailable',
        queryFingerprint: 'unavailable',
        identityField: 'id',
        rows: [],
        page: { kind: 'offset' as const, offset: 0, limit: 50, hasMore: false },
        total: { kind: 'unavailable' as const, reason: 'expensive' },
        freshness: { state: 'unknown' as const },
        warnings: [],
        truncated: false,
        execution: 'visible' as const,
      }),
    });
    await expect(
      load(args(undefined, 'tenant-a', 'unavailable-total') as never),
    ).rejects.toMatchObject({ status: 500 });
  });
  it('rejects malformed, cross-tenant, and hidden-cell drilldowns', async () => {
    const request = (body: unknown) => new Request('https://app.test', { method: 'POST', body: JSON.stringify(body) });
    const call = (body: unknown, tenantId = 'tenant-a') => POST({ request: request(body), locals: locals(['taxsummaryreports.read'], tenantId), params: { id: 'tax-summary' } } as never);
    expect((await POST({ request: request({ id: 'a-row', columnId: 'tax_minor' }), locals: locals([], null), params: { id: 'tax-summary' } } as never)).status).toBe(401);
    expect((await POST({ request: request({ id: 'a-row', columnId: 'tax_minor' }), locals: locals([]), params: { id: 'tax-summary' } } as never)).status).toBe(403);
    expect((await call({})).status).toBe(400);
    expect((await call({ id: 'a-row', columnId: 'tax_minor' }, 'tenant-b')).status).toBe(404);
    expect((await call({ id: 'a-row', columnId: 'currency' })).status).toBe(404);
    expect(await (await call({ id: 'a-row', columnId: 'tax_minor' })).json()).toEqual({ contributors: [{ source: 'invoice' }] });
  });
});
