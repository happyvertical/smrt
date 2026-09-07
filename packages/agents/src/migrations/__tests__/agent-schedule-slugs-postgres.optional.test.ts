import { randomUUID } from 'node:crypto';
import { BackfillTracker } from '@happyvertical/smrt-core/migrations';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_SCHEDULE_SLUG_BACKFILL,
  AgentScheduleSlugBackfillError,
  migrateAgentScheduleSlugs,
  planAgentScheduleSlugMigration,
} from '../agent-schedule-slugs.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = pgUrl ? describe.sequential : describe.skip;
const table = '_smrt_agent_schedules';

postgresDescribe('legacy AgentSchedule slug migration (#2738)', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;

  beforeAll(async () => {
    db = await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-2738-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0]);
  });

  afterEach(async () => {
    await db.query(`DROP TABLE IF EXISTS "${table}"`);
    await db.query(
      'DELETE FROM _smrt_backfills WHERE name = ?',
      AGENT_SCHEDULE_SLUG_BACKFILL,
    );
  });

  afterAll(async () => {
    await db.close?.();
  });

  async function legacyTable(extra = '') {
    await db.query(`
      CREATE TABLE "${table}" (
        id TEXT PRIMARY KEY,
        slug TEXT,
        context TEXT NOT NULL DEFAULT '',
        tenant_id TEXT,
        agent_type TEXT,
        cron TEXT,
        enabled BOOLEAN,
        status TEXT,
        run_count INTEGER,
        payload TEXT
        ${extra}
      )
    `);
    await db.query(
      `CREATE UNIQUE INDEX "${table}_tenant_slug_context_idx" ON "${table}" (tenant_id, slug, context)`,
    );
  }

  it('backfills partial nullable shape once, preserves schedule state, and enforces NOT NULL', async () => {
    await legacyTable();
    await db.query(
      `INSERT INTO "${table}" (id, slug, context, agent_type, cron, enabled, status, run_count, payload)
       VALUES (?, NULL, '', 'Agent', '0 * * * *', true, 'paused', 7, '{"preserve":true}'),
              (?, 'custom legacy value', 'ops', 'Agent', '1 * * * *', false, 'disabled', 2, '{"preserve":false}'),
              (?, ' ', '', 'Agent', '2 * * * *', false, 'disabled', 3, '{"preserve":"whitespace"}')`,
      'Schedule Alpha!',
      'existing-id',
      'whitespace-id',
    );

    await expect(planAgentScheduleSlugMigration(db)).resolves.toEqual({
      pending: 1,
    });
    await expect(
      migrateAgentScheduleSlugs(db, { lockTimeout: 0, statementTimeout: 0 }),
    ).resolves.toEqual({
      ran: true,
      updated: 1,
    });
    expect(
      (
        await db.query(
          `SELECT id, slug, context, agent_type, cron, enabled, status, run_count, payload FROM "${table}" ORDER BY id`,
        )
      ).rows,
    ).toEqual([
      {
        id: 'existing-id',
        slug: 'custom legacy value',
        context: 'ops',
        agent_type: 'Agent',
        cron: '1 * * * *',
        enabled: false,
        status: 'disabled',
        run_count: 2,
        payload: '{"preserve":false}',
      },
      {
        id: 'Schedule Alpha!',
        slug: 'schedule-alpha',
        context: '',
        agent_type: 'Agent',
        cron: '0 * * * *',
        enabled: true,
        status: 'paused',
        run_count: 7,
        payload: '{"preserve":true}',
      },
      {
        id: 'whitespace-id',
        slug: ' ',
        context: '',
        agent_type: 'Agent',
        cron: '2 * * * *',
        enabled: false,
        status: 'disabled',
        run_count: 3,
        payload: '{"preserve":"whitespace"}',
      },
    ]);
    const column = await db.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ? AND column_name = 'slug'`,
      table,
    );
    expect(column.rows[0]?.is_nullable).toBe('NO');
    expect(
      await new BackfillTracker({ db }).isApplied(AGENT_SCHEDULE_SLUG_BACKFILL),
    ).toBe(true);
    await expect(migrateAgentScheduleSlugs(db)).resolves.toEqual({
      ran: false,
      updated: 0,
    });

    // A consumer can continue creating schedules after the contract is
    // enforced, provided it supplies the inherited identity fields.
    await expect(
      db.query(
        `INSERT INTO "${table}" (id, slug, agent_type, cron, enabled, status, run_count, payload)
         VALUES (?, ?, 'Agent', '*/5 * * * *', false, 'pending', 0, '{"new":true}')`,
        'source-derived-schedule-id',
        'source-derived-schedule-id',
      ),
    ).resolves.toBeDefined();
    expect(
      (
        await db.query(
          `SELECT slug, context, enabled, status FROM "${table}" WHERE id = ?`,
          'source-derived-schedule-id',
        )
      ).rows,
    ).toEqual([
      {
        slug: 'source-derived-schedule-id',
        context: '',
        enabled: false,
        status: 'pending',
      },
    ]);
  });

  it('allows the same canonical slug in separate tenants, but rejects collisions within one tenant or the global scope', async () => {
    await legacyTable();
    await db.query(
      `INSERT INTO "${table}" (id, slug, tenant_id) VALUES (?, NULL, ?), (?, NULL, ?)`,
      'shared schedule!',
      'tenant-a',
      'shared-schedule',
      'tenant-b',
    );
    await expect(migrateAgentScheduleSlugs(db)).resolves.toEqual({
      ran: true,
      updated: 2,
    });
    expect(
      (
        await db.query(
          `SELECT tenant_id, slug FROM "${table}" ORDER BY tenant_id`,
        )
      ).rows,
    ).toEqual([
      { tenant_id: 'tenant-a', slug: 'shared-schedule' },
      { tenant_id: 'tenant-b', slug: 'shared-schedule' },
    ]);

    await db.query(`DROP TABLE "${table}"`);
    await legacyTable();
    await db.query(
      `INSERT INTO "${table}" (id, slug, tenant_id) VALUES (?, NULL, ?), (?, NULL, ?)`,
      'same schedule!',
      'tenant-a',
      'same-schedule',
      'tenant-a',
    );
    await expect(planAgentScheduleSlugMigration(db)).rejects.toBeInstanceOf(
      AgentScheduleSlugBackfillError,
    );

    await db.query(`DROP TABLE "${table}"`);
    await legacyTable();
    // PostgreSQL permits several NULL values in a unique index. The framework
    // treats NULL tenant_id as one global scope, so reject this before writes.
    await db.query(
      `INSERT INTO "${table}" (id, slug, tenant_id) VALUES (?, NULL, NULL), (?, NULL, NULL)`,
      'global schedule!',
      'global-schedule',
    );
    await expect(planAgentScheduleSlugMigration(db)).rejects.toBeInstanceOf(
      AgentScheduleSlugBackfillError,
    );
  });

  it('fails closed on normalized collisions without touching data or marker', async () => {
    await legacyTable();
    await db.query(
      `INSERT INTO "${table}" (id, slug) VALUES (?, NULL), (?, NULL)`,
      'same value!',
      'same-value',
    );
    await expect(migrateAgentScheduleSlugs(db)).rejects.toBeInstanceOf(
      AgentScheduleSlugBackfillError,
    );
    expect(
      (await db.query(`SELECT slug FROM "${table}" ORDER BY id`)).rows,
    ).toEqual([{ slug: null }, { slug: null }]);
    expect(
      await new BackfillTracker({ db }).isApplied(AGENT_SCHEDULE_SLUG_BACKFILL),
    ).toBe(false);
  });

  it('rolls back a failing write and never records a partial success marker', async () => {
    await legacyTable(
      ", CONSTRAINT reject_bad_slug CHECK (slug IS NULL OR slug <> 'bad')",
    );
    await db.query(`INSERT INTO "${table}" (id, slug) VALUES ('bad!', NULL)`);
    await expect(migrateAgentScheduleSlugs(db)).rejects.toThrow();
    expect((await db.query(`SELECT slug FROM "${table}"`)).rows).toEqual([
      { slug: null },
    ]);
    expect(
      await new BackfillTracker({ db }).isApplied(AGENT_SCHEDULE_SLUG_BACKFILL),
    ).toBe(false);
  });

  it('rejects missing slug shape and malformed identities without inferring values', async () => {
    await db.query(
      `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, context TEXT NOT NULL DEFAULT '')`,
    );
    await expect(planAgentScheduleSlugMigration(db)).rejects.toBeInstanceOf(
      AgentScheduleSlugBackfillError,
    );
    await db.query(`DROP TABLE "${table}"`);
    await legacyTable();
    await db.query(`INSERT INTO "${table}" (id, slug) VALUES ('!!!', NULL)`);
    await expect(migrateAgentScheduleSlugs(db)).rejects.toBeInstanceOf(
      AgentScheduleSlugBackfillError,
    );
  });
});
