import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
vi.mock('node:os', () => ({ totalmem: vi.fn(() => 16 * 1024 ** 3) }));

import { readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { requireIngestionMemoryLimit } from '../ingestion-isolation.js';

const read = vi.mocked(readFile);
afterEach(() => {
  vi.restoreAllMocks();
  read.mockReset();
});
describe('native-memory deployment boundary', () => {
  it('accepts an effective finite ancestor cgroup ceiling', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    read.mockImplementation(async (path) => {
      if (path === '/proc/self/cgroup') return '0::/workers/decoder\n';
      if (path === '/sys/fs/cgroup/workers/memory.max') return '536870912\n';
      return 'max\n';
    });
    expect(await requireIngestionMemoryLimit(536870912)).toEqual({
      memoryLimitBytes: 536870912,
    });
  });
  it('rejects unsupported hosts and unlimited/over-policy ceilings', async () => {
    const platform = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('darwin');
    await expect(requireIngestionMemoryLimit(512)).rejects.toThrow('Linux');
    expect(read).not.toHaveBeenCalled();
    platform.mockReturnValue('linux');
    read.mockImplementation(async (path) =>
      path === '/proc/self/cgroup' ? '0::/\n' : 'max\n',
    );
    await expect(requireIngestionMemoryLimit(512)).rejects.toThrow('missing');
    read.mockImplementation(async (path) =>
      path === '/proc/self/cgroup' ? '0::/\n' : '1024\n',
    );
    await expect(requireIngestionMemoryLimit(512)).rejects.toThrow('exceeds');
  });
  it('rejects malformed membership and inaccessible kernel limits', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    read.mockResolvedValue('0::/../../host\n');
    await expect(requireIngestionMemoryLimit(512)).rejects.toThrow(
      'membership',
    );
    read.mockRejectedValue(new Error('denied'));
    await expect(requireIngestionMemoryLimit(512)).rejects.toThrow('denied');
  });
  describe('desktop budget opt-in', () => {
    const GiB = 1024 ** 3;
    it.each([
      'darwin',
      'win32',
    ] as const)('requires the opt-in on %s', async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      await expect(requireIngestionMemoryLimit(GiB)).rejects.toThrow('Linux');
      await expect(requireIngestionMemoryLimit(GiB, {})).rejects.toThrow(
        'Linux',
      );
      expect(read).not.toHaveBeenCalled();
    });
    it.each([
      'darwin',
      'win32',
    ] as const)('defaults to the smaller of policy and a quarter of host memory on %s', async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      const out = { enforcement: 'advisory-host-budget' };
      expect(
        await requireIngestionMemoryLimit(GiB, { desktopBudget: {} }),
      ).toEqual({ memoryLimitBytes: GiB, ...out });
      expect(
        await requireIngestionMemoryLimit(8 * GiB, { desktopBudget: {} }),
      ).toEqual({ memoryLimitBytes: 4 * GiB, ...out });
      expect(
        await requireIngestionMemoryLimit(GiB, {
          desktopBudget: { budgetBytes: GiB / 2 },
        }),
      ).toEqual({ memoryLimitBytes: GiB / 2, ...out });
      expect(read).not.toHaveBeenCalled();
    });
    it('fails closed on bad budgets and unknown host memory', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
      for (const budgetBytes of [0, -1, 1.5, Number.NaN, 2 * GiB])
        await expect(
          requireIngestionMemoryLimit(GiB, { desktopBudget: { budgetBytes } }),
        ).rejects.toThrow(/budget/);
      await expect(
        requireIngestionMemoryLimit(0, { desktopBudget: {} }),
      ).rejects.toThrow('Invalid worker memory ceiling');
      vi.mocked(totalmem).mockReturnValueOnce(0);
      await expect(
        requireIngestionMemoryLimit(GiB, { desktopBudget: {} }),
      ).rejects.toThrow('unavailable');
      vi.mocked(totalmem).mockReturnValueOnce(GiB / 4);
      await expect(
        requireIngestionMemoryLimit(GiB, {
          desktopBudget: { budgetBytes: GiB / 2 },
        }),
      ).rejects.toThrow('host memory');
    });
    it('still throws on other platforms and ignores the opt-in on Linux', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('freebsd');
      await expect(
        requireIngestionMemoryLimit(GiB, { desktopBudget: {} }),
      ).rejects.toThrow('Linux');
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      read.mockImplementation(async (path) =>
        path === '/proc/self/cgroup' ? '0::/\n' : 'max\n',
      );
      await expect(
        requireIngestionMemoryLimit(GiB, { desktopBudget: {} }),
      ).rejects.toThrow('missing');
    });
  });
});
