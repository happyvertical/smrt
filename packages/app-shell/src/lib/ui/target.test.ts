import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  decideApproval,
  records,
  runMethodTool,
  undoPublish,
} from './api.ts';
import { loadDescription, loadRecords, loadReferences } from './load.ts';
import { targetPath } from './target.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());
describe('explicit request copies', () => {
  it('preserves queries and safely replaces target; app REST query belongs to the app', () => {
    expect(targetPath('/api/shell/history?limit=5&target=live', 'draft')).toBe(
      '/api/shell/history?limit=5&target=draft',
    );
    expect(targetPath('/api/app/orders?target=app-filter', 'draft')).toBe(
      '/api/app/orders?target=app-filter',
    );
  });
  it('names the target on description, lists, record references and all record mutations', async () => {
    const fetcher = vi.fn(async () => json({ records: [] }));
    vi.stubGlobal('fetch', fetcher);
    await loadDescription(fetcher, 'draft');
    await loadRecords(fetcher, 'Order', 50, 'draft');
    await loadReferences(
      fetcher,
      { order: { type: 'reference', ref: 'Order' } },
      { Order: {} } as never,
      'draft',
    );
    await records.create('Order', { name: 'A' }, 'draft');
    await records.update('Order', 'one', { name: 'B' }, 'draft');
    await records.remove('Order', 'one', 'draft');
    expect(fetcher).toHaveBeenCalledTimes(6);
    for (const [path] of fetcher.mock.calls as unknown as [string][])
      expect(new URL(path, 'http://shell').searchParams.get('target')).toBe(
        'draft',
      );
  });
  it('uses the app REST header and leaves the app query alone', async () => {
    const fetcher = vi.fn(async () => json({}));
    await api('/api/app/orders?limit=10', { fetch: fetcher, target: 'draft' });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/app/orders?limit=10',
      expect.objectContaining({ headers: { 'x-shell-target': 'draft' } }),
    );
  });
  it('names the method copy and keeps approvals on live', async () => {
    const fetcher = vi.fn(async () => json({ result: { content: [] } }));
    vi.stubGlobal('fetch', fetcher);
    await runMethodTool('Order', 'total', {}, fetcher, 'draft');
    await decideApproval('one', true);
    await undoPublish(1, 'draft');
    expect(fetcher.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual([
      '/mcp?target=draft',
      '/api/shell/approvals/one?target=live',
      '/api/shell/undo-to?target=draft',
    ]);
  });
});
