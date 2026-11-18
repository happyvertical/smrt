/**
 * Control keys in create data keep their meaning.
 *
 * `collection.create()` takes its services (database, AI client, ...) from the
 * collection and never from the data, but the control keys a programmatic
 * caller passes in that data are unchanged: `_insertOnly` still refuses a row
 * whose natural key exists, an explicit `id` is still the row's id, and
 * `_skipLoad` still reaches the instance. Shared by the SQLite suite and the
 * PostgreSQL suite.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { ValidationError } from '../errors.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

export const CREATE_FLAG_TABLE = 'create_control_flag_parts';

// The scanner reads this config statically, so the table name is a literal.
@smrt({ tableName: 'create_control_flag_parts', conflictColumns: ['sku'] })
export class CreateControlFlagPart extends SmrtObject {
  /** The natural key: a second row with the same value is a collision. */
  @field({ required: true })
  sku: string = '';

  @field()
  label: string = '';
}

export class CreateControlFlagPartCollection extends SmrtCollection<CreateControlFlagPart> {
  static readonly _itemClass = CreateControlFlagPart;
}

interface Opened {
  db: DatabaseInterface;
  close: () => Promise<void>;
}

export function createControlFlagSuite(
  adapter: string,
  open: () => Promise<Opened>,
): void {
  describe(`control keys in create data on ${adapter}`, () => {
    let opened: Opened;
    let db: DatabaseInterface;
    let parts: CreateControlFlagPartCollection;

    const labelsBySku = async (sku: string): Promise<string[]> => {
      const result = await db.query(
        `SELECT label FROM ${CREATE_FLAG_TABLE} WHERE sku = $1 ORDER BY label`,
        [sku],
      );
      return result.rows.map((row: Record<string, unknown>) =>
        String(row.label),
      );
    };

    beforeAll(async () => {
      ObjectRegistry.registerCollection(
        'CreateControlFlagPart',
        CreateControlFlagPartCollection,
      );
      opened = await open();
      db = opened.db;
      parts = await CreateControlFlagPartCollection.create({ db });
    }, 60_000);

    beforeEach(async () => {
      await db.query(`DELETE FROM ${CREATE_FLAG_TABLE}`);
    });

    afterAll(async () => {
      await opened?.close();
    });

    it('_insertOnly refuses a row whose natural key already exists', async () => {
      await parts.create({ sku: 'kept', label: 'first' });

      const error = await parts
        .create({ sku: 'kept', label: 'second', _insertOnly: true })
        .then(
          () => null,
          (thrown) => thrown,
        );

      expect(error).toBeInstanceOf(ValidationError);
      expect(error.code).toBe('VALIDATION_UNIQUE_CONSTRAINT');
      expect(await labelsBySku('kept')).toEqual(['first']);
    });

    it('without _insertOnly the same create updates the existing row in place', async () => {
      await parts.create({ sku: 'kept', label: 'first' });
      await parts.create({ sku: 'kept', label: 'second' });
      expect(await labelsBySku('kept')).toEqual(['second']);
    });

    it('_insertOnly still refuses when the data also carries service option keys', async () => {
      await parts.create({ sku: 'kept', label: 'first' });

      const error = await parts
        .create({
          sku: 'kept',
          label: 'second',
          _insertOnly: true,
          db: { type: 'sqlite', url: ':memory:' },
          ai: { baseUrl: 'http://127.0.0.1:9/v1' },
          persistence: ':memory:',
        } as never)
        .then(
          () => null,
          (thrown) => thrown,
        );

      expect(error).toBeInstanceOf(ValidationError);
      expect(error.code).toBe('VALIDATION_UNIQUE_CONSTRAINT');
      expect(await labelsBySku('kept')).toEqual(['first']);
    });

    it('_insertOnly refuses a repeated explicit id and keeps the first row', async () => {
      const id = crypto.randomUUID();
      const first = await parts.create({
        id,
        sku: 'first-sku',
        label: 'first',
        _insertOnly: true,
      });
      expect(first.id).toBe(id);

      await expect(
        parts.create({
          id,
          sku: 'second-sku',
          label: 'second',
          _insertOnly: true,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_UNIQUE_CONSTRAINT' });
      expect(await labelsBySku('first-sku')).toEqual(['first']);
      expect(await labelsBySku('second-sku')).toEqual([]);
    });

    it('createMany applies _insertOnly to each input', async () => {
      await parts.createMany([
        { sku: 'batch-a', label: 'first', _insertOnly: true },
        { sku: 'batch-b', label: 'first', _insertOnly: true },
      ]);
      await expect(
        parts.createMany([
          { sku: 'batch-c', label: 'second', _insertOnly: true },
          { sku: 'batch-a', label: 'second', _insertOnly: true },
        ]),
      ).rejects.toMatchObject({ code: 'VALIDATION_UNIQUE_CONSTRAINT' });
      expect(await labelsBySku('batch-a')).toEqual(['first']);
      // All or nothing: the batch that collided left no row behind.
      expect(await labelsBySku('batch-c')).toEqual([]);
    });

    it('an explicit id and _skipLoad in the data reach the new instance', async () => {
      const id = crypto.randomUUID();
      const created = await parts.create({
        id,
        sku: 'explicit-id',
        label: 'first',
        _skipLoad: false,
      });
      expect(created.id).toBe(id);
      expect(created.options._skipLoad).toBe(false);
      expect(created.db).toBe(parts.db);

      const defaulted = await parts.create({ sku: 'default-flags' });
      expect(defaulted.options._skipLoad).toBe(true);
    });
  });
}
