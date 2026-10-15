import { beforeEach, describe, expect, it } from 'vitest';
import { materializedReportHosts } from '../template/src/lib/server/materialized-reports.js';
import { load } from '../template/src/routes/reports/materialized/[id]/+page.server.js';
import { POST } from '../template/src/routes/reports/materialized/[id]/drilldown/+server.js';

const host = {
  id: 'tax-summary', collection: 'taxsummaryreports', className: 'TaxSummaryReport',
  readPermission: 'taxsummaryreports.read',
  descriptor: async () => ({ reportClassName: 'Tax summary' }),
  query: async (context: { tenantId: string }) => {
    if (context.tenantId !== 'tenant-a') throw new Error('wrong tenant');
    return { rows: [{ id: 'a-row' }], count: 1 };
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
    await expect(load({ locals: locals([], null), params: { id: 'tax-summary' } } as never)).rejects.toMatchObject({ status: 401 });
    await expect(load({ locals: locals([]), params: { id: 'tax-summary' } } as never)).rejects.toMatchObject({ status: 403 });
    await expect(load({ locals: locals(), params: { id: 'tax-summary' } } as never)).resolves.toMatchObject({ hostId: 'tax-summary' });
    await expect(load({ locals: locals(), params: { id: 'unknown' } } as never)).rejects.toMatchObject({ status: 404 });
  });
  it('rejects malformed, cross-tenant, and hidden-cell drilldowns', async () => {
    const request = (body: unknown) => new Request('https://app.test', { method: 'POST', body: JSON.stringify(body) });
    const call = (body: unknown, tenantId = 'tenant-a') => POST({ request: request(body), locals: locals(['taxsummaryreports.read'], tenantId), params: { id: 'tax-summary' } } as never);
    expect((await call({})).status).toBe(400);
    expect((await call({ id: 'a-row', columnId: 'tax_minor' }, 'tenant-b')).status).toBe(404);
    expect((await call({ id: 'a-row', columnId: 'currency' })).status).toBe(404);
    expect(await (await call({ id: 'a-row', columnId: 'tax_minor' })).json()).toEqual({ contributors: [{ source: 'invoice' }] });
  });
});
