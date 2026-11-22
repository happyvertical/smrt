/**
 * `smrt doctor --db`, the AI run id registry section (schema 1.20.0): core's
 * `checkAiRunIdRegistry()` against a real in-memory SQLite database, and the
 * lines the doctor prints for a clean and a flagged database.
 */

import { ensureSystemTables, openAiRun } from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatAiRunIdRegistryCheck,
  runAiRunIdRegistryCheck,
} from '../doctor-ai-run-ids.js';

describe('doctor AI run id registry', () => {
  let db: DatabaseInterface | undefined;

  afterEach(async () => {
    await db?.close?.();
    db = undefined;
  });

  it('reports a clean registry and flags an id an older core left unreserved', async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await ensureSystemTables(db, 'sqlite');
    await openAiRun({ db, usageTracking: true }, { type: 'turn' });
    const clean = await runAiRunIdRegistryCheck({ db, typeHint: 'sqlite' });
    expect(clean).toEqual({
      check: { unregisteredIds: 0, childrenOlderThanParent: 0 },
      error: null,
    });
    expect(
      formatAiRunIdRegistryCheck({
        unregisteredIds: 0,
        childrenOlderThanParent: 0,
      }),
    ).toHaveLength(2);

    await db.query(
      `INSERT INTO _smrt_ai_usage (id, provider, model, operation, duration_ms, run_id)
       VALUES ('u-old', 'openai', 'gpt-4o', 'chat', 1, 'never-registered')`,
    );
    const flagged = await runAiRunIdRegistryCheck({ db, typeHint: 'sqlite' });
    expect(flagged.check).toEqual({
      unregisteredIds: 1,
      childrenOlderThanParent: 0,
    });
    expect(
      formatAiRunIdRegistryCheck({
        unregisteredIds: 1,
        childrenOlderThanParent: 0,
      }).join('\n'),
    ).toContain('Run identity');
  });

  it('reports a failure without throwing', async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    const outcome = await runAiRunIdRegistryCheck({ db, typeHint: 'sqlite' });
    expect(outcome.check).toBeNull();
    expect(outcome.error).toEqual(expect.any(String));
  });
});
