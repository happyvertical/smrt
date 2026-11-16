/**
 * A newer definition version that accepted an older checkpoint records
 * itself when it saves the migrated state (#5005; docs/content/ai-runs.md
 * section 7), on the checkpoint and the run row, so the next resume compares
 * against the version that wrote the state. Real SQLite and DuckDB (PGlite in
 * its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AiRunResumeRefusedError,
  getAiRun,
  openAiRun,
  readAiRunCheckpoint,
  resumeAiRun,
  saveAiRunCheckpoint,
  stopAiRun,
} from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  await closeAiRunTestDatabases();
});

const store = (db: DatabaseInterface) => ({ db, usageTracking: true });

describe.each(
  aiRunTestEngines,
)('checkpoint definition version on %s', (engine) => {
  it('moves to the version that saved the migrated state, and only then', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db), {
      type: 'workflow',
      definitionKey: 'host:import',
      definitionVersion: '1',
      durable: true,
      checkpoint: { state: { shape: 1 } },
    });
    await stopAiRun(db, run.id);
    // Version 2 accepts version 1's checkpoint and resumes it.
    await resumeAiRun(db, run.id, {
      definitionVersion: '2',
      acceptsVersion: (saved) => saved === '1' || saved === '2',
    });
    // A save without a version leaves the recorded one alone.
    await saveAiRunCheckpoint(db, run.id, {
      expectedRevision: 0,
      state: { shape: 1 },
    });
    expect((await readAiRunCheckpoint(db, run.id))?.definitionVersion).toBe(
      '1',
    );
    await saveAiRunCheckpoint(db, run.id, {
      expectedRevision: 1,
      state: { shape: 2 },
      definitionVersion: '2',
    });
    const checkpoint = await readAiRunCheckpoint(db, run.id);
    expect(checkpoint).toMatchObject({
      revision: 2,
      definitionVersion: '2',
      state: { shape: 2 },
    });
    expect((await getAiRun(db, run.id))?.definitionVersion).toBe('2');

    // Version 2 now resumes it without accepting anything older.
    await stopAiRun(db, run.id);
    await expect(
      resumeAiRun(db, run.id, { definitionVersion: '2' }),
    ).resolves.toMatchObject({ status: 'running' });
    await stopAiRun(db, run.id);
    await expect(
      resumeAiRun(db, run.id, { definitionVersion: '1' }),
    ).rejects.toBeInstanceOf(AiRunResumeRefusedError);
  });
});
