import { readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { resolve } from 'node:path';

export interface IngestionMemoryLimitOptions {
  /** Explicit opt-in for single-user desktop hosts (macOS, Windows) that have
   * no cgroups. Ignored on Linux, where the cgroup-v2 check always applies.
   * The resulting budget is advisory: no operating-system ceiling exists.
   */
  desktopBudget?: {
    /** Defaults to min(maximumBytes, a quarter of total system memory). */
    budgetBytes?: number;
  };
}

export interface IngestionMemoryLimit {
  memoryLimitBytes: number;
  /** Present only for the desktop path; Linux results omit it. */
  enforcement?: 'advisory-host-budget';
}

/** Verify a real Linux cgroup-v2 native-memory ceiling before enabling decoders.
 * The worker and its children must remain in this cgroup; deployments must deny
 * cgroup writes/escape and run without privileged container capabilities.
 */
export async function requireIngestionMemoryLimit(
  maximumBytes: number,
  options: IngestionMemoryLimitOptions = {},
): Promise<IngestionMemoryLimit> {
  const desktop = options.desktopBudget;
  const desktopHost =
    process.platform === 'darwin' || process.platform === 'win32';
  if (process.platform !== 'linux' && !(desktop && desktopHost))
    throw new Error(
      'Extraction requires a Linux cgroup-v2 memory-limited worker',
    );
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error('Invalid worker memory ceiling');
  if (process.platform !== 'linux' && desktop) {
    const system = totalmem();
    if (!Number.isSafeInteger(system) || system < 1)
      throw new Error('Host memory size is unavailable');
    const budget =
      desktop.budgetBytes ?? Math.min(maximumBytes, Math.floor(system / 4));
    if (!Number.isSafeInteger(budget) || budget < 1)
      throw new Error('Invalid desktop memory budget');
    if (budget > maximumBytes || budget > system)
      throw new Error('Desktop memory budget exceeds policy or host memory');
    return { memoryLimitBytes: budget, enforcement: 'advisory-host-budget' };
  }
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
