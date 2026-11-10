import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ getTestDatabase: vi.fn() }));

vi.mock('@happyvertical/smrt-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/smrt-core')>()),
  getTestDatabase: database.getTestDatabase,
}));

import { ReferenceReviewHost } from '../reference/review-host.js';

describe('reference review host provisioning', () => {
  afterEach(() => database.getTestDatabase.mockReset());

  it('closes the database if fixture schema provisioning fails', async () => {
    const close = vi.fn();
    database.getTestDatabase.mockResolvedValue({
      query: vi.fn().mockRejectedValue(new Error('schema failed')),
      close,
    } as unknown as DatabaseInterface);

    await expect(
      ReferenceReviewHost.provision('/temporary/review'),
    ).rejects.toThrow('schema failed');

    expect(close).toHaveBeenCalledOnce();
  });

  it('degrades a catalog failure to a hidden picker like the published adapter', async () => {
    const item = { id: 'item-reference', processingState: 'completed' };
    const service = {
      getItem: vi.fn(async () => item),
      listReviews: vi.fn(async () => ({ actions: [] })),
      getCompletedAnalysis: vi.fn(async () => ({
        configuration: { stage: 'interpret' },
        result: { output: { proposals: { suggestions: [] } } },
      })),
      getEvidence: vi.fn(async () => []),
      listReviewerInstructions: vi.fn(async () => []),
      listHandlers: vi.fn(async () => [{ id: 'host:draft', version: '1' }]),
    };
    const host = Object.assign(Object.create(ReferenceReviewHost.prototype), {
      service: async () => ({ service }),
      assignment: async () => ({ assigneeId: null, version: 0 }),
    }) as ReferenceReviewHost;
    const scope = {
      tenantId: 'tenant',
      confidentialScopeId: 'private',
      actorId: 'reviewer',
    } as Parameters<ReferenceReviewHost['load']>[0];

    expect((await host.load(scope, item.id)).catalog).toEqual([
      { id: 'host:draft', version: '1' },
    ]);
    service.listHandlers.mockRejectedValueOnce(
      new Error('Authorized catalog exceeds configured bound'),
    );
    const degraded = await host.load(scope, item.id);
    expect(degraded.catalog).toBeUndefined();
    expect(degraded.availability).toBe('available');
    // The inbox projection never reads the catalog.
    service.listHandlers.mockClear();
    await host.load(scope, item.id, undefined, false);
    expect(service.listHandlers).not.toHaveBeenCalled();
  });
});
