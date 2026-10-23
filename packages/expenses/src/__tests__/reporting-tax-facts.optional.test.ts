import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { disableTenancy } from '@happyvertical/smrt-tenancy';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe } from 'vitest';
import { defineReviewedTaxFactsSuite } from './helpers/reporting-tax-facts-suite.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('reporting tax facts on PostgreSQL (#3940)', () => {
  let admin: DatabaseInterface | undefined;
  let db: DatabaseInterface;
  let databaseName = '';

  beforeAll(async () => {
    const baseUrl = process.env.DATABASE_URL ?? '';
    admin = await getTestDatabase({
      type: 'postgres',
      url: baseUrl,
      classes: [],
      includeSystemTables: false,
    });
    databaseName = `smrt_expense_tax_facts_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(baseUrl);
    url.pathname = `/${databaseName}`;
    db = await getTestDatabase({ type: 'postgres', url: String(url) });
  });

  afterAll(async () => {
    disableTenancy();
    await (db as { close?: () => Promise<void> } | undefined)?.close?.();
    if (databaseName)
      await admin?.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await (admin as { close?: () => Promise<void> } | undefined)?.close?.();
  });

  defineReviewedTaxFactsSuite(() => db);
});
