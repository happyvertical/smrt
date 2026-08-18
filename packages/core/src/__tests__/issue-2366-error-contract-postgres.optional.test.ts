/**
 * PostgreSQL proof of the save()/load error contract (#2366).
 *
 * Runs only in the dedicated disposable PostgreSQL shard. SQLite cannot prove
 * the two failures that motivated the issue:
 *
 * - `25P02 in_failed_sql_transaction` only exists on PostgreSQL. Inside a
 *   caller-managed transaction the old retry loop ran attempts 2–4 on the
 *   already-aborted client, so the caller received "current transaction is
 *   aborted" instead of the constraint that actually failed. Consumers had to
 *   write their own aborted-transaction heuristics to recover the real cause.
 * - `22P02 invalid_text_representation` only fires where `id` is a native
 *   `uuid` column; SQLite stores it as text and accepts any string, so a
 *   malformed identifier never reaches the driver as an error at all.
 *
 * Everything here goes through the real model layer against a real database —
 * no adapter is stubbed.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { DatabaseError, ValidationError } from '../errors.js';
import { GlobalInterceptors } from '../interceptors.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TABLE = 'issue_2366_contract_widgets';

@smrt({
  tableName: 'issue_2366_contract_widgets',
  conflictColumns: ['sku'],
})
class Issue2366Widget extends SmrtObject {
  /** Conflict target: an upsert resolves against this, it never violates. */
  @field({ required: true })
  sku: string = '';

  /**
   * A *secondary* unique key. Because it is not the conflict target, an upsert
   * that collides here takes the INSERT branch and raises a real 23505 from
   * inside `db.upsert()` — the wrapped path where the adapter replaces the
   * driver message with "Failed to upsert record into table". That is the
   * exact shape the old `error.message` matcher could not see.
   */
  @field({ required: true })
  tag: string = '';

  @field({ required: true })
  label: string = '';
}

class Issue2366WidgetCollection extends SmrtCollection<Issue2366Widget> {
  static readonly _itemClass = Issue2366Widget;
}

