/**
 * `_smrt_principal_report_refresh_tasks` gained its inherited required columns
 * after 0.60.17 (#4945). On a populated table they need a declared data step,
 * or migrate stops on the existing rows (#4933 gate finding).
 */
import { getPendingSchemaStatements } from '@happyvertical/smrt-core/migrations';
import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { SmrtPrincipalReportRefreshTask } from '../scheduler.js';

describe('principal report refresh task upgrade (#4933)', () => {
  it('migrates a table saved by 0.60.17 that already holds a row', async () => {
    expect(SmrtPrincipalReportRefreshTask).toBeDefined();
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.execute`DROP TABLE IF EXISTS _smrt_principal_report_refresh_tasks`;
    await db.execute`CREATE TABLE _smrt_principal_report_refresh_tasks (
      id TEXT PRIMARY KEY NOT NULL,
      slug TEXT NOT NULL,
      name TEXT,
      tenant_id TEXT,
      created_at TEXT,
      updated_at TEXT
    )`;
    await db.execute`INSERT INTO _smrt_principal_report_refresh_tasks (id, slug) VALUES ('old-1', 'old-1')`;

    const pending = await getPendingSchemaStatements(db, {
      engineHint: 'sqlite',
    });
    const stops = pending.decision.stops.filter(
      (stop) => stop.change.table === '_smrt_principal_report_refresh_tasks',
    );
    expect(stops.map((stop) => stop.message)).toEqual([]);
  });
});
