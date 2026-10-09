import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import { expect, it, vi } from 'vitest';
import { McpTaskStore } from '../mcp-task.js';
import { SmrtJobCollection } from '../smrt-job.js';

it('production ready index excludes suspended backlog and follows wake/cancel/claim', async () => {
  const { db, cleanup } = await createIsolatedTestDbFromManifest({
    manifestPath: fileURLToPath(
      new URL('../../dist/manifest.json', import.meta.url),
    ),
    includeObjects: ['SmrtJob', 'SmrtJobEvent'],
  });
  const postgres = Boolean(process.env.SMRT_TEST_POSTGRES_URL);
  const ownerId = randomUUID();
  const binding = { recordId: 'review', revision: 'v1', inputKey: 'answer' };
  try {
    const catalog = await db.query(
      postgres
        ? "SELECT indexname AS name, indexdef AS sql FROM pg_indexes WHERE schemaname = current_schema() AND tablename = '_smrt_jobs'"
        : "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = '_smrt_jobs'",
    );
    expect(
      catalog.rows.some((row) => row.name === '_smrt_jobs_status_run_at_idx'),
    ).toBe(true);
    const index = catalog.rows.find(
      (row) => row.name === '_smrt_jobs_ready_idx',
    );
    expect(index).toBeDefined();
    expect(String(index?.sql)).toContain('task_input_requests IS NULL');
    expect(String(index?.sql)).toContain('task_input_responses IS NOT NULL');
    const tasks = Array.from({ length: 2002 }, () => randomUUID());
    const args = JSON.stringify({
      _mcpTask: {
        continuation: binding,
        invocationArgs: [],
        pollIntervalMs: 250,
        ttlMs: 86400000,
      },
    });
    for (let offset = 0; offset < tasks.length; offset += 100) {
      const slice = tasks.slice(offset, offset + 100);
      const params = slice.flatMap((taskId, at) => [
        randomUUID(),
        taskId,
        'probe',
        'review',
        '2020-01-01T00:00:00.000Z',
        taskId,
        ownerId,
        args,
        offset + at < 2000
          ? JSON.stringify({ answer: { type: 'string' } })
          : null,
      ]);
      await db.query(
        `INSERT INTO _smrt_jobs (id, slug, object_type, method, run_at, task_id, task_owner_id, args, task_input_requests) VALUES ${slice.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        ...params,
      );
    }
    await db.query('ANALYZE _smrt_jobs');
    const jobs = await SmrtJobCollection.create({ db });
    const queries = vi.spyOn(jobs, 'query');
    const ready = await jobs.listReady({ limit: 10 });
    expect(ready.map((job) => job.taskId).sort()).toEqual(
      tasks.slice(2000).sort(),
    );
    const [listSql, listParams] = queries.mock.calls[0];
    const explain = postgres ? 'EXPLAIN (FORMAT JSON) ' : 'EXPLAIN QUERY PLAN ';
    const listPlan = await db.query(explain + listSql, ...(listParams ?? []));
    expect(JSON.stringify(listPlan.rows)).toContain('_smrt_jobs_ready_idx');
    const store = await McpTaskStore.create(db, { ownerId });
    await store.updateTask(tasks[0], { answer: 'wake' });
    await store.cancelTask(tasks[1]);
    queries.mockClear();
    const claimed = await jobs.claimReady({
      workerId: 'index-probe',
      limit: 10,
    });
    expect(claimed.map((job) => job.taskId).sort()).toEqual(
      [tasks[0], ...tasks.slice(2000)].sort(),
    );
    const [claimSql, claimParams] = queries.mock.calls[0];
    const claimPlan = await db.query(
      explain + claimSql,
      ...(claimParams ?? []),
    );
    expect(JSON.stringify(claimPlan.rows)).toContain('_smrt_jobs_ready_idx');
    process.stdout.write(
      `${JSON.stringify({ postgres, list: listPlan.rows, claim: claimPlan.rows })}\n`,
    );
    expect((await store.getTask(tasks[1])).status).toBe('cancelled');
    expect(await jobs.listReady()).toHaveLength(0);
    queries.mockRestore();
  } finally {
    await cleanup();
  }
});