describe.skipIf(!pgUrl)(
  'save()/load error contract on PostgreSQL (#2366)',
  () => {
    let db: DatabaseInterface;
    let collection: Issue2366WidgetCollection;

    beforeAll(async () => {
      db = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-2366-${randomUUID()}`,
        max: 4,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;

      await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
      // Build the table from the framework's own PostgreSQL schema so every
      // column the model writes exists and `id` keeps its native `uuid` type
      // (the precondition for 22P02 on a malformed identifier).
      const registration =
        ObjectRegistry.getClassByConstructor(Issue2366Widget);
      const className =
        registration?.qualifiedName ||
        registration?.name ||
        Issue2366Widget.name;
      const ddl = ObjectRegistry.getSchemaDDL(className, 'postgres');
      if (!ddl) throw new Error(`Missing schema DDL for ${className}`);
      await db.query(ddl);

      // Assert the two constraints this suite depends on, independently of what
      // the generator chose to emit for `required: true` (#2366 is about the
      // error contract, not about index/constraint emission — that is #2359).
      await db.query(`ALTER TABLE "${TABLE}" ALTER COLUMN label SET NOT NULL`);
      // The conflict target needs a matching unique index or PostgreSQL rejects
      // every upsert with 42P10 before any of these paths are reached. The
      // manifest schema path not emitting it is epic #2382's finding A4, tracked
      // separately as #2359/#2360 — out of scope here.
      await db.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${TABLE}_sku_uq" ON "${TABLE}" (sku)`,
      );
      await db.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${TABLE}_tag_uq" ON "${TABLE}" (tag)`,
      );
    }, 30_000);

    afterAll(async () => {
      if (!db) return;
      try {
        await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
      } finally {
        await db.close?.();
        ObjectRegistry.clear();
      }
    });

    beforeEach(async () => {
      GlobalInterceptors.clear();
      await db.query(`TRUNCATE "${TABLE}"`);
      collection = await Issue2366WidgetCollection.create({ db });
    });

    it('raises a typed unique ValidationError with no retry backoff', async () => {
      await collection.create({ sku: 'pg-a', tag: 'dup', label: 'first' });

      const started = Date.now();
      const error = await collection
        .create({ sku: 'pg-b', tag: 'dup', label: 'second' })
        .then(
          () => null,
          (thrown) => thrown,
        );
      const elapsed = Date.now() - started;

      expect(error).toBeInstanceOf(ValidationError);
      expect(error.code).toBe('VALIDATION_UNIQUE_CONSTRAINT');
      expect(error.details?.fieldName).toBe('tag');
      // The probe in the issue measured 3509 ms here (500 + 1000 + 2000 backoff
      // plus four round trips). The acceptance bound is 50 ms; 1000 ms leaves
      // room for a loaded shared runner while still failing loudly if the
      // backoff ever returns.
      expect(elapsed).toBeLessThan(1000);
    });

    it('raises a typed unique ValidationError on the strict-insert path too', async () => {
      // `_insertOnly` bypasses conflict resolution, so the collision lands on the
      // primary key. `TenantIntegrationCollection.findOrInit` depends on this
      // shape to detect the losing side of a race.
      const id = randomUUID();
      await collection.create({
        id,
        sku: 'pg-ins-a',
        tag: 'ins-a',
        label: 'first',
        _insertOnly: true,
      });

      const error = await collection
        .create({
          id,
          sku: 'pg-ins-b',
          tag: 'ins-b',
          label: 'second',
          _insertOnly: true,
        })
        .then(
          () => null,
          (thrown) => thrown,
        );

      expect(error).toBeInstanceOf(ValidationError);
      expect(error.code).toBe('VALIDATION_UNIQUE_CONSTRAINT');
      expect(error.details?.fieldName).toBe('id');
    });

    it('raises a typed required-field ValidationError on 23502', async () => {
      // The interceptor runs after validateBeforeSave(), so the NULL reaches
      // PostgreSQL and comes back as a genuine 23502 rather than a model-level
      // validation short-circuit.
      GlobalInterceptors.register({
        name: 'issue-2366-null-label',
        beforeSave(instance: unknown) {
          (instance as { label: string | null }).label = null;
        },
      });

      const error = await collection
        .create({ sku: 'pg-null', tag: 'null-tag', label: 'set' })
        .then(
          () => null,
          (thrown) => thrown,
        );

      expect(error).toBeInstanceOf(ValidationError);
      expect(error.code).toBe('VALIDATION_REQUIRED_FIELD');
      expect(error.details?.fieldName).toBe('label');
    });

    it('preserves the original constraint inside a caller-managed transaction', async () => {
      // The acceptance criterion: attempts 2-4 used to run on the aborted client,
      // so the caller received `25P02 current transaction is aborted` instead of
      // the unique violation that actually failed.
      await collection.create({ sku: 'tx-a', tag: 'tx-dup', label: 'first' });

      const error = await db
        .transaction(async (tx: DatabaseInterface) => {
          const txCollection = await Issue2366WidgetCollection.create({
            db: tx,
          });
          await txCollection.create({
            sku: 'tx-b',
            tag: 'tx-dup',
            label: 'second',
          });
        })
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );

      expect(error).not.toBeNull();
      const text = `${(error as Error).message} ${JSON.stringify(
        (error as { details?: unknown }).details ?? {},
      )}`;
      // The failure the caller sees must still be the unique violation.
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe(
        'VALIDATION_UNIQUE_CONSTRAINT',
      );
      // And it must NOT have been replaced by the aborted-transaction symptom.
      expect(text).not.toMatch(/current transaction is aborted/i);
      expect(text).not.toContain('25P02');
    });

    it('fails fast on a malformed uuid instead of retrying the same literal', async () => {
      const widget = new Issue2366Widget({
        db,
        sku: 'pg-bad-uuid',
        tag: 'pg-bad-uuid',
        label: 'x',
        _skipLoad: true,
      });
      await widget.initialize();
      widget._id = 'definitely-not-a-uuid';

      const started = Date.now();
      const error = await widget.loadFromId().then(
        () => null,
        (thrown) => thrown,
      );
      const elapsed = Date.now() - started;

      expect(error).toBeInstanceOf(DatabaseError);
      // Was 3 attempts at 250 ms backoff for a literal that can never parse.
      expect(elapsed).toBeLessThan(1000);
    });
  },
);
