/**
 * One run id names at most one run for the lifetime of the database
 * (docs/content/ai-runs.md section 8, "Run identity"): once an open of id X
 * has committed, no later open of X succeeds, in any tenant, after any
 * prune. The id's SHA-256 digest is kept in `_smrt_ai_run_ids`, written in
 * the opener's own transaction, and never deleted by retention. Real SQLite
 * and DuckDB (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { isAiRunRetryable } from '../system/ai-run-model';
import {
  AiRunIdUsedError,
  AiRunNotFoundError,
  finishAiRun,
  getAiRun,
  openAiRun,
  pruneAiRuns,
  pruneAiRunTrajectories,
  recordAiRun,
  reserveAiCall,
  settleAiCall,
  withAiRunTransaction,
} from '../system/browser';
import {
  aiRunTestEngines,
  beforeStatement,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  pruneRunNow,
  recordStatements,
  rowsOf,
  usageEvent,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  await closeAiRunTestDatabases();
});

const store = (
  db: DatabaseInterface,
  tenantId: string | null = 'tenant-one',
) => ({ db, usageTracking: true, tenantId });

async function digestOf(id: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function registered(db: DatabaseInterface): Promise<string[]> {
  return rowsOf(
    await db.query('SELECT id_digest FROM _smrt_ai_run_ids ORDER BY id_digest'),
  ).map((row) => String(row.id_digest));
}

async function runRows(db: DatabaseInterface, id: string) {
  return rowsOf(
    await db.query(
      'SELECT id, tenant_id, owner_id FROM _smrt_ai_runs WHERE id = $1',
      id,
    ),
  );
}

describe.each(aiRunTestEngines)('run identity registry on %s', (engine) => {
  it('refuses an id another tenant used before it was pruned', async () => {
    const db = await newAiRunTestDatabase(engine);
    const first = await openAiRun(store(db, 'tenant-one'), {
      id: 'chosen-id-1',
      type: 'turn',
    });
    await pruneRunNow(db, first.id);
    expect(await runRows(db, first.id)).toEqual([]);
    await expect(
      openAiRun(store(db, 'tenant-two'), { id: 'chosen-id-1', type: 'turn' }),
    ).rejects.toBeInstanceOf(AiRunIdUsedError);
    expect(await runRows(db, first.id)).toEqual([]);
  });

  it('refuses an id the same tenant used before it was pruned, for another owner', async () => {
    const db = await newAiRunTestDatabase(engine);
    await openAiRun(store(db), {
      id: 'chosen-id-2',
      type: 'workflow',
      ownerId: 'owner-p',
    });
    await pruneRunNow(db, 'chosen-id-2');
    await expect(
      openAiRun(store(db), {
        id: 'chosen-id-2',
        type: 'workflow',
        ownerId: 'owner-q',
      }),
    ).rejects.toBeInstanceOf(AiRunIdUsedError);
    expect(await runRows(db, 'chosen-id-2')).toEqual([]);
  });

  it('refuses a live id with a stable, final error on the first attempt', async () => {
    const db = await newAiRunTestDatabase(engine);
    await openAiRun(store(db), { id: 'chosen-id-3', type: 'turn' });
    const inserts: string[] = [];
    const restore = recordStatements(db, (sql) => {
      if (sql.startsWith('INSERT INTO _smrt_ai_run')) inserts.push(sql);
    });
    const error = await openAiRun(store(db, 'tenant-two'), {
      id: 'chosen-id-3',
      type: 'turn',
    }).catch((e: unknown) => e);
    restore();
    expect(error).toBeInstanceOf(AiRunIdUsedError);
    expect((error as Error).message).toBe(
      'AI run id chosen-id-3 is already used',
    );
    expect(isAiRunRetryable(error)).toBe(false);
    // Refused before any write, and never retried.
    expect(inserts).toEqual([]);
  });

  it('an interleaved duplicate open is refused, not retried', async () => {
    const db = await newAiRunTestDatabase(engine);
    const interleavedDigest = await digestOf('chosen-id-4');
    let attempts = 0;
    const counter = recordStatements(db, (sql) => {
      if (sql.startsWith('SELECT 1 AS used FROM _smrt_ai_run_ids')) attempts++;
    });
    // Another opener commits the same id between this open's checks and its
    // insert (one handle: the interleaving variant of the concurrency case).
    const restore = beforeStatement(
      db,
      (sql) => sql.startsWith('INSERT INTO _smrt_ai_run_ids'),
      (exec) =>
        exec(
          'INSERT INTO _smrt_ai_run_ids (id_digest, created_at) VALUES ($1, $2)',
          interleavedDigest,
          new Date().toISOString(),
        ),
    );
    await expect(
      openAiRun(store(db), { id: 'chosen-id-4', type: 'turn' }),
    ).rejects.toBeInstanceOf(AiRunIdUsedError);
    restore();
    counter();
    expect(attempts).toBe(1);
  });

  it('an open racing a prune of the same id is refused', async () => {
    const db = await newAiRunTestDatabase(engine);
    const parent = await openAiRun(store(db), { type: 'workflow' });
    const victim = await openAiRun(store(db), {
      id: 'chosen-id-5',
      type: 'turn',
    });
    await finishAiRun(db, victim.id, { status: 'done' });
    await db.query(
      "UPDATE _smrt_ai_runs SET finished_at = '2000-01-01T00:00:00.000Z' WHERE id = $1",
      victim.id,
    );
    await pruneAiRunTrajectories(db, { maxAgeMs: 0 });
    // The prune's delete lands between the open's parent lock and its
    // checks (one handle: the interleaving variant; the PostgreSQL lane
    // races two connections).
    const restore = beforeStatement(
      db,
      (sql) => sql.startsWith('SELECT 1 AS used FROM _smrt_ai_run_ids'),
      (exec) => exec('DELETE FROM _smrt_ai_runs WHERE id = $1', victim.id),
    );
    await expect(
      openAiRun(store(db), {
        id: 'chosen-id-5',
        type: 'turn',
        parentRunId: parent.id,
      }),
    ).rejects.toBeInstanceOf(AiRunIdUsedError);
    restore();
    // The interleaved delete ran in the refused open's transaction and
    // rolled back with it; no row was opened under the id.
    expect(await runRows(db, 'chosen-id-5')).toEqual([
      expect.objectContaining({ id: 'chosen-id-5', owner_id: null }),
    ]);
    expect((await getAiRun(db, 'chosen-id-5'))?.parentRunId).toBeNull();
  });

  it('a rolled-back open leaves the id free', async () => {
    const db = await newAiRunTestDatabase(engine);
    const stoppedParent = await openAiRun(store(db), { type: 'turn' });
    await finishAiRun(db, stoppedParent.id, { status: 'done' });
    await expect(
      openAiRun(store(db), {
        id: 'chosen-id-6',
        type: 'turn',
        parentRunId: stoppedParent.id,
      }),
    ).rejects.toThrow();
    const live = await openAiRun(store(db), { type: 'turn' });
    const child = await openAiRun(store(db), {
      id: 'chosen-id-6',
      type: 'turn',
      parentRunId: live.id,
    });
    expect(child.id).toBe('chosen-id-6');
  });

  it('a failure after the digest insert leaves neither row in a caller-owned transaction', async () => {
    const db = await newAiRunTestDatabase(engine);
    // The caller owns the transaction and commits whatever it caught: the
    // open must fail before its first write, never half way.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await withAiRunTransaction(db, async (tx) => {
      await expect(
        openAiRun(
          { db: tx.db, usageTracking: true, tenantId: 'tenant-one' },
          {
            id: 'chosen-id-7',
            type: 'turn',
            durable: true,
            checkpoint: { state: circular },
          },
        ),
      ).rejects.toThrow();
    });
    expect(await runRows(db, 'chosen-id-7')).toEqual([]);
    expect(await registered(db)).not.toContain(await digestOf('chosen-id-7'));
    // A failure injected after the digest insert, inside the caller's
    // transaction, rolls back with it.
    await expect(
      withAiRunTransaction(
        db,
        async (tx) => {
          const restore = beforeStatement(
            tx.db,
            (sql) => sql.startsWith('INSERT INTO _smrt_ai_runs '),
            () => {
              throw new Error('injected after the digest insert');
            },
          );
          try {
            await openAiRun(
              { db: tx.db, usageTracking: true, tenantId: 'tenant-one' },
              { id: 'chosen-id-7', type: 'turn' },
            );
          } finally {
            restore();
          }
        },
        { attempts: 1 },
      ),
    ).rejects.toThrow('injected after the digest insert');
    expect(await runRows(db, 'chosen-id-7')).toEqual([]);
    expect(await registered(db)).not.toContain(await digestOf('chosen-id-7'));
    const opened = await openAiRun(store(db), {
      id: 'chosen-id-7',
      type: 'turn',
    });
    expect(opened.id).toBe('chosen-id-7');
  });

  it('recordAiRun refuses a used id and accepts a first use', async () => {
    const db = await newAiRunTestDatabase(engine);
    const fusion = {
      fusionKey: 'review',
      mode: 'pair',
      status: 'ok' as const,
      seats: 2,
      degradedSeats: 0,
      duration: 10,
    };
    await recordAiRun(db, { id: 'chosen-id-8', ...fusion });
    expect(await runRows(db, 'chosen-id-8')).toHaveLength(1);
    await pruneRunNow(db, 'chosen-id-8');
    await expect(
      recordAiRun(db, { id: 'chosen-id-8', ...fusion }),
    ).rejects.toBeInstanceOf(AiRunIdUsedError);
    expect(await runRows(db, 'chosen-id-8')).toEqual([]);
  });

  it('a pruned parent id cannot be reopened under its surviving child', async () => {
    const db = await newAiRunTestDatabase(engine);
    const parent = await openAiRun(store(db), {
      id: 'chosen-parent-12',
      type: 'workflow',
    });
    const child = await openAiRun(store(db), {
      type: 'turn',
      parentRunId: parent.id,
    });
    await pruneRunNow(db, parent.id);
    expect(await runRows(db, parent.id)).toEqual([]);
    expect((await getAiRun(db, child.id))?.status).toBe('running');
    await expect(
      openAiRun(store(db), { id: parent.id, type: 'workflow' }),
    ).rejects.toBeInstanceOf(AiRunIdUsedError);
    // A charge on the child reaches no unrelated run.
    const callId = crypto.randomUUID();
    await reserveAiCall(db, child.id, { callId, inputTokens: 3 });
    await settleAiCall(db, {
      runId: child.id,
      callId,
      usage: { ...usageEvent(9, 0.01), tenantId: 'tenant-one' },
    });
    expect(await runRows(db, parent.id)).toEqual([]);
  });

  it.each([
    ['an empty id', ''],
    ['a lone high surrogate', '\uD800'],
    ['a lone low surrogate', 'a\uDC00b'],
    ['a NUL', 'a\u0000b'],
    ['a number', 42],
  ])('refuses %s before any write', async (_name, id) => {
    const db = await newAiRunTestDatabase(engine);
    const before = await registered(db);
    await expect(
      openAiRun(store(db), { id: id as string, type: 'turn' }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await registered(db)).toEqual(before);
    expect(
      Number(
        rowsOf(await db.query('SELECT COUNT(*) AS n FROM _smrt_ai_runs'))[0]?.n,
      ),
    ).toBe(0);
  });

  it('keeps look-alike ids distinct: whitespace, case and Unicode forms', async () => {
    const db = await newAiRunTestDatabase(engine);
    const nfc = 'café';
    const nfd = 'café';
    const ids = ['Run-A', 'run-a', ' run-a', 'run-a ', nfc, nfd];
    for (const id of ids) {
      const run = await openAiRun(store(db), { id, type: 'turn' });
      expect(run.id).toBe(id);
    }
    for (const id of ids) await pruneRunNow(db, id);
    for (const id of ids) {
      await expect(
        openAiRun(store(db, 'tenant-two'), { id, type: 'turn' }),
      ).rejects.toBeInstanceOf(AiRunIdUsedError);
    }
    const digests = await registered(db);
    for (const id of ids) expect(digests).toContain(await digestOf(id));
  });

  it('opens different ids under one parent at once', async () => {
    const db = await newAiRunTestDatabase(engine);
    const parent = await openAiRun(store(db), { type: 'workflow' });
    const children = await Promise.all(
      ['sib-a', 'sib-b', 'sib-c'].map((id) =>
        openAiRun(store(db), { id, type: 'turn', parentRunId: parent.id }),
      ),
    );
    expect(children.map((c) => c.id).sort()).toEqual([
      'sib-a',
      'sib-b',
      'sib-c',
    ]);
  });

  it('retention never deletes registry rows, scoped or unscoped', async () => {
    const db = await newAiRunTestDatabase(engine);
    const a = await openAiRun(store(db, 'tenant-one'), { type: 'turn' });
    const b = await openAiRun(store(db, 'tenant-two'), { type: 'turn' });
    const c = await openAiRun(store(db, null), { type: 'turn' });
    const all = await registered(db);
    expect(all).toHaveLength(3);
    for (const run of [a, b, c]) {
      await finishAiRun(db, run.id, { status: 'done' });
    }
    await db.query(
      "UPDATE _smrt_ai_runs SET finished_at = '2000-01-01T00:00:00.000Z'",
    );
    await pruneAiRunTrajectories(db, { maxAgeMs: 0, tenantId: 'tenant-one' });
    await pruneAiRuns(db, { maxAgeMs: 0, tenantId: 'tenant-one' });
    expect(await registered(db)).toEqual(all);
    await pruneAiRunTrajectories(db, { maxAgeMs: 0 });
    await pruneAiRuns(db, { maxAgeMs: 0 });
    expect(
      Number(
        rowsOf(await db.query('SELECT COUNT(*) AS n FROM _smrt_ai_runs'))[0]?.n,
      ),
    ).toBe(0);
    expect(await registered(db)).toEqual(all);
  });

  it('a run an older core opened after the upgrade cannot be reopened once pruned', async () => {
    const db = await newAiRunTestDatabase(engine);
    // An older core writes the run row without a registry row.
    await db.query(
      `INSERT INTO _smrt_ai_runs (id, type, tenant_id, status, budget,
         started_at, created_at, finished_at, trajectory_pruned)
       VALUES ('old-core-run', 'turn', 'tenant-one', 'done', '{}',
         '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z',
         '2000-01-01T00:00:00.000Z', 1)`,
    );
    expect(await registered(db)).not.toContain(await digestOf('old-core-run'));
    // Live, it is refused by its row.
    await expect(
      openAiRun(store(db, 'tenant-two'), { id: 'old-core-run', type: 'turn' }),
    ).rejects.toBeInstanceOf(AiRunIdUsedError);
    // Pruning registers it before the row goes.
    await pruneAiRuns(db, { maxAgeMs: 0 });
    expect(await runRows(db, 'old-core-run')).toEqual([]);
    expect(await registered(db)).toContain(await digestOf('old-core-run'));
    await expect(
      openAiRun(store(db, 'tenant-two'), { id: 'old-core-run', type: 'turn' }),
    ).rejects.toBeInstanceOf(AiRunIdUsedError);
  });

  it('an open racing a prune of a run without a registry row is refused', async () => {
    const db = await newAiRunTestDatabase(engine);
    await db.query(
      `INSERT INTO _smrt_ai_runs (id, type, tenant_id, status, budget,
         started_at, created_at, finished_at, trajectory_pruned)
       VALUES ('old-core-race', 'turn', 'tenant-one', 'done', '{}',
         '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z',
         '2000-01-01T00:00:00.000Z', 1)`,
    );
    // The prune's statements (registry key first, then the row) land after
    // the open's registry check, before its run-row check: the open's own
    // registry insert then meets the key the prune wrote. One handle: the
    // interleaving variant; the PostgreSQL lane races two connections.
    const digest = await digestOf('old-core-race');
    const restore = beforeStatement(
      db,
      (sql) => sql.startsWith('SELECT 1 AS used FROM _smrt_ai_runs'),
      async (exec) => {
        await exec(
          `INSERT INTO _smrt_ai_run_ids (id_digest, created_at) VALUES ($1, $2)
           ON CONFLICT (id_digest) DO NOTHING`,
          digest,
          new Date().toISOString(),
        );
        await exec("DELETE FROM _smrt_ai_runs WHERE id = 'old-core-race'");
      },
    );
    await expect(
      openAiRun(store(db, 'tenant-two'), { id: 'old-core-race', type: 'turn' }),
    ).rejects.toBeInstanceOf(AiRunIdUsedError);
    restore();
    // The interleaved statements ran in the refused open's transaction and
    // rolled back with it; nothing was opened for tenant-two.
    expect(
      (await runRows(db, 'old-core-race')).map((row) => row.tenant_id),
    ).toEqual(['tenant-one']);
  });

  it('stores the digest of the id, never the id', async () => {
    const db = await newAiRunTestDatabase(engine);
    await openAiRun(store(db), { id: 'import:private text', type: 'turn' });
    const rows = rowsOf(await db.query('SELECT * FROM _smrt_ai_run_ids'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id_digest).toBe(await digestOf('import:private text'));
    expect(JSON.stringify(rows)).not.toContain('private text');
  });

  it('SQL and TypeScript digests agree', async () => {
    if (engine === 'sqlite') return; // SQLite hashes in TypeScript only.
    const db = await newAiRunTestDatabase(engine);
    for (const id of ['plain', 'café', '\u{1F600}', ' sp ace ', '']) {
      const sql =
        engine === 'duckdb'
          ? 'SELECT sha256($1) AS d'
          : "SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS d";
      const row = rowsOf(await db.query(sql, id))[0];
      expect(String(row?.d)).toBe(await digestOf(id));
    }
  });

  it('opens fail closed as not found for a parent that was pruned', async () => {
    const db = await newAiRunTestDatabase(engine);
    const parent = await openAiRun(store(db), { type: 'turn' });
    await pruneRunNow(db, parent.id);
    await expect(
      openAiRun(store(db), { type: 'turn', parentRunId: parent.id }),
    ).rejects.toBeInstanceOf(AiRunNotFoundError);
  });
});
