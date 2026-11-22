/**
 * Permission contexts and the request scope of a REST request (#5195).
 *
 * - A module error thrown by the caller's own callback is the callback's
 *   error: the callback runs once and the error reaches the caller.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withPrincipalPermissionContext } from '../services/SessionPermissionContext.js';

describe('permission contexts', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(
      process.env.TMPDIR ?? tmpdir(),
      `smrt-request-scope-${Date.now()}-${Math.random()}.db`,
    );
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  it('a module error from the callback runs it once', async () => {
    const db = await getDatabase({ type: 'sqlite', url: dbPath });
    await db.query('CREATE TABLE marks (n INTEGER)');
    let calls = 0;
    const moduleError = Object.assign(new Error('Cannot find module x'), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    for (const tenantId of ['tenant-a', undefined]) {
      calls = 0;
      await expect(
        withPrincipalPermissionContext(
          {
            db: { type: 'sqlite', url: dbPath },
            userId: 'user-a',
            ...(tenantId ? { tenantId } : {}),
            permissions: [],
            enterTenantContext: true,
          },
          async () => {
            calls += 1;
            await db.query('INSERT INTO marks (n) VALUES (1)');
            throw moduleError;
          },
        ),
      ).rejects.toBe(moduleError);
      expect(calls).toBe(1);
    }
    const marks = await db.query('SELECT COUNT(*) AS n FROM marks');
    expect(Number(marks.rows[0]?.n)).toBe(2);
    await db.close?.();
  });
});
