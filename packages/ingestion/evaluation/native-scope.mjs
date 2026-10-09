import { readFileSync } from 'node:fs';

export const NATIVE_SCOPE_BYTES = 2_147_483_648;
/** Verify the actual final process before constructing SDK clients or reserving a call.
 * This is one aggregate host+child ceiling, never a per-worker native allowance.
 */
export function assertNativeScope() {
  const membership = readFileSync('/proc/self/cgroup', 'utf8')
    .split('\n')
    .find((line) => line.startsWith('0::'));
  const group = membership?.slice(3);
  if (!group?.startsWith('/') || group.includes('..') || group.includes('\0'))
    throw Error('Unified native memory scope required');
  const root = `/sys/fs/cgroup${group}`;
  const memory = readFileSync(`${root}/memory.max`, 'utf8').trim();
  const swap = readFileSync(`${root}/memory.swap.max`, 'utf8').trim();
  if (memory !== String(NATIVE_SCOPE_BYTES) || swap !== '0')
    throw Error('Evaluation requires actual2GiB native scope and swap0');
  return Object.freeze({
    scope: group,
    maximumBytes: NATIVE_SCOPE_BYTES,
    swapBytes: 0,
    concurrency: 1,
    coverage:
      'aggregate evaluation host and inherited provider child processes',
  });
}
