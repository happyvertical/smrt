/**
 * Scoped run reads (docs/content/ai-runs.md section 3): `getAiRun` and
 * `readAiRunCheckpoint` with an `AiRunReadScope` read a run only within its
 * tenant, owner and type, as predicates of the one statement. Real SQLite
 * and DuckDB (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { getAiRun, openAiRun, readAiRunCheckpoint } from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  hasTenantPredicate,
  newAiRunTestDatabase,
  recordStatements,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  await closeAiRunTestDatabases();
});

const store = (db: DatabaseInterface, tenantId: string | null) => ({
  db,
  usageTracking: true,
  tenantId,
});

describe.each(aiRunTestEngines)('scoped run reads on %s', (engine) => {
  it('reads a run and its checkpoint only within tenant, owner and type', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db, 'tenant-one'), {
      type: 'workflow',
      ownerId: 'owner-p',
      durable: true,
      checkpoint: { state: { s: 1 } },
    });
    const own = {
      tenantId: 'tenant-one',
      ownerId: 'owner-p',
      type: 'workflow',
    };
    expect((await getAiRun(db, run.id, own))?.id).toBe(run.id);
    expect((await readAiRunCheckpoint(db, run.id, own))?.state).toEqual({
      s: 1,
    });
    for (const scope of [
      { tenantId: 'tenant-two' },
      { tenantId: null },
      { tenantId: 'tenant-one', ownerId: 'owner-q' },
      { tenantId: 'tenant-one', ownerId: null },
      { tenantId: 'tenant-one', type: 'turn' },
    ]) {
      expect(await getAiRun(db, run.id, scope)).toBeNull();
      expect(await readAiRunCheckpoint(db, run.id, scope)).toBeNull();
    }
    const statements: string[] = [];
    const restore = recordStatements(db, (sql) => statements.push(sql));
    await getAiRun(db, run.id, { tenantId: 'tenant-two' });
    await readAiRunCheckpoint(db, run.id, { tenantId: 'tenant-two' });
    restore();
    expect(statements.length).toBe(2);
    for (const sql of statements) expect(hasTenantPredicate(sql)).toBe(true);
  });

  it('reads without a scope as before (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db, null), { type: 'turn' });
    expect((await getAiRun(db, run.id))?.id).toBe(run.id);
  });
});
