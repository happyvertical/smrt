/** Runs the shared agreement lifecycle contract against the embedded DuckDB adapter. */
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe } from 'vitest';
import { AgreementCollection } from '../collections/AgreementCollection.js';
import { agreementHistoryCases } from './agreement-history-cases.js';

describe('Agreement DuckDB history', () => {
  let db: DatabaseInterface;
  let agreements: AgreementCollection;
  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: ['Agreement'],
      omitForeignKeyConstraints: true,
    });
    agreements = await AgreementCollection.create({ db });
  });
  afterEach(async () => {
    await db?.close?.();
  });
  agreementHistoryCases(() => agreements);
});
