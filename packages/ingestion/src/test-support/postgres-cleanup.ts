import { setTimeout } from 'node:timers/promises';
import type { DatabaseInterface } from '@happyvertical/sql';

function databaseInUse(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && current.code === '55006') return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/** Fixture cleanup only; never terminate another role's backend or skip a leak. */
export async function dropExecutionDatabase(
  db: Pick<DatabaseInterface, 'query'>,
  name: string,
  timeoutMs = 10000,
): Promise<void> {
  if (!/^(?:exec|ing|ext|sources)_[a-f0-9]{32}$/.test(name))
    throw new Error('Invalid fixture database');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await db.query(`DROP DATABASE IF EXISTS ${name}`);
      return;
    } catch (error) {
      if (!databaseInUse(error) || Date.now() >= deadline) throw error;
      await setTimeout(Math.min(100, Math.max(0, deadline - Date.now())));
    }
  }
}
