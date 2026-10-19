import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

import { readFile } from 'node:fs/promises';
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
});
