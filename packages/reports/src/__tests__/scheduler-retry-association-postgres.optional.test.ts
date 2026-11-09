import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  proveReportScheduleRetry,
  reportAgentTableCases,
} from '../../test-support/report-schedule-retry.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;
describePostgres('real report schedule retry association (PostgreSQL)', () => {
  let admin: DatabaseInterface | undefined;
  let databaseName = '';
  let url = '';
  beforeEach(async () => {
    const baseUrl = process.env.DATABASE_URL ?? '';
    admin = await getTestDatabase({
      type: 'postgres',
      url: baseUrl,
      classes: [],
      includeSystemTables: false,
    });
    const role = (
      await admin.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      )
    ).rows[0];
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
    databaseName = `smrt_report_retry_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const target = new URL(baseUrl);
    target.pathname = `/${databaseName}`;
    url = target.toString();
  });
  afterEach(async () => {
    try {
      if (admin && databaseName)
        await admin.query(
          `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
        );
    } finally {
      await admin?.close?.();
      admin = undefined;
      databaseName = '';
    }
  });
  it.each(
    reportAgentTableCases,
  )('retries the actual report-produced job with agent table %s and keeps caller transaction usable', (agentTable) =>
    proveReportScheduleRetry('postgres', agentTable, url));
});
