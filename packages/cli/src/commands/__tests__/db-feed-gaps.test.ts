/**
 * `smrt db:feed-gaps status` (#5438): reports change-feed gap markers in
 * every state, and gap rows in the feed with and without evidence, using
 * SELECT statements only. Sensitive tables are omitted and no lost row id or
 * tenant is printed. PGlite.
 */
import { PGlite } from '@electric-sql/pglite';
import { ensureSystemTables } from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dbFeedGapsCommand,
  formatFeedGapStatus,
  readFeedGapStatus,
} from '../db-feed-gaps.js';

const SETTING = '@happyvertical/smrt-core:change-feed-gap-delivery:v1';

describe('db:feed-gaps status (#5438, PGlite)', () => {
  let client: PGlite;
  let db: DatabaseInterface;

  beforeEach(async () => {
    client = new PGlite();
    db = await getDatabase({ type: 'pglite', client });
    await ensureSystemTables(db, 'postgres');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await client.close();
  });

  async function marker(fields: string, values: string): Promise<void> {
    await db.query(
      `INSERT INTO _smrt_change_gaps (table_name, row_id, tenant_key, created_at${fields})
       VALUES ('notes', 'secret-row-id', 'secret-tenant', now()${values})`,
    );
  }

  it('counts every lifecycle state with SELECT statements only, and exits zero with delivery off', async () => {
    await marker('', '');
    await marker(', blocked_at', ', now()');
    await marker(', reconciled_at', ', now()');
    await db.query(
      `INSERT INTO _smrt_changes (seq, table_name, row_id, operation, created_at)
       VALUES (1, 'notes', 'a', 'create', now()), (2, 'notes', NULL, 'gap', now()),
              (3, 'notes', NULL, 'gap', now())`,
    );
    // Evidence for the gap at 2; the one at 3 lost its evidence by hand.
    await marker(', converted_seq', ', 2');
    await db.query(
      `INSERT INTO _smrt_change_gaps (table_name, created_at) VALUES ('sessions', now())`,
    );

    const spy = vi.spyOn(db, 'query');
    const status = await readFeedGapStatus(db, ['sessions']);
    expect(status).toEqual({
      available: true,
      deliveryEnabled: false,
      unconverted: 2,
      blocked: 1,
      reconciled: 1,
      positioned: 2,
      positionedWithoutEvidence: 1,
      lastPositionedSeq: 3,
      tables: [{ table: 'notes', unconverted: 2, blocked: 1 }],
    });
    for (const call of spy.mock.calls) {
      expect(String(call[0]).trim()).toMatch(/^SELECT\b/i);
    }
    const text = formatFeedGapStatus(status);
    expect(text).not.toContain('secret-row-id');
    expect(text).not.toContain('secret-tenant');
    expect(text).not.toContain('sessions');
    expect(text).toContain('off');
  });

  it('works for a role that may only read', async () => {
    await marker('', '');
    await db.query('CREATE ROLE feed_gaps_reader NOSUPERUSER');
    await db.query('GRANT USAGE ON SCHEMA public TO feed_gaps_reader');
    await db.query(
      'GRANT SELECT ON _smrt_change_gaps, _smrt_changes, _smrt_backfills TO feed_gaps_reader',
    );
    await db.query('SET ROLE feed_gaps_reader');
    try {
      const status = await readFeedGapStatus(db, []);
      expect(status.unconverted).toBe(1);
    } finally {
      await db.query('RESET ROLE');
    }
  });

  it('reports delivery when the setting is present', async () => {
    await db.query('INSERT INTO _smrt_backfills (name) VALUES ($1)', SETTING);
    expect((await readFeedGapStatus(db, [])).deliveryEnabled).toBe(true);
  });

  it('reports an absent table without failing', async () => {
    await db.query('DROP TABLE _smrt_change_gaps');
    const status = await readFeedGapStatus(db, []);
    expect(status.available).toBe(false);
  });

  it('offers status only: no enable action exists in this release', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previous = process.exitCode;
    try {
      await dbFeedGapsCommand.handler?.(['enable'], {} as never);
      expect(process.exitCode).toBe(1);
      expect(String(error.mock.calls[0]?.[0])).toContain('Available: status');
    } finally {
      process.exitCode = previous;
    }
  });
});
