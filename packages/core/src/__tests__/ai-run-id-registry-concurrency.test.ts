/**
 * Concurrent opens of one run id (docs/content/ai-runs.md section 8, "Run
 * identity"): exactly one succeeds and the other gets the final
 * `AiRunIdUsedError`. SQLite runs two independent connections on one file.
 * DuckDB admits one writing process per file and the adapter serializes a
 * connection's transactions, so two openers never conflict there; the
 * retry policy is shown instead with an injected write conflict: a
 * transient failure is retried and the retry, seeing the committed key, is
 * refused, while a committed duplicate is refused on its first attempt. The
 * PostgreSQL lane races two pooled connections
 * (`ai-run-id-registry-postgres.optional.test.ts`).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSystemTables } from '../system/bootstrap';
import { AiRunIdUsedError, openAiRun } from '../system/browser';
import {
  aiRunTestEngines,
  beforeStatement,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  recordStatements,
  rowsOf,
} from './fixtures/ai-run-test-db';

const handles: DatabaseInterface[] = [];

afterEach(async () => {
  for (const db of handles.splice(0)) await db.close?.();
  await closeAiRunTestDatabases();
});

async function digestOf(id: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('two SQLite connections on one file', () => {
  it('open one id: one wins, the other gets AiRunIdUsedError', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'smrt-runid-')), 'runs.db');
    const a = (await getDatabase({
      type: 'sqlite',
      url: file,
    })) as DatabaseInterface;
    handles.push(a);
    await ensureSystemTables(a, 'sqlite');
    const b = (await getDatabase({
      type: 'sqlite',
      url: file,
    })) as DatabaseInterface;
    handles.push(b);
    for (let round = 0; round < 5; round++) {
      const id = `contended-${round}`;
      const results = await Promise.allSettled([
        openAiRun(
          { db: a, usageTracking: true, tenantId: 't1' },
          { id, type: 'turn' },
        ),
        openAiRun(
          { db: b, usageTracking: true, tenantId: 't2' },
          { id, type: 'turn' },
        ),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]?.reason).toBeInstanceOf(AiRunIdUsedError);
      expect(
        rowsOf(await a.query('SELECT id FROM _smrt_ai_runs WHERE id = $1', id)),
      ).toHaveLength(1);
    }
  });
});

describe.each(aiRunTestEngines)('conflict versus duplicate on %s', (engine) => {
  it('a transient write conflict is retried, then refused once the key has committed', async () => {
    const db = await newAiRunTestDatabase(engine);
    const digest = await digestOf('conflicted');
    let attempts = 0;
    const counter = recordStatements(db, (sql) => {
      if (sql.startsWith('SELECT 1 AS used FROM _smrt_ai_run_ids')) attempts++;
    });
    // The first attempt meets a write conflict (as a concurrent DuckDB
    // writer would raise); by the retry the competing opener's key has
    // committed (written ahead of the retry's registry check).
    let restoreRetry = () => {};
    const restore = beforeStatement(
      db,
      (sql) => sql.startsWith('INSERT INTO _smrt_ai_run_ids'),
      () => {
        restoreRetry = beforeStatement(
          db,
          (sql) => sql.startsWith('SELECT 1 AS used FROM _smrt_ai_run_ids'),
          (exec) =>
            exec(
              'INSERT INTO _smrt_ai_run_ids (id_digest, created_at) VALUES ($1, $2)',
              digest,
              new Date().toISOString(),
            ),
        );
        throw new Error(
          'TransactionContext Error: Conflict on tuple deletion/update',
        );
      },
    );
    const outcome = await openAiRun(
      { db, usageTracking: true, tenantId: 't1' },
      { id: 'conflicted', type: 'turn' },
      { attempts: 3 },
    ).catch((e: unknown) => e);
    restoreRetry();
    restore();
    counter();
    expect(outcome).toBeInstanceOf(AiRunIdUsedError);
    expect(attempts).toBe(2);
  });

  it('a committed duplicate is refused on the first attempt', async () => {
    const db = await newAiRunTestDatabase(engine);
    await openAiRun({ db, usageTracking: true }, { id: 'dup', type: 'turn' });
    let attempts = 0;
    const counter = recordStatements(db, (sql) => {
      if (sql.startsWith('SELECT 1 AS used FROM _smrt_ai_run_ids')) attempts++;
    });
    await expect(
      openAiRun({ db, usageTracking: true }, { id: 'dup', type: 'turn' }),
    ).rejects.toBeInstanceOf(AiRunIdUsedError);
    counter();
    expect(attempts).toBe(1);
  });
});
