import { afterEach, expect, test, vi } from 'vitest';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

import { readFileSync } from 'node:fs';
import { assertNativeScope } from './native-scope.mjs';

const read = vi.mocked(readFileSync);
afterEach(() => {
  read.mockReset();
});
test('scope proof reads the actual process membership and aggregate kernel memory controls', () => {
  read.mockImplementation((path) => {
    if (String(path) === '/proc/self/cgroup')
      return '0::/user.slice/evaluation.scope\n';
    if (String(path).endsWith('/memory.max')) return '2147483648\n';
    if (String(path).endsWith('/memory.swap.max')) return '0\n';
    throw Error('Unexpected scope file');
  });
  expect(assertNativeScope()).toMatchObject({
    maximumBytes: 2147483648,
    swapBytes: 0,
    concurrency: 1,
  });
  expect(read).toHaveBeenCalledWith(
    '/sys/fs/cgroup/user.slice/evaluation.scope/memory.max',
    'utf8',
  );
});
test('missing/unbounded/wrong-swap scope fails before caller can construct SDK clients', () => {
  for (const [membership, memory, swap] of [
    ['', '2147483648', '0'],
    ['0::/scope', 'max', '0'],
    ['0::/scope', '2147483648', 'max'],
    ['0::/../scope', '2147483648', '0'],
  ]) {
    read.mockImplementation((path) =>
      String(path) === '/proc/self/cgroup'
        ? membership
        : String(path).endsWith('/memory.max')
          ? memory
          : swap,
    );
    let clients = 0;
    expect(() => {
      assertNativeScope();
      clients++;
    }).toThrow();
    expect(clients).toBe(0);
  }
});
