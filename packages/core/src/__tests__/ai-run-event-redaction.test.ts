/**
 * Run event payloads go through the transcripts' redaction path
 * (docs/content/ai-runs.md section 8): the host redactor sees the run's
 * tenant, read behind the claim fence, then the built-in redactor runs.
 * Real SQLite and DuckDB (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AiTranscriptRedactionContext,
  setTranscriptRedactor,
} from '../ai-transcripts';
import {
  AiRunClaimLostError,
  AiRunNotFoundError,
  appendAiRunEvent,
  getRunTrajectory,
  openAiRun,
} from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  setTranscriptRedactor(undefined);
  await closeAiRunTestDatabases();
});

async function storedPayload(db: DatabaseInterface, runId: string) {
  const trajectory = await getRunTrajectory(db, runId);
  return trajectory?.entries[0]?.event?.payload;
}

describe.each(aiRunTestEngines)('run event redaction on %s', (engine) => {
  it('hands the host redactor the run tenant', async () => {
    const db = await newAiRunTestDatabase(engine);
    const seen: AiTranscriptRedactionContext[] = [];
    setTranscriptRedactor((messages, context) => {
      seen.push(context);
      return messages;
    });
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 'tenant-one' },
      { type: 'turn' },
    );
    await appendAiRunEvent(db, run.id, {
      type: 'observation',
      payload: { note: 'checked' },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      tenantId: 'tenant-one',
      part: 'tools',
      operation: 'run-event:observation',
    });

    const global = await openAiRun(
      { db, usageTracking: true, tenantId: null },
      { type: 'turn' },
    );
    await appendAiRunEvent(db, global.id, {
      type: 'observation',
      payload: { note: 'checked' },
    });
    expect(seen[1]?.tenantId).toBeNull();
  });

  it('still masks credential-named keys (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 'tenant-one' },
      { type: 'turn' },
    );
    await appendAiRunEvent(db, run.id, {
      type: 'observation',
      payload: { apiKey: 'anything', note: 'kept' },
    });
    expect(await storedPayload(db, run.id)).toEqual({
      apiKey: '[REDACTED]',
      note: 'kept',
    });
  });

  it('refuses a worker whose claim is gone before the run is read or redacted', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 'tenant-one' },
      { type: 'workflow', durable: true },
    );
    let redactorCalls = 0;
    setTranscriptRedactor((messages) => {
      redactorCalls++;
      return messages;
    });
    await expect(
      appendAiRunEvent(
        db,
        run.id,
        { type: 'observation', payload: { note: 'late worker' } },
        { fence: async () => false },
      ),
    ).rejects.toBeInstanceOf(AiRunClaimLostError);
    expect(redactorCalls).toBe(0);
    expect((await getRunTrajectory(db, run.id))?.entries).toEqual([]);
  });

  it('applies only the built-in redactor on read, never the host one', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 'tenant-one' },
      { type: 'turn' },
    );
    await appendAiRunEvent(db, run.id, {
      type: 'observation',
      payload: { note: 'contains customer-code-77' },
    });
    // A row written before the built-in redactor masked credential keys.
    await db.query(
      `UPDATE _smrt_ai_run_events SET payload = $1 WHERE run_id = $2`,
      JSON.stringify({ apiKey: 'raw-key', note: 'contains customer-code-77' }),
      run.id,
    );
    let hostCalls = 0;
    setTranscriptRedactor((messages) => {
      hostCalls++;
      return messages;
    });
    expect(await storedPayload(db, run.id)).toEqual({
      apiKey: '[REDACTED]',
      note: 'contains customer-code-77',
    });
    expect(hostCalls).toBe(0);
  });

  it('never returns a stored truncated fragment with a credential field unmasked', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 'tenant-one' },
      { type: 'turn' },
    );
    await appendAiRunEvent(db, run.id, {
      type: 'observation',
      payload: { note: 'placeholder' },
    });
    // A truncated payload stored by an earlier version: head and tail are
    // fragments of JSON text, not JSON.
    await db.query(
      `UPDATE _smrt_ai_run_events SET payload = $1, truncated = 1 WHERE run_id = $2`,
      JSON.stringify({
        truncated: true,
        originalBytes: 90_000,
        head: '{"note":"start","apiKey":"raw-secret-in-head","items":[{"a":',
        tail: '1}],"password":"raw-secret-in-tail","end":true}',
      }),
      run.id,
    );
    const payload = JSON.stringify(await storedPayload(db, run.id));
    expect(payload).not.toContain('raw-secret-in-head');
    expect(payload).not.toContain('raw-secret-in-tail');
    expect(payload).toContain('[REDACTED]');
    expect(payload).toContain('"note\\":\\"start');
  });

  it('refuses a payload for a run that does not exist', async () => {
    const db = await newAiRunTestDatabase(engine);
    await expect(
      appendAiRunEvent(db, crypto.randomUUID(), {
        type: 'observation',
        payload: { note: 'x' },
      }),
    ).rejects.toBeInstanceOf(AiRunNotFoundError);
  });
});
