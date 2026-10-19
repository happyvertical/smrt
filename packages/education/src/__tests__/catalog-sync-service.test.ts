import { describe, expect, it, vi } from 'vitest';
import type {
  CatalogSourceRecord,
  CatalogSyncCheckpoint,
  CatalogSyncStore,
} from '../catalog-contracts.js';
import { CatalogSyncService } from '../catalog-sync-service.js';

const record = (stableId: string): CatalogSourceRecord => ({
  providerId: 'im',
  stableId,
  revision: 'v1',
  canonicalUrl: `https://example.test/${stableId}`,
  title: stableId,
  availableFormats: ['pdf'],
  visibility: 'catalog',
  licenseEvidence: { state: 'unknown' },
});

function store(seed?: CatalogSyncCheckpoint): CatalogSyncStore & {
  saved: CatalogSyncCheckpoint[];
  upsert: ReturnType<typeof vi.fn>;
  withdrawUnseen: ReturnType<typeof vi.fn>;
} {
  const saved: CatalogSyncCheckpoint[] = [];
  return {
    saved,
    getCheckpoint: vi.fn(async () => seed),
    saveCheckpoint: vi.fn(async (checkpoint) => void saved.push(checkpoint)),
    upsert: vi.fn(async () => undefined),
    withdrawUnseen: vi.fn(async () => 1),
  };
}

describe('CatalogSyncService', () => {
  it('persists cursor checkpoints and only withdraws after a terminal page', async () => {
    const state = store();
    const adapter = {
      enumerate: vi
        .fn()
        .mockResolvedValueOnce({
          records: [record('one')],
          nextCursor: 'two',
          complete: false,
        })
        .mockResolvedValueOnce({ records: [record('two')], complete: true }),
    };
    const result = await new CatalogSyncService(state).sync('im', adapter);
    expect(result.complete).toBe(true);
    expect(result.withdrawnCount).toBe(1);
    expect(state.upsert).toHaveBeenCalledTimes(2);
    expect(state.saved).toHaveLength(2);
    expect(state.saved[0]).toMatchObject({ cursor: 'two', complete: false });
    expect(state.withdrawUnseen).toHaveBeenCalledOnce();
  });

  it('retains a retryable failed cursor as incomplete and never withdraws', async () => {
    const state = store({
      providerId: 'im',
      cursor: 'resume',
      complete: false,
      importedCount: 3,
      failures: [],
      runId: 'run-1',
    });
    const adapter = {
      enumerate: vi.fn(async () => {
        throw new Error('rate limited');
      }),
    };
    const result = await new CatalogSyncService(state, 1).sync('im', adapter);
    expect(result).toMatchObject({
      complete: false,
      cursor: 'resume',
      importedCount: 3,
    });
    expect(result.failures).toHaveLength(1);
    expect(state.withdrawUnseen).not.toHaveBeenCalled();
    expect(adapter.enumerate).toHaveBeenCalledTimes(2);
  });

  it('rejects an adapter that falsely calls a cursor-bearing page complete', async () => {
    const state = store();
    await expect(
      new CatalogSyncService(state).sync('im', {
        enumerate: async () => ({
          records: [],
          complete: true,
          nextCursor: 'more',
        }),
      }),
    ).rejects.toThrow('terminal catalog page');
    expect(state.withdrawUnseen).not.toHaveBeenCalled();
  });

  it('resumes the persisted generation and withdraws only records unseen at its terminal page', async () => {
    let current: CatalogSyncCheckpoint | undefined;
    const seen = new Map<string, string>([
      ['retained', 'old-run'],
      ['withdrawn', 'old-run'],
    ]);
    const withdrawn: string[] = [];
    const state: CatalogSyncStore = {
      getCheckpoint: async () => current,
      saveCheckpoint: async (value) => {
        current = value;
      },
      upsert: async (value, runId) => {
        seen.set(value.stableId, runId);
      },
      withdrawUnseen: async (_providerId, runId) => {
        for (const [stableId, seenRun] of seen) {
          if (seenRun !== runId) withdrawn.push(stableId);
        }
        return withdrawn.length;
      },
    };
    const first = new CatalogSyncService(state, 0);
    await first.sync('im', {
      enumerate: vi
        .fn()
        .mockResolvedValueOnce({
          records: [record('retained')],
          nextCursor: 'page-2',
          complete: false,
        })
        .mockRejectedValueOnce(new Error('interrupted')),
    });
    expect(current).toMatchObject({ complete: false, cursor: 'page-2' });
    const persistedRun = current?.runId;
    expect(persistedRun).toBeTruthy();
    await new CatalogSyncService(state).sync('im', {
      enumerate: async ({ cursor }) => {
        expect(cursor).toBe('page-2');
        return { records: [record('terminal')], complete: true };
      },
    });
    expect(seen.get('retained')).toBe(persistedRun);
    expect(withdrawn).toEqual(['withdrawn']);
    expect(current).toMatchObject({ complete: true });
    expect(current).not.toHaveProperty('runId');
  });
});
