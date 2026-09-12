import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject, type SmrtObjectOptions } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt()
class PersistenceNormalizationProbe extends SmrtObject {
  sourceText = '';
  derivedText = '';

  constructor(options: SmrtObjectOptions & { sourceText?: string } = {}) {
    super(options);
    this.sourceText = options.sourceText ?? '';
  }

  protected override transformJSON(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...super.transformJSON(data),
      sourceText: `serialized:${data.sourceText}`,
    };
  }

  protected override normalizePersistenceData(
    data: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    this.derivedText = String(data.source_text).toUpperCase();
    return {
      ...super.normalizePersistenceData(data),
      derived_text: this.derivedText,
    };
  }
}

for (const dialect of ['sqlite', 'duckdb', 'postgres'] as const) {
  const suite =
    dialect === 'postgres' && !process.env.SMRT_TEST_POSTGRES_URL
      ? describe.skip
      : describe.sequential;
  suite(`final persistence normalization (${dialect})`, () => {
    let db: DatabaseInterface;
    beforeEach(async () => {
      if (dialect === 'postgres') {
        const connection = await getDatabase({
          type: 'postgres',
          url: process.env.SMRT_TEST_POSTGRES_URL,
          dbid: `normalization-${randomUUID()}`,
        } as Parameters<typeof getDatabase>[0]);
        db = await getTestDatabase({
          db: connection,
          classes: ['PersistenceNormalizationProbe'],
        });
      } else {
        db = await getTestDatabase({
          type: dialect,
          url: ':memory:',
          classes: ['PersistenceNormalizationProbe'],
        });
      }
    });
    afterEach(async () => {
      await db?.close?.();
    });

    for (const insertOnly of [false, true]) {
      it(`merges returned derived columns into ${insertOnly ? 'strict insert' : 'upsert'} and subsequent update`, async () => {
        const instance = new PersistenceNormalizationProbe({
          db,
          sourceText: 'first',
        });
        await instance.initialize();
        if (insertOnly) instance.requireInsertOnSave();
        for (const source of ['first', 'second']) {
          instance.sourceText = source;
          await instance.save();
          const { rows } = await db.query(
            `SELECT source_text, derived_text FROM ${instance.tableName} WHERE id = ?`,
            instance.id,
          );
          expect(rows[0]).toEqual({
            source_text: `serialized:${source}`,
            derived_text: `SERIALIZED:${source.toUpperCase()}`,
          });
          expect(instance.toJSON()).toMatchObject({
            sourceText: rows[0].source_text,
            derivedText: rows[0].derived_text,
          });
        }
      });
    }
  });
}
