/**
 * Reproducer/regression probe for issue #2750, mirroring the issue's own
 * reproducer almost verbatim. Deliberately does NOT import `./models/widget.ts`
 * — `Widget` must reach `ObjectRegistry` only through
 * `smrtVitestPlugin()`'s manifest-based registration, the same path that
 * left the registry empty in the reported bug (registration ran in a
 * different process than this spec).
 */
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { describe, expect, it } from 'vitest';

describe('issue #2750 registry-sharing probe', () => {
  it('sees classes registered by smrtVitestPlugin() in this same worker process', async () => {
    const classNames = ObjectRegistry.getQualifiedClassNames();
    expect(classNames.length).toBeGreaterThan(0);
    expect(classNames.some((name) => name.endsWith(':Widget'))).toBe(true);
  });

  it('getTestDatabase() creates a real model table, not just system tables', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      const result = await db.query(
        `SELECT name FROM sqlite_master WHERE type='table'`,
      );
      const rows = Array.isArray(result)
        ? result
        : (result as { rows: Array<{ name: string }> }).rows;
      const tableNames = rows.map((row) => row.name as string);

      expect(tableNames).toContain('widgets');
    } finally {
      await db.close?.();
    }
  });
});
