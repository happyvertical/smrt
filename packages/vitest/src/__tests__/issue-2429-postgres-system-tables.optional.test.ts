/**
 * PostgreSQL isolated-test system bootstrap contract for issue #2429.
 *
 * Transaction handles intentionally bypass SmrtClass's connection bootstrap.
 * The isolated factory therefore has to provision every framework-owned
 * system table on the base connection before opening the transaction.
 */

import { randomUUID } from 'node:crypto';
import { createDispatchBus, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { createIsolatedTestDb } from '../test-db.js';

const postgresDescribe = process.env.SMRT_TEST_POSTGRES_URL
  ? describe.sequential
  : describe.skip;

const tableSuffix = randomUUID().replaceAll('-', '').slice(0, 12);
const tableName = `issue_2429_widget_${tableSuffix}`;

class Issue2429Widget extends SmrtObject {
  name: string = '';
}
smrt({ tableName })(Issue2429Widget);

postgresDescribe('PostgreSQL isolated system-table bootstrap (#2429)', () => {
  it('keeps context and embedding cascade cleanup transaction-safe', async () => {
    const result = await createIsolatedTestDb({
      schema: `CREATE TABLE "${tableName}" (
        id UUID PRIMARY KEY NOT NULL,
        slug TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        name TEXT,
        UNIQUE (slug, context)
      )`,
      prefix: 'issue-2429-cascade',
    });

    try {
      const tableResult = await result.db.query(
        `SELECT to_regclass('_smrt_contexts') AS contexts,
                to_regclass('_smrt_embeddings') AS embeddings`,
      );
      const tableRows = Array.isArray(tableResult)
        ? tableResult
        : ((
            tableResult as {
              rows?: Array<{
                contexts: string | null;
                embeddings: string | null;
              }>;
            }
          ).rows ?? []);
      expect(tableRows[0]).toEqual({
        contexts: '_smrt_contexts',
        embeddings: '_smrt_embeddings',
      });

      const widget = new Issue2429Widget({ db: result.db, name: 'cascade' });
      await widget.initialize();
      await widget.save();

      await result.db.insert('_smrt_contexts', {
        id: randomUUID(),
        owner_class: 'Issue2429Widget',
        owner_id: widget.id,
        scope: 'test',
        key: 'context',
        value: '{}',
      });
      await result.db.insert('_smrt_embeddings', {
        id: randomUUID(),
        object_class: 'Issue2429Widget',
        object_id: widget.id,
        field_name: 'name',
        content_hash: 'issue-2429',
        embedding: '[]',
        model: 'test',
        dimensions: 0,
      });

      await expect(widget.delete()).resolves.toBeUndefined();
      expect(
        await result.db.count('_smrt_contexts', { owner_id: widget.id }),
      ).toBe(0);
      expect(
        await result.db.count('_smrt_embeddings', { object_id: widget.id }),
      ).toBe(0);
      await expect(
        result.db.query('SELECT 1 AS transaction_ok'),
      ).resolves.toBeDefined();
    } finally {
      try {
        if (result.db.isActive()) await result.db.rollback();
        await result.baseDb.query(`DROP TABLE IF EXISTS "${tableName}"`);
      } finally {
        await result.cleanup();
      }
    }
  });

  it('initializes dispatch without poisoning the isolated transaction', async () => {
    const result = await createIsolatedTestDb({
      prefix: 'issue-2429-dispatch',
    });

    try {
      const bus = await createDispatchBus({ db: result.db });
      const dispatch = await bus.emit(
        'issue-2429.transaction-probe',
        { ready: true },
        { source: 'smrt-vitest' },
      );
      expect(await result.db.count('_smrt_dispatch', { id: dispatch.id })).toBe(
        1,
      );
      await expect(
        result.db.query('SELECT 1 AS transaction_ok'),
      ).resolves.toBeDefined();
    } finally {
      await result.cleanup();
    }
  });
});
