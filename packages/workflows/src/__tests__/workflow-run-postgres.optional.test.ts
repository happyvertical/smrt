/**
 * Workflow runs on a real PostgreSQL server (#5005). Runs only when
 * `SMRT_TEST_POSTGRES_URL` is set; point it at a DISPOSABLE database (the
 * test deletes AI run rows). The PGlite lane covers the same scenarios
 * in-process on every run.
 */
import { getTestDatabase } from '@happyvertical/smrt-core';
import { clearPromptCache, PromptRegistry } from '@happyvertical/smrt-prompts';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe } from 'vitest';
import { definePrompts } from './harness.js';
import { workflowScenarios } from './scenarios.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)('workflow runs on PostgreSQL (#5005)', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: 'smrt-test-5005-workflows',
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await getTestDatabase({ db, classes: ['PromptOverride'] });
  });
  beforeEach(() => {
    clearPromptCache();
    definePrompts();
  });
  afterAll(async () => {
    PromptRegistry.clear();
    if (!db) return;
    await db.query('DELETE FROM _smrt_ai_run_events');
    await db.query('DELETE FROM _smrt_ai_run_checkpoints');
    await db.query('DELETE FROM _smrt_ai_runs');
    await db.query('DELETE FROM _smrt_ai_usage');
  });

  workflowScenarios(async () => db);
});
