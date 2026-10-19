import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Verify a real Linux cgroup-v2 native-memory ceiling before enabling decoders.
 * The worker and its children must remain in this cgroup; deployments must deny
 * cgroup writes/escape and run without privileged container capabilities.
 */
export async function requireIngestionMemoryLimit(
  maximumBytes: number,
): Promise<{ memoryLimitBytes: number }> {
  if (process.platform !== 'linux')
    throw new Error(
      'Extraction requires a Linux cgroup-v2 memory-limited worker',
    );
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error('Invalid worker memory ceiling');
  const membership = await readFile('/proc/self/cgroup', 'utf8');
  const entry = membership.split('\n').find((line) => line.startsWith('0::'));
  if (!entry) throw new Error('No cgroup-v2 membership');
  const relative = entry.slice(3);
  if (!relative.startsWith('/') || relative.split('/').includes('..'))
    throw new Error('Invalid cgroup membership');
  const root = '/sys/fs/cgroup';
  let directory = resolve(root, `.${relative}`);
  let limit = Number.POSITIVE_INFINITY;
  // An ancestor limit is authoritative too. Account for inherited limits while
  // never accepting a mere configuration promise or Node heap setting.
  while (directory === root || directory.startsWith(`${root}/`)) {
    const value = (await readFile(`${directory}/memory.max`, 'utf8')).trim();
    if (value !== 'max') {
      if (!/^\d+$/.test(value)) throw new Error('Invalid cgroup memory limit');
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1)
        throw new Error('Invalid cgroup memory limit');
      limit = Math.min(limit, parsed);
    }
    if (directory === root) break;
    directory = resolve(directory, '..');
  }
  if (!Number.isFinite(limit) || limit > maximumBytes)
    throw new Error(
      'Worker native-memory ceiling is missing or exceeds policy',
    );
  return { memoryLimitBytes: limit };
}
